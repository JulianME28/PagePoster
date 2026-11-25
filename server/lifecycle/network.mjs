// Server-only HTTPS transport (read-only unless writes are explicitly enabled). Never replace this with global fetch: DNS is checked
// once per hop and the approved address is pinned to that hop's TLS connection.
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export class NetworkError extends Error {
  constructor(code) { super(code); this.name = 'NetworkError'; this.code = code; }
}
const fail = code => { throw new NetworkError(code); };

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left;
  const first = parseInt(words[0],16), second = parseInt(words[1],16);
  // Only ordinary global unicast. Transition/translation, special-use and
  // documentation ranges are deliberately unsupported rather than guessed safe.
  if (first < 0x2000 || first > 0x3fff || first === 0x2002 ||
      (first === 0x2001 && (second < 0x200 || second === 0xdb8)) ||
      (first === 0x3fff && second < 0x1000)) return false;
  return true;
}

export function validatePublicUrl(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(input)) fail('unsafe_url');
  let url;
  try { url = new URL(input); } catch { fail('unsafe_url'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('unsafe_url');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
  if (!host || host === 'localhost' || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)) fail('unsafe_url');
  if (isIP(host)) { if (!isPublicAddress(host)) fail('unsafe_address'); }
  else if (!host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) fail('unsafe_url');
  return url;
}

function headersOf(value) {
  const headers = Object.create(null);
  for (const [key, entry] of Object.entries(value || {})) {
    const name = key.toLowerCase();
    if (!/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/.test(name) || typeof entry !== 'string' || /[\r\n]/.test(entry)) fail('invalid_headers');
    if (['host','connection','content-length','transfer-encoding'].includes(name)) fail('invalid_headers');
    headers[name] = entry;
  }
  headers['accept-encoding'] = 'identity';
  if (!headers['user-agent']) headers['user-agent'] = 'PagePoster-Monitor/1.0';
  return headers;
}
function cap(number, fallback, maximum) { return Number.isInteger(number) && number > 0 ? Math.min(number,maximum) : fallback; }

/** Inject lookup/request only for server-side tests. No caller-supplied URL can
 * override the pinned lookup, TLS verification, body limit or timeout. */
