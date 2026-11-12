import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(body,allowed)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail('VALIDATION');};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export function createReplacementBatches({store,workflow}){
 const need=id=>{const b=store.getRecord(id);if(!b||b.kind!=='replacement-batch')fail('NOT_FOUND');return b;};
 function publicBatch(batch){return {...batch,items:batch.items.map(item=>{let job=null;try{job=item.jobId?store.getJob(item.jobId):null;}catch{}const p=store.getPage(item.pageId);return {...item,state:job?.state||batch.state,errorCode:job?.error?.code||null,verification:p?.verification||{state:'pending'}};})};}
 function prepare(projectId,body){fields(body,['items']);if(!store.getProject(projectId))fail('NOT_FOUND');if(!Array.isArray(body.items)||body.items.length<1||body.items.length>20||new Set(body.items.map(i=>i.pageId)).size!==body.items.length)fail('VALIDATION');return store.atomic(()=>{
  const items=body.items.map(item=>{fields(item,['pageId','expectedRevision','changes']);const page=store.getPage(item.pageId);if(!page||page.projectId!==projectId)fail('NOT_FOUND');const proposal=workflow.prepareReplacement(page.id,{expectedRevision:item.expectedRevision,changes:item.changes});return {pageId:page.id,title:page.title,fullUrl:page.fullUrl,proposalId:proposal.id,proposalRevision:proposal.revision,expectedPageRevision:page.revision,diff:proposal.diff,jobId:null};});
  const confirmationHash=createHash('sha256').update(JSON.stringify(items)).digest('hex');return publicBatch(store.createRecord(projectId,'replacement-batch',{state:'pending',confirmationHash,items}));
 });}
 function confirm(id,body){fields(body,['expectedRevision','confirmationHash','confirmed']);if(body.confirmed!==true)fail('VALIDATION');return store.atomic(()=>{const batch=need(id);if(body.confirmationHash!==batch.confirmationHash)fail('CONFLICT');if(batch.state==='confirmed')return publicBatch(batch);if(batch.state!=='pending'||body.expectedRevision!==batch.revision)fail('CONFLICT');
  for(const item of batch.items){const page=store.getPage(item.pageId);if(!page||page.projectId!==batch.projectId||page.revision!==item.expectedPageRevision)fail('CONFLICT');}
  const items=batch.items.map(item=>({...item,jobId:workflow.confirmReplacement(item.proposalId,{expectedRevision:item.proposalRevision,confirmed:true}).id}));
  return publicBatch(store.updateRecord(id,{state:'confirmed',confirmedAt:new Date().toISOString(),items},batch.revision));
 });}
 async function handle(request,route,read){const list=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/replacement-batches$/);if(list){if(request.method==='GET')return response({batches:store.listRecords(list[1],'replacement-batch').map(publicBatch)});if(request.method==='POST')return response({batch:prepare(list[1],await read(request))},201);}
 const detail=route.match(/^\/replacement-batches\/([a-zA-Z0-9-]+)(?:\/(confirm))?$/);if(detail){if(!detail[2]&&request.method==='GET')return response({batch:publicBatch(need(detail[1]))});if(detail[2]&&request.method==='POST')return response({batch:confirm(detail[1],await read(request))},202);}return null;}
 return {prepare,confirm,handle};
}
