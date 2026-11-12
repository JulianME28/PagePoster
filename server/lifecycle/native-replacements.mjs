import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {bridgeContentHash} from './bridge-client.mjs';
import {listNativePlacements,proposeNativeReplacement,applyNativeReplacement} from './native-link-replacement.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const nativeHash=value=>hash(JSON.stringify([value.postType,value.title,value.content,value.status]));
const fail=(code='CONFLICT',extra={})=>{throw Object.assign(Error(code),{code,...extra});};
const fields=(body,allowed)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail('VALIDATION');};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const candidateKey=run=>run?.candidate?.id?run.candidate.id+(run.manualTarget?'|'+(run.canonicalLogin?.requestedBaseUrl||run.manualTarget.baseUrl):''):null;
export const nativeUpdateSourceBinding=run=>({candidateKey:candidateKey(run),baseUrl:run?.candidate?.baseUrl||null,destinationRevision:run?.destinationRevision||0,siteId:run?.siteId||null,pageId:run?.pageId||null,postId:run?.nativePublication?.postId||null,url:run?.nativePublication?.url||null,proxyRoute:run?.proxyBinding?.candidateKey===candidateKey(run)?{mode:run.proxyBinding.mode,proxyId:run.proxyBinding.proxyId||null}:null});
const sourceBinding=nativeUpdateSourceBinding;
function observedComparison(error){const actual=error?.comparison?.actual;if(!actual||typeof actual.title!=='string'||typeof actual.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(actual.contentHash))return {};return {actual:{title:actual.title.slice(0,300),status:typeof actual.status==='string'&&/^[a-z_-]{1,32}$/.test(actual.status)?actual.status:'unknown',contentHash:actual.contentHash}};}
export function createNativeReplacements({store,publicationTurn,openSession,finishSession=async()=>{},clock=Date.now,beforeRemoteWrite=()=>{}}){
 let syncing=null;
 const pageFor=id=>{const page=store.getPage(id);if(!page)fail('NOT_FOUND');return page;};
 const records=()=>store.listProjects().flatMap(p=>store.listRecords(p.id,'native_update'));
 const optionalJob=id=>{if(typeof id!=='string'||!id)return null;try{return store.getJob(id);}catch(error){if(error?.code==='NOT_FOUND')return null;throw error;}};
 const boundNativeJob=(record,job)=>!!(record?.kind==='native_update'&&job?.type==='replace'&&job.effect==='write'&&job.payload?.mode==='native-update'&&job.payload.nativeUpdateId===record.id&&job.pageId===record.pageId&&job.siteId===record.siteId&&job.projectId===record.projectId);
 const update=(id,patch)=>{const r=store.getRecord(id);return store.updateRecord(id,patch,r.revision);};
 const originFor=page=>store.listRecords(page.projectId,'autopilot').find(r=>!r.deletedAt&&r.pageId===page.id&&r.siteId===page.siteId&&r.nativePublication?.postId===page.wpId&&r.nativePublication?.url===page.fullUrl&&candidateKey(r));
 function snapshot(page){const raw=page.remoteSnapshot;if(raw?.mode!=='browser'||raw.status!=='publish'||raw.postType!=='page'||!page.wpId||!page.fullUrl||typeof raw.content!=='string')fail('NATIVE_SNAPSHOT_UNAVAILABLE');
  const value={...raw,postId:raw.postId??page.wpId,title:raw.title??page.title,url:raw.url??page.fullUrl,config:raw.config??page.config};
  if(value.postId!==page.wpId||value.url!==page.fullUrl||typeof value.title!=='string'||![bridgeContentHash(value),nativeHash(value)].includes(raw.contentHash)||!isDeepStrictEqual(value.config,page.config))fail('NATIVE_SNAPSHOT_UNAVAILABLE');return value;
 }
 function availability(page){if(page.remoteSnapshot?.mode!=='browser')return {available:false,mode:'bridge',reason:'legacy_connection',accessRequired:false};
  let reason=null;try{const saved=snapshot(page);listNativePlacements(saved.content,{expectedMarker:page.expectedMarker||'pp-landing'});}catch(error){reason=/^NATIVE_LINK_[A-Z_]+$/.test(error.code||'')?error.code:'NATIVE_SNAPSHOT_UNAVAILABLE';}
  const site=store.getSite(page.siteId);if(!reason&&(!site||site.bootstrap?.mode!=='browser'||!store.siteBelongsToProject(page.projectId,site.id)))reason='NATIVE_BINDING_UNAVAILABLE';
  if(!reason&&!originFor(page))reason='NATIVE_SOURCE_UNAVAILABLE';
  if(!reason&&site.enabled===false)reason='disabled';
  const previous=records().filter(r=>r.pageId===page.id).at(-1),accessRequired=!reason&&(!site.hasBrowserCredential||previous?.accessRequired===true);if(accessRequired)reason='NATIVE_ACCESS_REQUIRED';
  if(!reason&&typeof openSession!=='function')reason='NATIVE_BROWSER_REQUIRED';
  if(!reason&&['queued','running','uncertain'].includes(store.getRecord('published-trash:'+page.id)?.state))reason='NATIVE_UPDATE_PENDING';
  const pending=records().find(r=>r.pageId===page.id&&!['completed','failed'].includes(r.state));if(!reason&&pending)reason='NATIVE_UPDATE_PENDING';
  return {available:!reason,mode:'native',reason,accessRequired,jobId:pending?.jobId||null};
 }
 const decoratePage=page=>page.remoteSnapshot?.mode==='browser'?{...page,replacement:availability(page)}:page;
 function requireReady(page){const a=availability(page);if(!a.available)fail(a.reason);if(store.getProject(page.projectId)?.archived||store.getRecord('queue-control:'+page.projectId)?.paused)fail('CONFLICT');if(store.listJobs(page.projectId).some(j=>j.pageId===page.id&&j.effect==='write'&&['queued','running','uncertain','paused'].includes(j.state)))fail('CONFLICT');return snapshot(page);}
 function placements(page){let places=[];const replacement=availability(page);if(replacement.available||replacement.reason==='NATIVE_ACCESS_REQUIRED'||replacement.reason==='NATIVE_UPDATE_PENDING')try{places=listNativePlacements(snapshot(page).content,{expectedMarker:page.expectedMarker||'pp-landing'});}catch(error){replacement.available=false;replacement.reason=error.code||'NATIVE_SNAPSHOT_UNAVAILABLE';}return {pageRevision:page.revision,replacement,placements:places};}
 function prepareReplacement(id,body){fields(body,['expectedRevision','changes']);const page=pageFor(id);if(page.revision!==body.expectedRevision)fail();const before=requireReady(page),transform=proposeNativeReplacement(before.content,body.changes,{expectedMarker:page.expectedMarker||'pp-landing'});
  return store.createProposal(id,{expectedPageRevision:page.revision,diff:transform.diff,nextConfig:page.config,expectedContentHash:before.contentHash,kind:'native-links',registryProposal:{version:1,kind:'native-links',before,sourceBinding:sourceBinding(originFor(page)),originRunId:originFor(page).id,transform}});
 }
 function rollbackVersions(page){let before;try{before=snapshot(page);}catch{return [];}const seen=new Set();return (page.versions||[]).filter(v=>{const p=v.snapshot;try{const target=snapshot(p);if(p.siteId!==page.siteId||target.postId!==page.wpId||target.url!==page.fullUrl||target.title!==before.title||target.contentHash===before.contentHash||seen.has(target.contentHash))return false;seen.add(target.contentHash);return true;}catch{return false;}});}
 function prepareRollback(id,body){fields(body,['expectedRevision','versionId']);const page=pageFor(id);if(page.revision!==body.expectedRevision)fail();const before=requireReady(page),version=rollbackVersions(page).find(v=>v.id===body.versionId);if(!version)fail();const target=snapshot(version.snapshot),diff=[{id:'native-version',label:'Версія HTML',role:'rollback',before:{url:'',anchor:before.contentHash},after:{url:'',anchor:target.contentHash}}];
  return store.createProposal(id,{expectedPageRevision:page.revision,diff,nextConfig:target.config,expectedContentHash:before.contentHash,kind:'native-rollback',registryProposal:{version:1,kind:'native-rollback',before,target,targetVersionId:version.id,originRunId:originFor(page).id,sourceBinding:sourceBinding(originFor(page))}});
 }
 function confirmReplacement(id,body){fields(body,['expectedRevision','confirmed']);if(body.confirmed!==true)fail('VALIDATION');return store.atomic(()=>{const proposal=store.getProposal(id);if(!proposal||!['native-links','native-rollback'].includes(proposal.kind))fail('NOT_FOUND');const existing=store.listJobs(proposal.projectId).find(j=>j.idempotencyKey==='proposal:'+id);if(existing)return existing;
   const page=pageFor(proposal.pageId),before=requireReady(page),data=proposal.registryProposal;if(page.revision!==proposal.expectedPageRevision||!isDeepStrictEqual(before,data.before)||before.contentHash!==proposal.expectedContentHash||!isDeepStrictEqual(sourceBinding(store.getRecord(data.originRunId)),data.sourceBinding))fail();
   let content,config,expectedUrls;if(proposal.kind==='native-rollback'){const target=rollbackVersions(page).find(v=>v.id===data.targetVersionId);if(!target||!isDeepStrictEqual(snapshot(target.snapshot),data.target))fail();content=data.target.content;config=data.target.config;expectedUrls=target.snapshot.expectedUrls;}else{content=applyNativeReplacement(before.content,data.transform,{expectedMarker:page.expectedMarker||'pp-landing'});config=page.config;expectedUrls=data.transform.expectedUrls;}
   store.confirmProposal(id,body.expectedRevision);const after={...before,content,config};after.contentHash=before.contentHash===nativeHash(before)?nativeHash(after):bridgeContentHash(after);
   const record=store.createRecord(page.projectId,'native_update',{state:'queued',stage:'publishing',phase:'queued',pageId:page.id,siteId:page.siteId,originRunId:data.originRunId,sourceBinding:data.sourceBinding,jobId:null,checkJobId:null,postId:page.wpId,url:page.fullUrl});
   const job=store.enqueueJob({projectId:page.projectId,siteId:page.siteId,pageId:page.id,type:'replace',idempotencyKey:'proposal:'+id,payload:{mode:'native-update',nativeUpdateId:record.id,proposalId:id,expectedRevision:page.revision,before,after,config,expectedUrls,expectedMarker:page.expectedMarker||'pp-landing'}});update(record.id,{jobId:job.id});return job;
  });}
 function bindingGuard(job,{lease=true,credentials}={}){const record=store.getRecord(job.payload.nativeUpdateId),page=pageFor(job.pageId),site=store.getSite(job.siteId),current=store.getJob(job.id);if(!record||record.kind!=='native_update'||record.jobId!==job.id||publicationTurn.owner()?.id!==record.id||record.pageId!==page.id||record.siteId!==site?.id||!site||site.enabled===false||site.bootstrap?.mode!=='browser'||!store.siteBelongsToProject(page.projectId,site.id)||page.siteId!==job.siteId||page.wpId!==record.postId||page.fullUrl!==record.url||page.revision!==job.payload.expectedRevision||!isDeepStrictEqual(snapshot(page),job.payload.before)||!isDeepStrictEqual(sourceBinding(store.getRecord(record.originRunId)),record.sourceBinding))fail();
  if(store.getProject(page.projectId)?.archived||store.getRecord('queue-control:'+page.projectId)?.paused)fail();
  if(lease&&(current.state!=='running'||current.attempt!==job.attempt||job.leaseToken===undefined||Date.parse(current.leaseUntil)<=clock()))fail('LEASE_CONFLICT');
  if(credentials&&!isDeepStrictEqual(credentials,store.getBrowserCredentials(site.id)))fail();beforeRemoteWrite(job);return {record,page,site};
 }
 function checkpoint(job,value){const r=store.getRecord(job.payload.nativeUpdateId);if(value.operationId!==job.id||value.postId!==r.postId||value.url!==r.url||!['prepared','dispatching','published'].includes(value.phase))fail();if(['dispatching','published'].includes(r.phase)&&value.phase==='prepared')fail();return update(r.id,{phase:value.phase,state:value.phase==='published'?'running':r.state,checkpointAt:new Date(clock()).toISOString()});}
 function accept(job,result){const after=job.payload.after;if(!result||['postId','url','title','content','status'].some(k=>result[k]!==after[k]))fail('NATIVE_UPDATE_UNCERTAIN',{uncertain:true});
  return store.atomic(()=>{const page=pageFor(job.pageId),r=store.getRecord(job.payload.nativeUpdateId);if(page.siteId!==job.siteId||page.wpId!==r.postId||page.fullUrl!==r.url||page.revision!==job.payload.expectedRevision||!isDeepStrictEqual(snapshot(page),job.payload.before))fail('NATIVE_UPDATE_UNCERTAIN',{uncertain:true});
   const done=store.completeRemoteWrite(job.id,{...(job.leaseToken?{leaseToken:job.leaseToken}:{}),expectedPageRevision:page.revision,patch:{config:job.payload.config,remoteSnapshot:{...after,operationId:job.id},expectedUrls:job.payload.expectedUrls,expectedMarker:job.payload.expectedMarker,lifecycleState:'published'},result:{postId:after.postId,url:after.url,contentHash:after.contentHash,pageRevision:page.revision+1,verification:'pending'}});
   const check=store.enqueueJob({projectId:page.projectId,siteId:page.siteId,pageId:page.id,type:'page_check',payload:{nativeUpdateId:r.id,nativeCheckAttempt:1},idempotencyKey:'verify:'+job.id});update(r.id,{state:'checking',stage:'checking',phase:'published',publishedRevision:page.revision+1,contentHash:after.contentHash,checkJobId:check.id,checkAttempts:1,checkStatus:{state:'pending',code:'NATIVE_CHECK_PENDING',attempt:1,limit:3},comparison:null,error:null,accessRequired:false,manualResume:false});return done;
  });
 }
 async function execute(job,reconcile=false){let dispatched=false,heartbeat=null,guardError=null;const r=store.getRecord(job.payload.nativeUpdateId);try{
   if(!reconcile&&r.phase!=='queued'&&r.phase!=='prepared')fail('NATIVE_UPDATE_UNCERTAIN',{uncertain:true});
   const credentials=store.getBrowserCredentials(job.siteId);if(!credentials?.username||!credentials.applicationPassword)fail('NATIVE_ACCESS_REQUIRED');
   const guard=()=>{
    if(reconcile){
     const current=store.getJob(job.id);
     if(!canReadUncertainUpdate(store.getRecord(r.id),current,job.attempt))fail('CONFLICT');
    }
    return bindingGuard(job,{lease:!reconcile,credentials});
   };
   const {site}=store.atomic(()=>{const target=guard();update(r.id,{state:reconcile?'uncertain':'running'});return target;});
   if(!reconcile&&store.renewJob){heartbeat=setInterval(()=>{try{bindingGuard(job,{credentials});store.renewJob(job.id,job.leaseToken,180000);}catch(error){guardError=error;}},30000);heartbeat.unref?.();}
   const session=await openSession(r.id,site.baseUrl);guard();await session.login(credentials);guard();
   const input={saved:{postId:r.postId,url:r.url},before:job.payload.before,after:job.payload.after,operationId:job.id,checkpoint:value=>store.atomic(()=>{guard();return checkpoint(job,value);}),beforeSend:()=>{if(guardError)throw guardError;if(reconcile)fail();guard();dispatched=true;},observe:()=>{try{guard();}catch(error){guardError=error;}}};
   const result=await session[reconcile?'reconcileUpdate':'updatePublished'](input);if(guardError)throw guardError;
   return store.atomic(()=>{guard();return accept(job,result);});
  }catch(error){const phase=store.getRecord(r.id)?.phase,manual=!reconcile&&!dispatched&&['queued','prepared'].includes(phase)&&['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code),uncertain=!manual&&(reconcile||dispatched||['dispatching','published'].includes(phase)||error.uncertain===true);error.uncertain=uncertain;if(uncertain)delete error.writeNotAttempted;else error.writeNotAttempted=true;
   const observed=observedComparison(error),external=error.code==='NATIVE_UPDATE_CONFLICT'&&!!observed.actual,comparison=external||uncertain&&(dispatched||['dispatching','published'].includes(phase))?{expected:{title:job.payload.before.title.slice(0,300),status:job.payload.before.status,contentHash:hash(job.payload.before.content)},proposed:{contentHash:hash(job.payload.after.content)},...(external?observed:{}),code:typeof error.code==='string'?error.code:'NATIVE_UPDATE_UNCERTAIN'}:null;
   store.atomic(()=>{
    const current=store.getJob(job.id);
    const currentAttempt=reconcile?canReadUncertainUpdate(store.getRecord(r.id),current,job.attempt):
     current.attempt===job.attempt&&current.state==='running'&&Date.parse(current.leaseUntil)>clock();
    if(!currentAttempt)return;
    update(r.id,{state:manual?'waiting_manual':uncertain?'uncertain':'failed',manualResume:manual,accessRequired:!uncertain&&!manual&&['bootstrap_auth_failed','auth_failed','BROWSER_AUTH_FAILED'].includes(error.code),error:{code:typeof error.code==='string'?error.code:'NATIVE_UPDATE_UNCERTAIN'},comparison});
   });
   throw error;}finally{if(heartbeat)clearInterval(heartbeat);}
 }
 const perform=job=>execute(job,false);
 async function reconcile(job){
  const current=store.getJob(job.id),record=store.getRecord(job.payload.nativeUpdateId);
  if(!canReadUncertainUpdate(record,current,job.attempt))fail();
  return execute({...job,leaseToken:undefined},true);
 }
 const expiredUnsent=(record,job)=>job.state==='uncertain'&&job.error?.code==='LEASE_EXPIRED_UNCERTAIN'&&['queued','prepared'].includes(record.phase);
 function canReadUncertainUpdate(record,job,attempt){
  return boundNativeJob(record,job)&&job.state==='uncertain'&&job.attempt===attempt&&
   !(record.state==='waiting_manual'&&record.manualResume===true)&&!(job.attempt<3&&expiredUnsent(record,job));
 }
 function canResume(record){const job=optionalJob(record?.jobId);return !!(boundNativeJob(record,job)&&record.state==='waiting_manual'&&record.manualResume===true&&['queued','prepared'].includes(record.phase)&&job.attempt<3&&(job.state==='failed'&&job.result?.writeNotAttempted===true||expiredUnsent(record,job))&&publicationTurn.owner()?.id===record.id);}
 function resume(jobId){return store.atomic(()=>{const job=store.getJob(jobId),record=job?.payload?.nativeUpdateId&&store.getRecord(job.payload.nativeUpdateId);if(!canResume(record))fail();const credentials=store.getBrowserCredentials(job.siteId);if(!credentials?.username||!credentials.applicationPassword)fail('NATIVE_ACCESS_REQUIRED');bindingGuard(job,{lease:false,credentials});const reconsidered=job.state==='failed'?store.reconsiderFailedWrite(job.id,job.revision):job,absent=store.markWriteAbsent(job.id,reconsidered.revision),queued=store.retryUncertainJob(job.id,{expectedRevision:absent.revision,verifiedAbsent:true});update(record.id,{state:'queued',stage:'publishing',manualResume:false,resumeProof:'known_unsent_checkpoint',error:null});return queued;});}
 function verifiedCheck(record){const page=store.getPage(record.pageId);if(page?.verification?.state!=='ok'||page.revision!==record.publishedRevision||page.siteId!==record.siteId||page.wpId!==record.postId||page.fullUrl!==record.url||page.remoteSnapshot?.contentHash!==record.contentHash)return null;return store.listJobs(record.projectId).filter(j=>j.type==='page_check'&&j.pageId===record.pageId&&j.siteId===record.siteId&&j.state==='completed'&&j.result?.verification?.state==='ok'&&j.result.verification.checkedRevision===record.publishedRevision&&j.result.verification.contentHash===record.contentHash).at(-1)||null;}
 function checkBinding(record){const page=store.getPage(record.pageId),site=store.getSite(record.siteId);return !!(publicationTurn.owner()?.id===record.id&&page?.revision===record.publishedRevision&&page.siteId===record.siteId&&page.wpId===record.postId&&page.fullUrl===record.url&&page.remoteSnapshot?.contentHash===record.contentHash&&site?.bootstrap?.mode==='browser'&&site.enabled!==false&&store.siteBelongsToProject(record.projectId,record.siteId)&&isDeepStrictEqual(sourceBinding(store.getRecord(record.originRunId)),record.sourceBinding)&&(!record.proxyBinding||record.proxyBinding.sourceKey===JSON.stringify(record.sourceBinding)));}
 function observePendingCheck(record){return store.atomic(()=>{const current=store.getRecord(record.id);if(current.state!=='checking'||current.checkJobId!==record.checkJobId)return;
  const attempt=current.checkAttempts===undefined?1:current.checkAttempts,setStatus=(state,code)=>{const checkStatus={state,code,attempt:Number.isSafeInteger(attempt)?attempt:0,limit:3};if(!isDeepStrictEqual(current.checkStatus,checkStatus)||current.checkAttempts===undefined)update(current.id,{checkAttempts:attempt,checkStatus});};
  if(!Number.isSafeInteger(attempt)||attempt<1||attempt>3){setStatus('unknown','NATIVE_CHECK_COUNTER_INVALID');return;}
  if(!checkBinding(current)){setStatus('unknown','NATIVE_CHECK_BINDING_CHANGED');return;}
  if(store.getProject(current.projectId)?.archived||store.getRecord('queue-control:'+current.projectId)?.paused){setStatus('unknown','NATIVE_CHECK_PAUSED');return;}
  const page=store.getPage(current.pageId),check=optionalJob(current.checkJobId);if(!check||check.type!=='page_check'||check.pageId!==current.pageId||check.siteId!==current.siteId||check.projectId!==current.projectId||check.payload?.nativeUpdateId!==current.id){setStatus('unknown','NATIVE_CHECK_BINDING_CHANGED');return;}
  const verification=check.result?.verification;
  if(page.verification?.state==='problem'||verification?.state==='problem'){setStatus('problem','NATIVE_CHECK_PROBLEM');return;}
  if(['queued','running','paused'].includes(check.state)){setStatus('pending','NATIVE_CHECK_PENDING');return;}
  const exactObservation=verification?.checkedRevision===current.publishedRevision&&verification.contentHash===current.contentHash;
  const transientFailure=check.state==='failed'&&['network_error','network_failed','network_timeout','timeout','INTERNAL','BROWSER_TIMEOUT','BROWSER_UNAVAILABLE','browser_unavailable','browser_timeout'].includes(check.error?.code);
  if(!(check.state==='completed'&&exactObservation&&verification.state==='unknown')&&!transientFailure){setStatus('unknown','NATIVE_CHECK_FAILED');return;}
  if(attempt>=3){setStatus('unknown','NATIVE_CHECK_RETRIES_EXHAUSTED');return;}
  if(store.listJobs(current.projectId).some(j=>j.type==='page_check'&&j.pageId===current.pageId&&j.siteId===current.siteId&&['queued','running','paused'].includes(j.state))){setStatus('pending','NATIVE_CHECK_PENDING');return;}
  const nextAttempt=attempt+1,job=store.enqueueJob({projectId:current.projectId,siteId:current.siteId,pageId:current.pageId,type:'page_check',payload:{nativeUpdateId:current.id,nativeCheckAttempt:nextAttempt,expectedRevision:current.publishedRevision,contentHash:current.contentHash,postId:current.postId},idempotencyKey:'native-check:'+current.id+':'+nextAttempt});update(current.id,{checkJobId:job.id,checkAttempts:nextAttempt,checkStatus:{state:'pending',code:'NATIVE_CHECK_PENDING',attempt:nextAttempt,limit:3}});
 });}
 async function closeOwned(record){if(publicationTurn.owner()?.id!==record.id)return false;try{await finishSession(record.id);}catch(error){update(record.id,{sessionCloseError:{code:typeof error?.code==='string'&&/^[A-Za-z_]{1,50}$/.test(error.code)?error.code:'BROWSER_CLOSE_UNCONFIRMED'}});return false;}return publicationTurn.owner()?.id===record.id;}
 function recoverUnsentUpdate(record,job){
  if(!expiredUnsent(record,job)||job.attempt>=3||publicationTurn.owner()?.id!==record.id)return false;
  return store.atomic(()=>{
   const current=store.getJob(job.id),latest=store.getRecord(record.id);
   if(current.revision!==job.revision||latest.revision!==record.revision)return false;
   // WordPress writes are gated on a committed dispatching checkpoint. An
   // expired lease while still prepared proves this attempt never reached it.
   try{bindingGuard(current,{lease:false});}catch(error){if(['CONFLICT','NOT_FOUND'].includes(error.code))return false;throw error;}
   const absent=store.markWriteAbsent(job.id,current.revision);
   store.retryUncertainJob(job.id,{expectedRevision:absent.revision,verifiedAbsent:true});
   update(record.id,{state:'queued',stage:'publishing',manualResume:false,resumeProof:'known_unsent_checkpoint',error:null});
   return true;
  });
 }
 function sync(){if(syncing)return syncing;syncing=(async()=>{for(const r of records()){
   const job=optionalJob(r.jobId);if(!boundNativeJob(r,job))continue;if(r.state==='completed'){if(job.state!=='completed')continue;if(r.comparison||r.error)update(r.id,{comparison:null,error:null});if(publicationTurn.owner()?.id===r.id&&await closeOwned(r))publicationTurn.complete(r.id);}
   else if(r.state==='waiting_manual'&&r.manualResume===true)continue;
   else if(recoverUnsentUpdate(r,job))continue;
   else if(job.state==='uncertain'&&r.state!=='uncertain')store.atomic(()=>{
    if(store.getJob(job.id).revision===job.revision&&store.getRecord(r.id).revision===r.revision)update(r.id,{state:'uncertain'});
   });
   else if(job?.state==='failed'&&job.result?.writeNotAttempted===true&&['queued','prepared'].includes(r.phase)){
    if(r.state!=='failed')update(r.id,{state:'failed'});if(!await closeOwned(r))continue;store.atomic(()=>{const latest=store.getRecord(r.id),current=optionalJob(r.jobId);if(latest.state==='failed'&&!latest.manualResume&&['queued','prepared'].includes(latest.phase)&&current?.state==='failed'&&current.result?.writeNotAttempted===true)publicationTurn.releaseUnsent?.(r.id);});
   }else if(r.state==='checking'&&verifiedCheck(r)){
    if(!await closeOwned(r))continue;store.atomic(()=>{const latest=store.getRecord(r.id),check=verifiedCheck(latest);if(latest.state==='checking'&&check&&publicationTurn.owner()?.id===r.id&&isDeepStrictEqual(sourceBinding(store.getRecord(latest.originRunId)),latest.sourceBinding)){update(r.id,{state:'completed',stage:'completed',checkJobId:check.id,checkStatus:{state:'ok',code:'NATIVE_CHECK_VERIFIED',attempt:latest.checkAttempts||1,limit:3},sessionFinishedAt:new Date(clock()).toISOString(),sessionCloseError:null,comparison:null,error:null});publicationTurn.complete(r.id);}});
   }else if(r.state==='checking')observePendingCheck(r);
  }
  if(!publicationTurn.owner()){const next=records().find(r=>{const job=optionalJob(r.jobId);return r.state==='queued'&&boundNativeJob(r,job)&&job.state==='queued'&&!store.getProject(r.projectId)?.archived&&!store.getRecord('queue-control:'+r.projectId)?.paused;});if(next)publicationTurn.claim(next);}
 })().finally(()=>{syncing=null;});return syncing;}
 function allowedWriteJobId(){const owner=publicationTurn.owner();if(!owner)return undefined;const job=optionalJob(owner.jobId);if(owner.kind!=='native_update')return job?.effect==='write'&&job.state==='queued'?job.id:null;return owner.state==='queued'&&boundNativeJob(owner,job)&&job.state==='queued'?job.id:null;}
 async function handle(request,route,read){const pageRoute=route.match(/^\/pages\/([a-zA-Z0-9-]+)\/(placements|proposals|rollback-versions|rollback-proposals|native-access|replacement-status)$/);if(pageRoute){const page=pageFor(pageRoute[1]);if(page.remoteSnapshot?.mode!=='browser')return null;const action=pageRoute[2];if(request.method==='GET'){if(action==='placements')return response(placements(page));if(action==='rollback-versions')return response({pageRevision:page.revision,versions:rollbackVersions(page).map(v=>({id:v.id,revision:v.revision,title:v.snapshot.title,status:'publish',createdAt:v.createdAt}))});if(action==='replacement-status'){const r=records().filter(r=>r.pageId===page.id).at(-1);return response({replacement:availability(page),update:r?{id:r.id,jobId:r.jobId,state:r.state,phase:r.phase,canResume:canResume(r),checkStatus:r.checkStatus||null,comparison:r.comparison||null}:null});}}
    if(request.method==='POST'){const body=await read(request);if(action==='proposals')return response({proposal:prepareReplacement(page.id,body)},201);if(action==='rollback-proposals')return response({proposal:prepareRollback(page.id,body)},201);if(action==='native-access'){fields(body,['expectedRevision','username','password']);const site=store.getSite(page.siteId);if(page.revision!==body.expectedRevision||site?.bootstrap?.mode!=='browser'||typeof body.username!=='string'||!body.username.trim()||typeof body.password!=='string'||!body.password)fail('VALIDATION');store.atomic(()=>{store.updateSite(site.id,{username:body.username,applicationPassword:body.password},site.revision);const last=records().filter(r=>r.pageId===page.id).at(-1);if(last?.accessRequired)update(last.id,{accessRequired:false});});return response({replacement:availability(page)});}}
   }
  const confirm=route.match(/^\/proposals\/([a-zA-Z0-9-]+)\/confirm$/);if(confirm&&request.method==='POST'&&['native-links','native-rollback'].includes(store.getProposal(confirm[1])?.kind))return response({job:confirmReplacement(confirm[1],await read(request))},202);
  const manualResume=route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/native-resume$/);if(manualResume&&request.method==='POST'){fields(await read(request),[]);const job=resume(manualResume[1]);await sync();return response({job},202);}
  const recovery=route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/(reconcile|retry)$/);if(recovery&&request.method==='POST'){const job=store.getJob(recovery[1]);if(job?.payload?.mode==='native-update'){fields(await read(request),[]);if(recovery[2]==='retry')fail('NATIVE_RECONCILE_REQUIRED');const reconciled=await reconcile(job);await sync();return response({job:reconciled});}}
  return null;
 }
 return {availability,decoratePage,placements,prepareReplacement,confirmReplacement,prepareRollback,rollbackVersions,perform,reconcile,resume,canResume,sync,allowedWriteJobId,handle};
}
