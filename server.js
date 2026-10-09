// Airwave local HLS relay — Node.js 18+. Intended for localhost use only.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const INDEX = path.join(__dirname, 'index.html');
const MAX_PLAYLIST = 4 * 1024 * 1024;
const TIMEOUT = 20000;

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') ||
      x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') ||
      x.startsWith('feb') || x.startsWith('::ffff:127.');
  }
  return true;
}
async function validate(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Only credential-free HTTP(S) URLs are supported');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new Error('Local hosts are not allowed');
  if (net.isIP(host)) {
    if (privateIP(host)) throw new Error('Private IP targets are not allowed');
  } else {
    const ips = await dns.lookup(host, {all:true, verbatim:true});
    if (!ips.length || ips.some(x => privateIP(x.address)))
      throw new Error('Host resolves to a private/restricted address');
  }
  return u;
}
function upstream(raw, redirects=0) {
  return new Promise(async (resolve,reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let u;
    try { u = await validate(raw); } catch(e) { return reject(e); }
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(u, {
      timeout: TIMEOUT,
      headers: {'User-Agent':'AirwaveLocalRadio/1.0','Accept':'*/*','Icy-MetaData':'0'}
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        upstream(next, redirects+1).then(resolve,reject);
      } else resolve({res,url:u});
    });
    req.on('timeout',()=>req.destroy(new Error('Upstream request timed out')));
    req.on('error',reject);
  });
}
function send(res, code, type, body) {
  res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store','Access-Control-Allow-Origin':`http://${HOST}:${PORT}`,'X-Content-Type-Options':'nosniff'});
  res.end(body);
}
function proxyRef(url) { return '/proxy?url=' + encodeURIComponent(url); }
function rewrite(text, base) {
  return text.split(/\r?\n/).map(line => {
    const s = line.trim();
    if (!s) return line;
    if (s.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_,ref) => {
      try { return 'URI="' + proxyRef(new URL(ref,base).toString()) + '"'; }
      catch { return 'URI="' + ref + '"'; }
    });
    try { return proxyRef(new URL(s,base).toString()); } catch { return line; }
  }).join('\n');
}
const server = http.createServer(async (req,res) => {
  const origin = `http://${HOST}:${PORT}`;
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Range, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!['GET','HEAD'].includes(req.method)) return send(res,405,'text/plain','Method not allowed');
  const parsed = new URL(req.url,origin);
  if (parsed.pathname === '/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(fs.readFileSync(INDEX));
  }
  if (parsed.pathname !== '/proxy') return send(res,404,'text/plain','Not found');
  const target = parsed.searchParams.get('url');
  if (!target) return send(res,400,'text/plain','Missing url parameter');
  try {
    const {res:up,url} = await upstream(target);
    const status = up.statusCode || 502;
    const ct = String(up.headers['content-type'] || '').toLowerCase();
    const playlist = url.pathname.toLowerCase().endsWith('.m3u8') ||
      ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl');
    if (playlist && status >= 200 && status < 300) {
      let chunks=[],size=0;
      up.on('data',chunk=>{
        size+=chunk.length;
        if(size>MAX_PLAYLIST) up.destroy(new Error('Playlist too large'));
        else chunks.push(chunk);
      });
      up.on('end',()=>{
        const body = rewrite(Buffer.concat(chunks).toString('utf8'),url.toString());
        res.writeHead(status,{'Content-Type':'application/vnd.apple.mpegurl; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':origin});
        res.end(body);
      });
      up.on('error',e=>{if(!res.headersSent)send(res,502,'text/plain','Upstream playlist error: '+e.message)});
      return;
    }
    const headers={'Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'X-Content-Type-Options':'nosniff'};
    for(const h of ['content-type','content-length','accept-ranges','content-range','icy-metaint','icy-name','icy-description'])
      if(up.headers[h])headers[h]=up.headers[h];
    res.writeHead(status,headers);
    if(req.method==='HEAD'){up.destroy();return res.end();}
    up.pipe(res);
    req.on('close',()=>up.destroy());
  } catch(e) {
    send(res,502,'text/plain; charset=utf-8','Relay error: '+e.message);
  }
});
server.listen(PORT,HOST,()=>{
  console.log(`Airwave running at http://${HOST}:${PORT}`);
  console.log('Keep this terminal open while listening. Relay is localhost-only; do not expose it publicly.');
});
