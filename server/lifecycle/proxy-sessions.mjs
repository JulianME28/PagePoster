import {createProxyPool,proxyCountry,proxyError} from './proxy-pool.mjs';

// An adapter must keep the existing safe transport's DNS pinning, TLS checks,
// request limits and cancellation. It receives proxy credentials server-side.
// No implementation here enables Chromium's direct network or retries writes.
export function createProxySessionRouter({enabled=false,entries=[],cooldownMs=30000,clock=Date.now,directTransport,createProxyTransport,coordination}={}){
 if(typeof enabled!=='boolean')throw proxyError('PROXY_CONFIG_INVALID');
 if(enabled&&typeof createProxyTransport!=='function')throw proxyError('PROXY_ADAPTER_REQUIRED');
 if(!enabled&&typeof directTransport!=='function')throw proxyError('PROXY_DIRECT_TRANSPORT_REQUIRED');
 const pool=createProxyPool({entries,cooldownMs,clock,coordination}),sessions=new Map(),openings=new Map();let closed=false,closing=null,shutdownFailed=false;
 function sanitized(error,startup=false){
  const code=typeof error?.code==='string'&&/^[A-Za-z_]{1,50}$/.test(error.code)?error.code:'PROXY_TRANSPORT_FAILED';
  const clean=proxyError(code);
  for(const key of ['requestNotStarted','writeNotAttempted','uncertain'])if(typeof error?.[key]==='boolean')clean[key]=error[key];
  if(startup)clean.requestNotStarted=true;
  return clean;
 }
 async function create(sessionId,country,proxyId){
  let lease,adapter;
  try{
   if(closed)throw proxyError('PROXY_ROUTER_CLOSED');
   lease=enabled?pool.acquire(sessionId,{country,proxyId}):null;
   adapter=enabled?await createProxyTransport(lease.proxy):directTransport;
   const transport=typeof adapter==='function'?adapter:adapter?.transport;
   if(typeof transport!=='function'||typeof adapter!=='function'&&adapter.close!==undefined&&typeof adapter.close!=='function')throw proxyError('PROXY_ADAPTER_INVALID');
   const inFlight=new Set(),record={session:null,country,proxyId:lease?.proxy.id,ending:false};let ending=false,closePromise=null;
   const route=Object.freeze(lease?{mode:'proxy',proxyId:lease.proxy.id,label:lease.proxy.label,scheme:lease.proxy.scheme,country:lease.proxy.country}:{mode:'direct'});
   const session=Object.freeze({route,
    async transport(...args){
     if(ending||closed)throw proxyError('PROXY_SESSION_CLOSED');
     const request=Promise.resolve().then(()=>transport.apply(typeof adapter==='function'?undefined:adapter,args));inFlight.add(request);
     try{return await request;}catch(error){if(lease)pool.reportFailure(sessionId,lease.leaseId,error?.code);throw enabled?sanitized(error):error;}finally{inFlight.delete(request);}
    },
    close(){
     if(closePromise)return closePromise;ending=true;record.ending=true;
     closePromise=(async()=>{
      try{
       await Promise.allSettled([...inFlight]);if(enabled&&typeof adapter?.close==='function')await adapter.close();
       if(lease)pool.release(sessionId,lease.leaseId);if(sessions.get(sessionId)?.session===session)sessions.delete(sessionId);
      }catch(error){throw sanitized(error);}
     })();return closePromise;
    }
   });
   record.session=session;sessions.set(sessionId,record);return session;
  }catch(error){
   let cleaned=true;try{if(enabled&&typeof adapter?.close==='function')await adapter.close();}catch{cleaned=false;shutdownFailed=true;}
   if(lease){pool.reportFailure(sessionId,lease.leaseId,error?.code);if(cleaned)pool.release(sessionId,lease.leaseId);}
   throw sanitized(error,true);
  }
 }
 async function open(sessionId,{country,proxyId}={}){
  if(closed)throw proxyError('PROXY_ROUTER_CLOSED');
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>200||/[\u0000-\u001f\u007f]/.test(sessionId))throw proxyError('PROXY_CONFIG_INVALID');
  const region=proxyCountry(country),active=sessions.get(sessionId)||openings.get(sessionId);
  if(active){if(active.ending)throw proxyError('PROXY_SESSION_CLOSING');if(region&&region!==active.country||proxyId&&proxyId!==active.proxyId)throw proxyError('PROXY_SESSION_CONFLICT');return active.session||active.pending;}
  if(sessions.size+openings.size>=256)throw proxyError('PROXY_SESSION_LIMIT');
  const pending=create(sessionId,region,proxyId);openings.set(sessionId,{pending,country:region,proxyId});
  try{return await pending;}finally{if(openings.get(sessionId)?.pending===pending)openings.delete(sessionId);}
 }
 function close(){
  if(closing)return closing;closed=true;
  closing=(async()=>{await Promise.allSettled([...openings.values()].map(item=>item.pending));const results=await Promise.allSettled([...sessions.values()].map(item=>item.session.close()));if(shutdownFailed||results.some(result=>result.status==='rejected'))throw proxyError('PROXY_CLOSE_FAILED');})();
  return closing;
 }
 return Object.freeze({open,close,status:()=>({enabled,proxies:pool.list()})});
}
