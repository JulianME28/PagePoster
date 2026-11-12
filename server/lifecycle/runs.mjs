import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createRunStore} from './run-store.mjs';
import {prepareGeneration,executeBatch,finishGeneration,inspectGenerationQuality} from './generation.mjs';
import {renderPage} from './render.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const active=new Set(['queued','running','paused','uncertain']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function createRuns({filename,store,handler,budget,env={},maxPages=1000,clock=Date.now}){
 const runs=createRunStore({filename,clock}),workerId=randomUUID();
 const pageFor=id=>{const page=store.getPage(id);if(!page)fail('NOT_FOUND');return page;};
 function siteFor(id,projectId){const site=store.getSite(id);if(!site||!store.siteBelongsToProject(projectId,id))fail('VALIDATION');if(!site.enabled)fail('disabled');if(!site.hasCredential)fail('auth_failed');return site;}
 function assertCurrent(run){runs.assertLease(run.id,run.leaseToken);const page=pageFor(run.spec.pageId);if(store.getProject(run.projectId)?.archived||page.revision!==run.spec.sourceRevision||page.wpId)fail('CONFLICT');if(run.spec.siteId)siteFor(run.spec.siteId,run.projectId);return page;}
 const safeCodes=new Set(['not_configured','AI_BUDGET_EXCEEDED','AI_RATE_UNKNOWN','AI_AUTH_FAILED','AI_ACCESS_DENIED','AI_MODEL_UNAVAILABLE','AI_RATE_LIMITED','AI_REQUEST_REJECTED','AI_CANCELLED','disabled','auth_failed']);
 const preDispatchCodes=new Set(['not_configured','AI_BUDGET_EXCEEDED','AI_RATE_UNKNOWN','disabled','auth_failed']);
 function retryProof(run,code=run.error?.code){
  if(!safeCodes.has(code)||run.retryCount>=2||run.cursor>=run.spec.batches.length||typeof budget?.getRequest!=='function')return null;
  const requestId=run.id+'-'+run.cursor,receipt=budget.getRequest(requestId);
  if(receipt?.state==='completed')return {requestId,replay:true};
  if(receipt?.state==='rejected'&&receipt.retryable)return {requestId,authorize:true};
  if(!receipt&&preDispatchCodes.has(code))return {requestId,undispatched:true};
  return null;
 }
 function resume(run){
  if(store.getProject(run.projectId)?.archived)fail('CONFLICT');
  if(run.state==='failed'){
   const proof=retryProof(run),page=pageFor(run.spec.pageId);
   if(!run.retryable||!proof||page.revision!==run.spec.sourceRevision||page.wpId)fail('CONFLICT');
   const competing=runs.listRuns(run.projectId,{states:[...active]}),jobs=store.listJobs(run.projectId),reservations=store.listCampaignReservations(run.projectId);
   if(competing.some(other=>other.id!==run.id&&other.spec.pageId===page.id)||jobs.some(job=>job.pageId===page.id&&job.effect==='write'&&active.has(job.state))||reservations.some(item=>item.pageId===page.id&&item.runId!==run.id))fail('CONFLICT');
   if(run.spec.siteId)siteFor(run.spec.siteId,run.projectId);
   if(run.spec.status!=='review'){
    const reserved=new Set(store.listPages(run.projectId).filter(item=>item.wpId).map(item=>item.id));
    for(const item of competing)if(item.spec.status!=='review')reserved.add(item.spec.pageId);
    for(const job of jobs)if(job.type==='publish'&&active.has(job.state))reserved.add(job.pageId);
    for(const item of reservations)if(item.status!=='review')reserved.add(item.pageId);
    reserved.add(page.id);if(reserved.size>maxPages)fail('CAPACITY_EXCEEDED');
   }
   if(proof.authorize)budget.authorizeRetry(proof.requestId);
   return runs.resumeRun(run.id,{expectedRevision:run.revision,allowFailedRetry:true});
  }
  return runs.resumeRun(run.id,{expectedRevision:run.revision});
 }
 function beforePublish(page){
  const current=runs.listRuns(page.projectId,{states:[...active]});if(current.some(r=>r.spec.pageId===page.id)||store.listCampaignReservations(page.projectId).some(item=>item.pageId===page.id))fail('CONFLICT');
  const reserved=new Set(store.listPages(page.projectId).filter(p=>p.wpId).map(p=>p.id));
  for(const job of store.listJobs(page.projectId))if(job.type==='publish'&&active.has(job.state))reserved.add(job.pageId);
  for(const run of current)if(run.spec.status!=='review')reserved.add(run.spec.pageId);
  for(const item of store.listCampaignReservations(page.projectId))if(item.status!=='review')reserved.add(item.pageId);
  reserved.add(page.id);if(reserved.size>maxPages)fail('CAPACITY_EXCEEDED');
 }
 function launch(pageId,body,options={}){
   const page=pageFor(pageId);
   if(store.getProject(page.projectId)?.archived)fail('CONFLICT');
   if(!body||Object.keys(body).some(k=>!['expectedRevision','idempotencyKey','status','siteId','paths','brief','linkInsertions'].includes(k))||!uuid.test(body.idempotencyKey)||!['review','draft','publish'].includes(body.status)||!Array.isArray(body.paths))fail('VALIDATION');
   const prior=runs.getRunByKey(body.idempotencyKey);if(prior){if(prior.projectId!==page.projectId||prior.spec.pageId!==page.id||!isDeepStrictEqual(prior.spec.launch,body))fail('CONFLICT');return prior;}
   const reservation=store.listCampaignReservations(page.projectId).find(item=>item.pageId===page.id);if(reservation&&(reservation.campaignId!==options.campaignId||reservation.runId!==options.runId))fail('CONFLICT');
   if(page.wpId||page.revision!==body.expectedRevision||runs.listRuns(page.projectId,{pageId:page.id,states:[...active]}).length>0||store.listJobs(page.projectId).some(j=>j.pageId===page.id&&j.effect==='write'&&active.has(j.state)))fail('CONFLICT');
   const siteId=body.status==='review'?null:body.siteId;if(siteId)siteFor(siteId,page.projectId);else if(body.status!=='review')fail('VALIDATION');if(page.siteId&&siteId&&page.siteId!==siteId)fail('CONFLICT');
   if(body.paths.length&&!env.OPENAI_API_KEY?.trim())fail('not_configured');
   const pending=new Set(runs.listRuns(null,{states:[...active],limit:1000}).map(run=>run.spec.pageId));for(const item of store.listCampaignReservations())pending.add(item.pageId);pending.add(page.id);if(pending.size>100)fail('CAPACITY_EXCEEDED');
   if(body.status!=='review'){
    const reserved=new Set(store.listPages(page.projectId).filter(p=>p.wpId).map(p=>p.id));
    for(const job of store.listJobs(page.projectId))if(job.type==='publish'&&active.has(job.state))reserved.add(job.pageId);
    for(const current of runs.listRuns(page.projectId,{states:[...active]}))if(current.spec.status!=='review'&&active.has(current.state))reserved.add(current.spec.pageId);
    for(const item of store.listCampaignReservations(page.projectId))if(item.status!=='review')reserved.add(item.pageId);
    reserved.add(page.id);if(reserved.size>maxPages)fail('CAPACITY_EXCEEDED');
   }
   const generation=options.generation||prepareGeneration(page.config,{paths:body.paths,brief:body.brief||{},linkInsertions:body.linkInsertions,mode:body.paths.length?'selected':'manual',model:env.OPENAI_MODEL||'gpt-5.4-mini'});
   const run=runs.createRun({...(options.runId?{id:options.runId}:{}),projectId:page.projectId,idempotencyKey:body.idempotencyKey,spec:{pageId:page.id,sourceRevision:page.revision,siteId,status:body.status,launch:body,generation,batches:generation.batches}});
   store.recordEvent({projectId:page.projectId,entityId:page.id,type:'run.queued',message:'Автоматичний запуск додано до черги: '+body.status});return run;
 }
 async function handle(request,route,read){
  const match=route.match(/^\/pages\/([a-zA-Z0-9-]+)\/runs$/);
  if(match){const page=pageFor(match[1]);if(request.method==='GET')return response({runs:runs.listRuns(page.projectId,{pageId:page.id})});if(request.method!=='POST')return null;return response({run:launch(page.id,await read(request))},202);}
  const action=route.match(/^\/runs\/([a-zA-Z0-9-]+)\/(pause|resume)$/);
  if(action&&request.method==='POST'){const body=await read(request);if(!body||Object.keys(body).length)fail('VALIDATION');const run=runs.getRun(action[1]);if(!run)fail('NOT_FOUND');return response({run:action[2]==='pause'?runs.pauseRun(run.id,{expectedRevision:run.revision}):resume(run)});}
  return null;
 }
 async function tick(){
  runs.recoverExpiredRuns();for(const waiting of runs.listRuns(null,{states:['queued'],limit:1000}))if(store.getProject(waiting.projectId)?.archived)runs.pauseRun(waiting.id,{expectedRevision:waiting.revision});const run=runs.claimRun({workerId,leaseMs:180000});if(!run)return null;
  try{
   const receipt=store.getGenerationReceipt(run.id);if(receipt){runs.transition(run.id,{leaseToken:run.leaseToken,state:run.spec.status==='review'?'review':'completed',stage:'saved',result:receipt});return {id:run.id,state:'completed'};}
   assertCurrent(run);
   if(run.cursor<run.spec.batches.length){
    const result=await executeBatch(run.spec.generation,run.cursor,{handler,env,runId:run.id});assertCurrent(run);
    runs.finishBatch(run.id,{leaseToken:run.leaseToken,batchIndex:run.cursor,requestId:result.requestId,result,validated:true});
    runs.transition(run.id,{leaseToken:run.leaseToken,state:'queued',stage:'generating'});return {id:run.id,state:'queued'};
   }
   const quality=inspectGenerationQuality(run.spec.generation,run.batchResults.map(entry=>entry.result));
   const config=finishGeneration(run.spec.generation,run.batchResults.map(entry=>entry.result));
   const rendered=renderPage(config);if(!rendered.title.trim())fail('VALIDATION');assertCurrent(run);
   const result=store.commitGeneration(run.id,{pageId:run.spec.pageId,sourceRevision:run.spec.sourceRevision,quality,patch:{title:rendered.title,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing',...(run.spec.siteId?{siteId:run.spec.siteId}:{}),lifecycleState:run.spec.status==='review'?'review_required':'queued'},...(run.spec.status==='review'?{}:{publication:{idempotencyKey:run.id,mode:run.spec.status,html:rendered.html,maxPages}})});
   runs.transition(run.id,{leaseToken:run.leaseToken,state:run.spec.status==='review'?'review':'completed',stage:'saved',result});return {id:run.id,state:'completed'};
  }catch(error){
   const state=error.uncertain||error.code==='AI_RESULT_UNCERTAIN'?'uncertain':'failed';
   try{runs.transition(run.id,{leaseToken:run.leaseToken,state,error:{code:typeof error.code==='string'?error.code:'GENERATION_FAILED',retryable:state==='failed'&&!!retryProof(run,error.code)}});}catch{}
   return {id:run.id,state};
  }
 }
 return {handle,tick,runs,launch,beforePublish,hasActivePage:pageId=>runs.listRuns(null,{pageId,states:[...active]}).length>0,close:()=>runs.close()};
}
