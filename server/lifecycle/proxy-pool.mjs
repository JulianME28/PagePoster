import {randomUUID} from 'node:crypto';

const MAX_PROXIES=256;
const proxyFaults=new Set(['PROXY_CONNECT_FAILED','PROXY_AUTH_FAILED','PROXY_TIMEOUT','PROXY_TUNNEL_FAILED']);
export function proxyError(code){return Object.assign(Error(code),{code});}
const fail=code=>{throw proxyError(code);};
function text(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
export function proxyCountry(value){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||! /^[a-z]{2}$/i.test(value))fail('PROXY_CONFIG_INVALID');
 return value.toUpperCase();
}
function definition(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','url','label','country','enabled'].includes(k))||!text(input.id,100)||! /^[A-Za-z0-9_-]+$/.test(input.id)||!text(input.url,4096)||/[\s\\]/.test(input.url)||input.enabled!==undefined&&typeof input.enabled!=='boolean'||input.label!==undefined&&!text(input.label,80))fail('PROXY_CONFIG_INVALID');
 try{
  const url=new URL(input.url),scheme=url.protocol.slice(0,-1);
  if(!['http','https','socks5'].includes(scheme)||url.pathname&&url.pathname!=='/'||url.search||url.hash||!url.hostname||url.hostname.endsWith('.'))fail('PROXY_CONFIG_INVALID');
  const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  if(Boolean(username)!==Boolean(password)||/[\u0000-\u001f\u007f]/.test(username+password)||username.length>512||password.length>1024)fail('PROXY_CONFIG_INVALID');
  const port=url.port||({http:'80',https:'443',socks5:'1080'})[scheme];
  const server=scheme+'://'+url.hostname.toLowerCase()+':'+port;
  return Object.freeze({id:input.id,label:input.label||input.id,country:proxyCountry(input.country),enabled:input.enabled!==false,scheme,server,...(username?{username,password}:{})});
 }catch{fail('PROXY_CONFIG_INVALID');}
}

// Server-only. Leases include secrets for constructing a transport; never return
// them from HTTP handlers. Only list() produces a public, credential-free view.
export function createProxyPool({entries=[],cooldownMs=30000,clock=Date.now,coordination}={}){
 if(!Array.isArray(entries)||entries.length>MAX_PROXIES||!Number.isInteger(cooldownMs)||cooldownMs<0||cooldownMs>3600000||typeof clock!=='function')fail('PROXY_CONFIG_INVALID');
 const proxies=entries.map(definition),ids=new Set(),servers=new Set();
 for(const proxy of proxies){
  // One gateway endpoint has one concurrent lease, even with different accounts.
  if(ids.has(proxy.id)||servers.has(proxy.server))fail('PROXY_CONFIG_INVALID');
  ids.add(proxy.id);servers.add(proxy.server);
 }
 if(coordination&&(!(coordination.busy instanceof Set)||!(coordination.retryAt instanceof Map)))fail('PROXY_CONFIG_INVALID');
 const sessions=new Map(),busy=coordination?.busy||new Set(),retryAt=coordination?.retryAt||new Map();let cursor=0;
 function now(){const value=clock();if(!Number.isFinite(value))fail('PROXY_CLOCK_INVALID');return value;}
 function acquire(sessionId,{country,proxyId}={}){
  if(!text(sessionId,200))fail('PROXY_CONFIG_INVALID');
  const region=proxyCountry(country),existing=sessions.get(sessionId);
  if(proxyId!==undefined&&!text(proxyId,100))fail('PROXY_CONFIG_INVALID');
  if(existing){if(region&&region!==existing.country||proxyId&&proxyId!==existing.proxy.id)fail('PROXY_SESSION_CONFLICT');return existing;}
  const time=now();
  for(let offset=0;offset<proxies.length;offset++){
   const index=(cursor+offset)%proxies.length,proxy=proxies[index];
   if(!proxy.enabled||busy.has(proxy.server)||(retryAt.get(proxy.server)||0)>time||region&&proxy.country!==region||proxyId&&proxy.id!==proxyId)continue;
   const lease=Object.freeze({leaseId:randomUUID(),sessionId,country:region,proxy});
   sessions.set(sessionId,lease);busy.add(proxy.server);cursor=(index+1)%proxies.length;return lease;
  }
  fail(proxyId?'PROXY_PINNED_UNAVAILABLE':'PROXY_POOL_EXHAUSTED');
 }
 function release(sessionId,leaseId){const lease=sessions.get(sessionId);if(!lease||lease.leaseId!==leaseId)return false;sessions.delete(sessionId);busy.delete(lease.proxy.server);return true;}
 function reportFailure(sessionId,leaseId,code){
  const lease=sessions.get(sessionId);if(!lease||lease.leaseId!==leaseId||!proxyFaults.has(code))return false;
  retryAt.set(lease.proxy.server,Math.max(retryAt.get(lease.proxy.server)||0,now()+cooldownMs));return true;
 }
 function list(){const time=now();return proxies.map(proxy=>({id:proxy.id,label:proxy.label,country:proxy.country,scheme:proxy.scheme,enabled:proxy.enabled,authRequired:!!proxy.username,busy:busy.has(proxy.server),retryAt:(retryAt.get(proxy.server)||0)>time?retryAt.get(proxy.server):null}));}
 return Object.freeze({acquire,release,reportFailure,list});
}
