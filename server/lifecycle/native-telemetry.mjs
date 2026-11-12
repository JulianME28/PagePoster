import {publicationCode} from './publication-diagnostics.mjs';

const nested=new Set(['editor','create','send','reconcile']);
const duration=value=>Number.isFinite(value)&&value>=0?Math.min(86400000,Math.round(value)):null;
const status=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
const classes=new Set(['authentication','editor_read','publication','owned_trash_read','public_check','browser','plugin']);
const method=value=>['GET','HEAD','POST'].includes(value)?value:null;
const readClock=read=>{try{const value=read();return Number.isFinite(value)?value:null;}catch{return null;}};
const timestamp=value=>{try{return value===null?null:new Date(value).toISOString();}catch{return null;}};
const elapsed=(started,ended)=>started===null||ended===null?null:duration(ended-started);
const checkpoint=value=>['creating','draft','dispatching','published'].includes(value)?value:null;
const readCheckpoint=read=>{try{return checkpoint(read?.());}catch{return null;}};
// Callbacks are trusted in-process observers, never page/renderer callbacks.
// Even a rejected async callback must not affect publication or become unhandled.
export function emitNativeObservation(observe,event){try{const pending=observe?.(event);if(pending&&typeof pending.catch==='function')pending.catch(()=>{});}catch{}}
export async function observeNativePhase(observe,phase,action,{clock=Date.now,monotonic=()=>performance.now(),checkpoint:currentCheckpoint}={}){
 const at=readClock(clock),started=readClock(monotonic);emitNativeObservation(observe,{kind:'phase',phase,state:'start',at});let error;
 try{return await action();}catch(caught){error=caught;throw caught;}finally{emitNativeObservation(observe,{kind:'phase',phase,state:'end',at:readClock(clock),elapsedMs:elapsed(started,readClock(monotonic)),code:error?publicationCode(error.code):'OK',checkpoint:readCheckpoint(currentCheckpoint)});}
}
// At most 4096 requests and 16 nested spans per operation. No per-request durable
// writes, URL keys, payloads or unbounded event arrays. Request sums may overlap.
export function createNativeTelemetry({clock=Date.now,monotonic=()=>performance.now()}={}){
 const started=readClock(monotonic),startedAt=timestamp(readClock(clock)),open=new Map(),rows=[];let result=null,requestCount=0,networkMs=0,queueMs=0,networkKnown=false,queueKnown=false,httpStatus=null,httpPriority=0,truncated=false;
 const observe=event=>{try{
  if(result||!event)return;
  if(event.kind==='network'){
   if(requestCount>=4096){truncated=true;return;}requestCount++;
   const network=duration(event.networkMs),queue=duration(event.queueMs);if(network!==null){networkKnown=true;networkMs+=network;}if(queue!==null){queueKnown=true;queueMs+=queue;}
   // Static asset responses cannot replace the actual document/write status.
   const priority=event.requestClass==='publication'?3:event.requestClass==='authentication'?2:event.requestClass==='browser'?0:1;
   if(priority&&priority>=httpPriority&&status(event.httpStatus)!==null){httpPriority=priority;httpStatus=status(event.httpStatus);}
   if(priority&&status(event.httpStatus)!==null)for(const row of open.values()){row.httpStatus=status(event.httpStatus);row.method=method(event.method);row.requestClass=classes.has(event.requestClass)?event.requestClass:null;}
  }else if(event.kind==='phase'&&nested.has(event.phase)){
   if(event.state==='start'){if(rows.length+open.size>=16){truncated=true;return;}open.set(event.phase,{phase:event.phase,startedAt:Number.isFinite(event.at)?event.at:null});}
   else if(event.state==='end'&&open.has(event.phase)){const row=open.get(event.phase);open.delete(event.phase);rows.push({...row,endedAt:Number.isFinite(event.at)?event.at:null,elapsedMs:duration(event.elapsedMs),code:publicationCode(event.code),httpStatus:status(event.httpStatus)??row.httpStatus??null,method:method(event.method)??row.method??null,requestClass:classes.has(event.requestClass)?event.requestClass:row.requestClass??null,checkpoint:checkpoint(event.checkpoint),timingScope:'operation'});}
  }
 }catch{}};
 return {observe,finish(){if(!result)result={startedAt,endedAt:timestamp(readClock(clock)),elapsedMs:elapsed(started,readClock(monotonic)),timingScope:'operation',networkScope:'summed_requests',queueScope:'browser_requests',networkMs:networkKnown?Math.min(86400000,networkMs):null,queueMs:queueKnown?Math.min(86400000,queueMs):null,manualWaitMs:null,requestCount:requestCount||null,httpStatus,truncated,phases:[...rows,...[...open.values()].map(row=>({...row,endedAt:null,elapsedMs:null,code:'UNKNOWN',timingScope:'operation'}))]};return result;}};
}