export function createSafeTransport({ lookup = dnsLookup, request = https.request, measureProxy = false,
  timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 5, allowWrites = false, maxRequestBytes = 2 * 1024 * 1024 } = {}) {
  const duration = cap(timeoutMs,15000,60000);
  const byteLimit = cap(maxBytes,2*1024*1024,5*1024*1024);
  const requestLimit = cap(maxRequestBytes,2*1024*1024,2*1024*1024);
  const redirectLimit = Number.isInteger(maxRedirects) && maxRedirects >= 0 ? Math.min(maxRedirects,5) : 5;
  return async function transport(input, options = {}) {
    let requestStarted=false,proxyUnsent=false;
    try {
    const method = options.method || 'GET';
    if (method !== 'GET' && !(allowWrites === true && method === 'POST')) fail('read_only');
    if (method === 'GET' && options.body !== undefined) fail('read_only');
    const body = method === 'POST' ? options.body : undefined;
    if (method === 'POST' && typeof body !== 'string' && !Buffer.isBuffer(body)) fail('invalid_request_body');
    if (body !== undefined && Buffer.byteLength(body,'utf8') > requestLimit) fail('request_too_large');
    let current = validatePublicUrl(String(input));
    let headers = headersOf(options.headers);
    const controller = new AbortController();
    const abortFromCaller=()=>controller.abort();
    if(options.signal?.aborted)controller.abort();
    else options.signal?.addEventListener('abort',abortFromCaller,{once:true});
    const timer = setTimeout(() => controller.abort(), duration);
    const redirects = [];
    function deadline(promise, errorCode) {
      return new Promise((resolve,reject) => {
        const abort = () => reject(new NetworkError('network_timeout'));
        if (controller.signal.aborted) return abort();
        controller.signal.addEventListener('abort',abort,{ once:true });
        Promise.resolve(promise).then(resolve, error => reject(error instanceof NetworkError ? error : new NetworkError(errorCode)))
          .finally(() => controller.signal.removeEventListener('abort',abort));
      });
    }
    async function resolveAddress(url) {
      const hostname = url.hostname.replace(/^\[|\]$/g,'');
      if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
      const addresses = await deadline(Promise.resolve().then(() => lookup(hostname,{ all:true, verbatim:true })), 'dns_failed');
      if (!Array.isArray(addresses) || !addresses.length) fail('dns_failed');
      for (const entry of addresses) {
        if (!entry || !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family) fail('unsafe_address');
      }
      return addresses[0];
    }
    async function once(url, pinned) {
      if (controller.signal.aborted) fail('network_timeout');
      return new Promise((resolve,reject) => {
        let req, res, finished = false;
        const observe = measureProxy && typeof options.onProxyUsage === 'function' ? options.onProxyUsage : null;
        const usage = observe ? {eventId:randomUUID(),bytesSent:0,bytesReceived:0,requests:0,connections:0} : null;
        const end = (error,value) => {
          if (finished) return; finished = true;
          controller.signal.removeEventListener('abort',abort);
          if (usage && (usage.connections || usage.requests || usage.bytesReceived)) {
            try { observe(usage); } catch {}
          }
          if (error) { res?.destroy(); req?.destroy(); reject(error); } else resolve(value);
        };
        const abort = () => end(new NetworkError('network_timeout'));
        controller.signal.addEventListener('abort',abort,{ once:true });
        try {
          requestStarted=true;
          req = request(url, {
            method, headers, agent:false, rejectUnauthorized:true,
            family:pinned.family, autoSelectFamily:false, maxHeaderSize:16384,
            ...(usage ? {onProxyConnect:()=>{if(!finished)usage.connections++;}} : {}),
            lookup(_host, settings, callback) {
              if (typeof settings === 'function') { callback = settings; settings = {}; }
              if (settings?.all) callback(null,[{ address:pinned.address,family:pinned.family }]);
              else callback(null,pinned.address,pinned.family);
            }
          }, incoming => {
            res = incoming;
            res.on('error',() => end(new NetworkError('network_failed')));
            res.on('aborted',() => end(new NetworkError('network_failed')));
            if (finished) { res.destroy(); return; }
            const responseHeaders = Object.assign(Object.create(null), res.headers);
            if (Array.isArray(res.rawHeaders)) {
              const tags = [];
              for (let i=0; i<res.rawHeaders.length; i+=2) if (res.rawHeaders[i].toLowerCase() === 'x-robots-tag') tags.push(res.rawHeaders[i+1]);
              if (tags.length) responseHeaders['x-robots-tag'] = tags;
            }
            const encoding = String(responseHeaders['content-encoding'] || 'identity').toLowerCase();
            if (encoding !== 'identity') return end(new NetworkError('unsupported_encoding'));
            const declared = Number(responseHeaders['content-length']);
            if (Number.isFinite(declared) && declared > byteLimit) return end(new NetworkError('response_too_large'));
            const chunks = []; let bytes = 0;
            res.on('data',chunk => {
              if (finished) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (usage) usage.bytesReceived += buffer.length;
              bytes += buffer.length;
              if (bytes > byteLimit) return end(new NetworkError('response_too_large'));
              chunks.push(buffer);
            });
            res.on('end',() => { const body=Buffer.concat(chunks); end(null,{ status:res.statusCode,headers:responseHeaders,body,text:body.toString('utf8') }); });
            res.on('close',() => { if (!res.readableEnded && !finished) end(new NetworkError('network_failed')); });
          });
          if(usage)req.once('finish',()=>{
            if(finished)return;
            usage.requests=1;usage.bytesSent=body===undefined?0:Buffer.byteLength(body,'utf8');
          });
          req.on('error',error => {const code=['PROXY_CONNECT_FAILED','PROXY_AUTH_FAILED','PROXY_TIMEOUT','PROXY_TUNNEL_FAILED','PROXY_SESSION_CLOSED'].includes(error?.code)?error.code:'network_failed';const failure=new NetworkError(code);if(method==='POST'&&error?.proxyRequestNotStarted===true)proxyUnsent=true;end(failure);});
          req.end(body);
        } catch { end(new NetworkError('network_failed')); }
      });
    }
    try {
      for (let hop=0; ; hop++) {
        const address = await resolveAddress(current);
        const response = await once(current,address);
        // Bootstrap callers inspect redirects themselves to maintain a bounded same-origin cookie jar.
        if (options.followRedirects === false) return { ...response,url:current.href,redirects };
        if (method === 'POST' && response.status >= 300 && response.status < 400) fail('write_redirect_blocked');
        if (![301,302,303,307,308].includes(response.status)) return { ...response,url:current.href,redirects };
        if (hop >= redirectLimit) fail('too_many_redirects');
        const location = response.headers.location;
        if (typeof location !== 'string' || /[\u0000-\u0020\u007f\\]/.test(location)) fail('invalid_redirect');
        let next;
        try { next = validatePublicUrl(new URL(location,current).href); } catch (error) { throw error instanceof NetworkError ? error : new NetworkError('invalid_redirect'); }
        if (next.origin !== current.origin) {
          if(options.sameOriginOnly===true)fail('cross_origin_redirect');
          headers = { ...headers };
          delete headers.authorization; delete headers.cookie; delete headers['proxy-authorization'];
        }
        redirects.push({ from:current.href,to:next.href,status:response.status });
        current = next;
      }
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',abortFromCaller); }
    } catch(error) {
      // Include earlier redirect hops; beginning request construction is enough
      // to make the remote outcome unknown, even when no response arrives.
      error.requestNotStarted=proxyUnsent||!requestStarted;
      throw error;
    }
  };
}
