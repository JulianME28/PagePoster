import {createHash} from 'node:crypto';
import {prepareGeneration} from './generation.mjs';
const ACTIVE=new Set(['queued','running','paused','uncertain']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const safeCode=error=>typeof error?.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(error.code)?error.code:'GENERATION_FAILED';

/** Campaigns own immutable page/run snapshots; the existing engine owns all paid work. */
export function createCampaigns({store,automation,prepare,env={},maxPages=1000,clock=Date.now}){
 const needCampaign=id=>{const campaign=store.getCampaign(id);if(!campaign)fail('NOT_FOUND');return campaign;};
 function progress(campaign,item){
  const page=store.getPage(item.pageId),run=automation.runs.getRun(item.runId),receipt=store.getGenerationReceipt(item.runId),job=receipt?.jobId?store.getJob(receipt.jobId):null;
  let state=item.state,stage=item.stage,errorCode=item.errorCode;
  if(job){stage='publication';state=job.state;errorCode=job.error?.code||null;if(job.state==='completed'){state=page?.lifecycleState==='review_required'?'review':page?.wpId?(page.remoteSnapshot?.status==='publish'||page.lifecycleState==='published'?'published':'draft'):'uncertain';stage='saved';}}
  else if(run){state=run.state;stage=run.stage;errorCode=run.error?.code||null;if(run.state==='completed'){state='queued';stage='publication';}}
  else if(campaign.state==='paused'&&state==='queued'){state='paused';stage='queued';}
  else if(campaign.state==='active'&&state==='paused'){state='queued';stage='queued';}
  return {pageId:item.pageId,siteId:item.siteId,topic:item.topic,runId:item.runId,state,stage,fullUrl:page?.fullUrl||'',verification:page?.verification||{state:'pending'},errorCode:errorCode&&/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(errorCode)?errorCode:null};
 }
 function publicCampaign(campaign){
  const items=campaign.items.map(item=>progress(campaign,item)),counts={total:items.length,queued:0,running:0,review:0,published:0,draft:0,failed:0,uncertain:0,paused:0};
  for(const item of items)counts[item.state]++;
  const state=campaign.state==='paused'?'paused':counts.running?'running':counts.queued?'queued':counts.uncertain?'uncertain':counts.failed?'failed':counts.paused?'paused':'completed';
  counts.verified=items.filter(i=>i.state==='published'&&i.verification.state==='ok').length;counts.verificationPending=items.filter(i=>i.state==='published'&&i.verification.state!=='ok').length;
  const verification={state:items.some(i=>i.verification.state==='problem')?'problem':counts.verified===items.length?'ok':items.some(i=>i.verification.state==='unknown')?'unknown':'pending'};
  return {verification,id:campaign.id,idempotencyKey:campaign.idempotencyKey,projectId:campaign.projectId,name:campaign.name,status:campaign.status,state,createdAt:campaign.createdAt,updatedAt:campaign.updatedAt,items,counts};
 }
 function checkpoint(campaign){return store.updateCampaignProgress(campaign.id,{items:campaign.items.map(item=>{const current=progress(campaign,item);return {pageId:item.pageId,state:current.state,stage:current.stage,errorCode:current.errorCode};})});}
 function accept(projectId,body){
  if(!store.getProject(projectId))fail('NOT_FOUND');
  if(!body||typeof body!=='object'||Array.isArray(body)||!uuid.test(body.idempotencyKey))fail('VALIDATION');
  const requestHash=createHash('sha256').update(canonical(body)).digest('hex'),prior=store.getCampaignByKey(body.idempotencyKey);
  if(prior){if(prior.projectId!==projectId||prior.requestHash!==requestHash)fail('CONFLICT');return prior;}
  const prepared=prepare(body,{store,env,maxPages,projectId});
  if(!prepared||!['review','draft','publish'].includes(prepared.status)||!Array.isArray(prepared.entries)||!prepared.entries.length||prepared.entries.length>20)fail('VALIDATION');
  const entries=prepared.entries.map(entry=>{
   if(!entry?.page||!entry.launch||entry.launch.status!==prepared.status||!Array.isArray(entry.launch.paths))fail('VALIDATION');
   if(entry.launch.paths.length&&!env.OPENAI_API_KEY?.trim())fail('not_configured');
   return {...entry,generation:prepareGeneration(entry.page.config,{paths:entry.launch.paths,brief:entry.launch.brief||{},linkInsertions:entry.launch.linkInsertions,mode:entry.launch.paths.length?'selected':'manual',model:env.OPENAI_MODEL||'gpt-5.4-mini'})};
  });
  const pending=new Set(automation.runs.listRuns(null,{states:[...ACTIVE],limit:1000}).map(run=>run.spec.pageId));for(const item of store.listCampaignReservations())pending.add(item.pageId);
  if(pending.size+entries.length>100)fail('CAPACITY_EXCEEDED');
  if(prepared.status!=='review'){
   const reserved=new Set(store.listPages(projectId).filter(page=>page.wpId).map(page=>page.id));
   for(const job of store.listJobs(projectId))if(job.type==='publish'&&ACTIVE.has(job.state))reserved.add(job.pageId);
   for(const run of automation.runs.listRuns(projectId,{states:[...ACTIVE],limit:1000}))if(run.spec.status!=='review')reserved.add(run.spec.pageId);
   for(const item of store.listCampaignReservations(projectId))if(item.status!=='review')reserved.add(item.pageId);
   if(reserved.size+entries.length>maxPages)fail('CAPACITY_EXCEEDED');
  }
  return store.createCampaign(projectId,{idempotencyKey:body.idempotencyKey,requestHash,name:prepared.name,status:prepared.status,entries,maxPages,runReservations:automation.runs.listRuns(null,{states:[...ACTIVE],limit:1000}).map(run=>({projectId:run.projectId,pageId:run.spec.pageId,status:run.spec.status}))});
 }
 function pauseChildren(campaign){
  for(const item of campaign.items){
   const run=automation.runs.getRun(item.runId);
   if(run&&['queued','running'].includes(run.state)){
    // Record intent before crossing databases so a crash cannot lose pause ownership.
    store.updateCampaignProgress(campaign.id,{items:[{pageId:item.pageId,pausedRunRevision:run.revision+1}]});
    automation.runs.pauseRun(run.id,{expectedRevision:run.revision});
   }
   const receipt=store.getGenerationReceipt(item.runId),job=receipt?.jobId?store.getJob(receipt.jobId):null;
   if(job?.state==='queued'){
    store.updateCampaignProgress(campaign.id,{items:[{pageId:item.pageId,pausedJobRevision:job.revision+1}]});store.pauseJob(job.id);
   }
   // A running write keeps its lease: pausing a campaign does not undo a remote request.
  }
 }
 function resumeChildren(campaign){
  for(const item of campaign.items){
   const run=automation.runs.getRun(item.runId);
   if(run?.state==='paused'&&run.revision===item.pausedRunRevision)automation.runs.resumeRun(run.id,{expectedRevision:run.revision});
   const receipt=store.getGenerationReceipt(item.runId),job=receipt?.jobId?store.getJob(receipt.jobId):null;
   if(job?.state==='paused'&&job.revision===item.pausedJobRevision&&job.attempt<3)store.resumeJob(job.id);
   if(item.pausedRunRevision!==null||item.pausedJobRevision!==null)store.updateCampaignProgress(campaign.id,{items:[{pageId:item.pageId,pausedRunRevision:null,pausedJobRevision:null}]});
  }
 }
 async function handle(request,route,read){
  const project=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/campaigns$/);
  if(project){if(request.method==='GET')return response({campaigns:store.listCampaigns(project[1]).map(publicCampaign)});if(request.method==='POST')return response({campaign:publicCampaign(accept(project[1],await read(request)))},202);}
  const detail=route.match(/^\/campaigns\/([a-zA-Z0-9-]+)$/);if(detail&&request.method==='GET')return response({campaign:publicCampaign(needCampaign(detail[1]))});
  const action=route.match(/^\/campaigns\/([a-zA-Z0-9-]+)\/(pause|resume)$/);
  if(action&&request.method==='POST'){
   const body=await read(request);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail('VALIDATION');
   const campaign=needCampaign(action[1]);
   if(action[2]==='pause'){store.updateCampaignProgress(campaign.id,{state:'paused'});pauseChildren(campaign);}
   else {store.updateCampaignProgress(campaign.id,{state:'active'});resumeChildren(campaign);}
   return response({campaign:publicCampaign(checkpoint(needCampaign(campaign.id)))});
  }
  return null;
 }
 function tick(){
  for(const original of store.listCampaigns()){
   if(store.getProject(original.projectId)?.archived)continue;
   const campaign=checkpoint(original);if(campaign.state==='paused'){pauseChildren(campaign);checkpoint(needCampaign(campaign.id));continue;}
   resumeChildren(campaign);
   for(const item of campaign.items){
    if(item.state!=='queued'||automation.runs.getRun(item.runId))continue;
    try{automation.launch(item.pageId,item.launch,{runId:item.runId,campaignId:campaign.id,generation:item.generation});}
    catch(error){store.updateCampaignProgress(campaign.id,{items:[{pageId:item.pageId,state:'failed',stage:'launch',errorCode:safeCode(error)}]});}
   }
  }
 }
 function pauseProject(projectId){for(const campaign of store.listCampaigns(projectId)){if(campaign.state!=='active'||publicCampaign(campaign).state==='completed')continue;store.updateCampaignProgress(campaign.id,{state:'paused'});pauseChildren(campaign);}}
 return {handle,tick,pauseProject};
}
