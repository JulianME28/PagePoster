import {randomUUID} from 'node:crypto';
import {createProxyPool,proxyError} from './proxy-pool.mjs';
import {isPublicAddress} from './network.mjs';

// Fixed read-only service. Neither the renderer nor proxy responses can select a URL.
const ENDPOINT='https://api.country.is/';
const faults=new Set(['PROXY_CONNECT_FAILED','PROXY_AUTH_FAILED','PROXY_TIMEOUT','PROXY_TUNNEL_FAILED']);
export function createProxyChecks({createProxyTransport,coordination,clock=Date.now,timeoutMs=7000,concurrency=4}={}){
 if(typeof createProxyTransport!=='function'||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw proxyError('PROXY_CONFIG_INVALID');
 let job=null,task=Promise.resolve(),closed=false,controllers=new Set();
 const status=()=>job?structuredClone(job):null;
 function start(entries,{revision,source='saved'}={}){
  if(closed)throw proxyError('PROXY_ROUTER_CLOSED');if(job?.state==='running')throw proxyError('PROXY_CHECK_RUNNING');
  if(!entries.length)throw proxyError('PROXY_LIST_EMPTY');
  const pool=createProxyPool({entries,coordination,clock});
  job={id:randomUUID(),revision,source,state:'running',startedAt:new Date(clock()).toISOString(),finishedAt:null,total:entries.length,completed:0,rows:entries.map((entry,index)=>{const u=new URL(entry.url);return {index:index+1,label:entry.label||'Проксі '+(index+1),server:u.protocol+'//'+u.hostname+':'+(u.port||({http:'80',https:'443',socks5:'1080'})[u.protocol.slice(0,-1)]),state:'queued',ip:null,country:null,responseMs:null,checkedAt:null,code:null};})};
  const current=job;let cursor=0;
  async function check(index){
   const row=current.rows[index],sessionId='proxy-check:'+current.id+':'+index;let lease,adapter,timer,controller;
   const begin=performance.now();
   try{
    const available=pool.list()[index];if(available.busy){row.state='busy';row.code='PROXY_CHECK_BUSY';return;}if(available.retryAt){row.state='cooldown';row.code='PROXY_CHECK_COOLDOWN';return;}
    lease=pool.acquire(sessionId,{proxyId:entries[index].id});row.state='checking';
    controller=new AbortController();controllers.add(controller);timer=setTimeout(()=>controller.abort('timeout'),timeoutMs);
    adapter=await createProxyTransport(lease.proxy);
    if(current.state!=='running')controller.abort('cancelled');
    const transport=typeof adapter==='function'?adapter:adapter?.transport;if(typeof transport!=='function')throw proxyError('PROXY_ADAPTER_INVALID');
    const aborted=new Promise((_,reject)=>{const abort=()=>reject(proxyError(controller.signal.reason==='timeout'?'PROXY_TIMEOUT':'PROXY_CHECK_CANCELLED'));if(controller.signal.aborted)abort();else controller.signal.addEventListener('abort',abort,{once:true});});
    const response=await Promise.race([Promise.resolve().then(()=>transport(ENDPOINT,{method:'GET',signal:controller.signal,headers:{Accept:'application/json'}})),aborted]);
    if(response.status!==200)throw proxyError('PROXY_CHECK_SERVICE_UNAVAILABLE');
    if(typeof response.text!=='string'||Buffer.byteLength(response.text)>4096)throw proxyError('PROXY_CHECK_RESPONSE_INVALID');
    let value;try{value=JSON.parse(response.text);}catch{throw proxyError('PROXY_CHECK_RESPONSE_INVALID');}
    if(!value||typeof value.ip!=='string'||!isPublicAddress(value.ip)||value.country!==null&&value.country!==undefined&&(typeof value.country!=='string'||! /^[A-Z]{2}$/.test(value.country)))throw proxyError('PROXY_CHECK_RESPONSE_INVALID');
    row.state='ok';row.ip=value.ip;row.country=value.country||null;
   }catch(error){
    const cancelled=current.state==='cancelled',timeout=controller?.signal.reason==='timeout';
    row.code=cancelled?'PROXY_CHECK_CANCELLED':timeout?'PROXY_TIMEOUT':faults.has(error?.code)?error.code:['PROXY_CHECK_SERVICE_UNAVAILABLE','PROXY_CHECK_RESPONSE_INVALID'].includes(error?.code)?error.code:'PROXY_CHECK_FAILED';
    row.state=cancelled?'cancelled':faults.has(row.code)?'failed':'unknown';
   }finally{
    clearTimeout(timer);if(controller)controllers.delete(controller);
    let released=true;try{if(typeof adapter?.close==='function')await adapter.close();}catch{released=false;row.state='failed';row.code='PROXY_CLOSE_FAILED';}
    if(lease&&released)pool.release(sessionId,lease.leaseId);
    row.responseMs=Math.round(performance.now()-begin);row.checkedAt=new Date(clock()).toISOString();current.completed++;
   }
  }
  async function worker(){while(current.state==='running'&&cursor<entries.length){const index=cursor++;await check(index);}}
  task=Promise.all(Array.from({length:Math.min(concurrency,entries.length)},worker)).finally(()=>{
   for(const row of current.rows)if(row.state==='queued'){row.state='cancelled';row.code='PROXY_CHECK_CANCELLED';current.completed++;}
   if(current.state==='running')current.state='completed';current.finishedAt=new Date(clock()).toISOString();
  });
  return status();
 }
 async function cancel(id){if(job?.state==='running'){if(id&&id!==job.id)throw proxyError('CONFLICT');job.state='cancelled';for(const controller of controllers)controller.abort('cancelled');}await task;return status();}
 async function clear(){await cancel();job=null;}
 async function close(){closed=true;await cancel();}
 return {start,status,cancel,clear,close,wait:()=>task};
}
