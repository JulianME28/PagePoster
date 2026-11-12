import {listExactPlacements,proposeExactReplacement,applyExactReplacement} from './exact-import.mjs';
import path from 'node:path';
import {createBrowserVerifier} from './browser-check.mjs';
import {createScopedPlacementRegistry} from './placement-dom.mjs';
import {renderPage} from './render.mjs';
import {createBridgeClient,bridgeContentHash} from './bridge-client.mjs';
import {createWordPressClient} from './wordpress.mjs';
import {isDeepStrictEqual} from 'node:util';
const registry=createScopedPlacementRegistry();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(body,names)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!names.includes(k)))fail('VALIDATION');return body;};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export function prepareConfig(config){if(config?.contentMode==='exact-import')return renderPage(config).config;return registry.prepare(renderPage(config).config).config;}
export function createWorkflow({store,bridge=createBridgeClient(),maxPages=1000,client=createWordPressClient(),verifier=createBrowserVerifier(),artifactRoot,clock=Date.now,beforePublish=()=>{},beforeRemoteWrite=()=>{},browserSubmit=()=>null}){
 let nativeReplacements=null;
 const pageFor=id=>{const p=store.getPage(id);if(!p)fail('NOT_FOUND');return p;};
 const siteFor=(id,projectId)=>{const s=store.getSite(id);if(!s||!store.siteBelongsToProject(projectId,id))fail('NOT_FOUND');if(s.enabled===false)fail('disabled');if(!s.hasCredential)fail('auth_failed');return s;};
 const credentialSite=s=>({baseUrl:s.baseUrl,...store.getSiteCredentials(s.id)});
 const event=(p,type,message)=>store.recordEvent({projectId:p.projectId,entityId:p.id,type,message});
 function noPending(page){if(store.listJobs(page.projectId).some(j=>j.pageId===page.id&&j.effect==='write'&&['queued','running','uncertain','paused'].includes(j.state)))fail('CONFLICT');}
 function rollbackVersions(page){const seen=new Set();return (page.versions||[]).filter(v=>{const snapshot=v.snapshot?.remoteSnapshot;if(!snapshot||snapshot.postId!==page.wpId||v.snapshot.siteId!==page.siteId||snapshot.contentHash===page.remoteSnapshot?.contentHash||seen.has(snapshot.contentHash)||!isDeepStrictEqual(v.snapshot.config,snapshot.config))return false;seen.add(snapshot.contentHash);return bridgeContentHash(snapshot)===snapshot.contentHash;});}
 function operation(job){return {...job.payload.operation,operationId:job.id};}
 function accept(job,result){
  const current=store.getJob(job.id);if(current.state==='completed')return current;
  const sent=operation(job);if(result.state!=='completed')fail('CONFLICT');
  if(result.contentHash!==bridgeContentHash(sent)||result.postType!==sent.postType||result.status!==sent.status||(sent.kind==='update'&&result.postId!==sent.postId))throw Object.assign(Error('Unverified remote result'),{code:'pp_bridge_uncertain',uncertain:true});
  const page=pageFor(job.pageId),site=store.getSite(job.siteId);
  if(!site||!store.siteBelongsToProject(page.projectId,site.id)||page.siteId!==job.siteId)fail('CONFLICT');
  if(new URL(result.url).origin!==new URL(site.baseUrl).origin)throw Object.assign(Error('Unverified URL'),{code:'pp_bridge_uncertain',uncertain:true});
  if(page.wpId&&page.wpId!==result.postId)throw Object.assign(Error('Remote association conflict'),{code:'pp_bridge_uncertain',uncertain:true});
  const localChanged=page.revision!==job.payload.expectedRevision;
  const remoteSnapshot={operationId:job.id,postId:result.postId,postType:sent.postType,title:sent.title,content:sent.content,status:sent.status,contentHash:result.contentHash,config:job.payload.config,...(typeof result.modifiedGmt==='string'?{modifiedGmt:result.modifiedGmt}:{})};
  const patch={wpId:result.postId,wpType:sent.postType,fullUrl:result.url,remoteSnapshot,lifecycleState:localChanged?'review_required':sent.status==='publish'?'published':'draft',expectedUrls:job.payload.expectedUrls,expectedMarker:job.payload.expectedMarker||page.expectedMarker||'pp-landing'};
  if(!localChanged)patch.config=job.payload.config;
  return store.completeRemoteWrite(job.id,{...(job.leaseToken?{leaseToken:job.leaseToken}:{}),expectedPageRevision:page.revision,patch,result:{...result,localChanged,pageRevision:page.revision+1,verification:'pending'}});
 }
 async function perform(job,site,credentials){
  // Only a conflict before the first bridge dispatch proves that this job never wrote.
  let dispatchStarted=false;const revisionConflict=()=>{throw Object.assign(Error('CONFLICT'),{code:'CONFLICT',writeNotAttempted:!dispatchStarted&&job.attempt===1});};
  const page=pageFor(job.pageId);if(page.siteId!==job.siteId||page.revision!==job.payload.expectedRevision)revisionConflict();
  if(job.type==='replace'){const proposal=store.getProposal(job.payload.proposalId);if(!proposal||proposal.state!=='confirmed'||proposal.expectedPageRevision!==page.revision)fail('CONFLICT');}
  if(job.type==='replace'){
   const checks=await client.checkPage({site:{baseUrl:site.baseUrl,...credentials},page});
   for(const check of checks)store.addCheck(page.id,{kind:check.kind,state:check.state,evidence:check.evidence});
   const required=['wp_access','wp_status','wp_content',...(page.remoteSnapshot?.status==='publish'?['public','content','noindex','robots','links']:[])];
   if(required.some(kind=>!checks.some(c=>c.kind===kind&&c.state==='ok')))fail('PRECHECK_FAILED');
  }
  const preview=await verifier.verifyGenerated({html:job.payload.operation.content,expectedUrls:job.payload.expectedUrls,expectedMarker:job.payload.expectedMarker||page.expectedMarker||'pp-landing',...(artifactRoot?{artifactDir:path.join(artifactRoot,page.id)}:{})});
  const screenshots=(preview.viewports||[]).filter(v=>v.screenshot?.path).map(v=>({name:v.name,url:'/api/lifecycle/pages/'+page.id+'/screenshots/'+path.basename(v.screenshot.path)}));
  store.addCheck(page.id,{kind:'layout',state:preview.layoutState,evidence:{scope:'offline-generated-html',screenshots,checks:(preview.viewports||[]).map(v=>({name:v.name,checks:v.checks})),limitation:'Offline layout only; live WordPress rendering and scripts are not verified.'}});
  if(preview.layoutState==='problem')fail('PRECHECK_FAILED');
  const beforeSend=()=>{
   beforeRemoteWrite(job);
   const current=store.getJob(job.id),currentPage=pageFor(job.pageId),currentSite=siteFor(job.siteId,page.projectId);
   if(current.state!=='running'||!current.leaseUntil||Date.parse(current.leaseUntil)<=clock())fail('CONFLICT');
   if(currentPage.revision!==job.payload.expectedRevision||currentPage.siteId!==job.siteId)revisionConflict();
   if(!isDeepStrictEqual(store.getSiteCredentials(currentSite.id),credentials))fail('CONFLICT');
  };
  beforeSend();
  const submitInBrowser=browserSubmit(job);
  const result=await bridge.submitOperation({site:{baseUrl:site.baseUrl,...credentials},operation:operation(job),...(submitInBrowser?{browserSubmit:submitInBrowser}:{}),beforeSend:()=>{beforeSend();dispatchStarted=true;}});
  if(result.state==='conflict')fail('CONFLICT');
  let completed;
  try{completed=accept(job,result);}catch(error){error.uncertain=true;throw error;}
  if(result.status==='publish'){
   // The durable write is already committed. Failure to enqueue a follow-up must not change its result.
   try{store.enqueueJob({projectId:page.projectId,siteId:site.id,pageId:page.id,type:'page_check',payload:{},idempotencyKey:'verify:'+job.id});}catch{}
  }
  return completed;

 }
 function prepareReplacement(pageId,body){const page=pageFor(pageId);
    if(page.remoteSnapshot?.mode==='browser')return nativeReplacements?.prepareReplacement(pageId,body)??fail('NATIVE_BROWSER_REQUIRED');
    fields(body,['expectedRevision','changes']);if(page.revision!==body.expectedRevision||!page.wpId||!page.remoteSnapshot)fail('CONFLICT');noPending(page);
    if(!isDeepStrictEqual(page.config,page.remoteSnapshot.config))fail('CONFLICT');
    let proposal;
    try{
     if(page.config.contentMode==='exact-import'){
      if(!Array.isArray(body.changes))fail('VALIDATION');
      const placements=new Map(listExactPlacements(page.config).map(place=>[place.id,place]));
      const changes=body.changes.map(change=>{
       fields(change,['id','url','anchor','expectedUrl','expectedAnchor','expectedBinding']);
       const place=placements.get(change.id);
       if(!place||change.expectedUrl!==place.url||change.expectedAnchor!==place.anchor||change.expectedBinding!==place.binding)fail('CONFLICT');
       return {id:change.id,url:change.url,...(change.anchor===undefined?{}:{anchor:change.anchor})};
      });
      proposal=proposeExactReplacement(page.config,changes);
     }else proposal=registry.propose(page.config,body.changes);
    }catch(error){if(typeof error?.code==='string'&&/^IMPORT_[A-Z_]+$/.test(error.code))throw error;fail('CONFLICT');}
    if(!proposal.diff.length)fail('VALIDATION');
    const diff=proposal.diff.map(d=>({id:d.id,label:d.label,role:d.role,before:{url:d.oldUrl,anchor:d.oldAnchor},after:{url:d.newUrl,anchor:d.newAnchor}}));
    const navigationLabel=attribute=>attribute==='href'?'Основне посилання':'Повторна кнопка з переходом';
    for(const change of proposal.linkNormalization||[])diff.push({id:change.id+':navigation',label:change.label+' — спосіб переходу',role:'navigation',before:{url:change.url,anchor:navigationLabel(change.oldAttribute)},after:{url:change.url,anchor:navigationLabel(change.newAttribute)}});
    const saved=store.createProposal(page.id,{expectedPageRevision:page.revision,diff,nextConfig:proposal.nextConfig,registryProposal:proposal,expectedContentHash:page.remoteSnapshot.contentHash,kind:'links'});
    return saved;
 }
 function confirmReplacement(proposalId,body){if(['native-links','native-rollback'].includes(store.getProposal(proposalId)?.kind))return nativeReplacements?.confirmReplacement(proposalId,body)??fail('NATIVE_BROWSER_REQUIRED');return store.atomic(()=>{
   fields(body,['expectedRevision','confirmed']);if(body.confirmed!==true)fail('VALIDATION');
   const before=store.getProposal(proposalId);if(!before)fail('NOT_FOUND');const page=pageFor(before.pageId);
   const existing=store.listJobs(page.projectId).find(j=>j.idempotencyKey==='proposal:'+before.id);if(existing)return existing;
   noPending(page);const proposal=store.confirmProposal(before.id,body.expectedRevision);const site=siteFor(page.siteId,page.projectId);
   if(!page.remoteSnapshot||page.remoteSnapshot.contentHash!==proposal.expectedContentHash)fail('CONFLICT');
   let rendered,title=page.remoteSnapshot.title,status=page.remoteSnapshot.status;
   if(proposal.kind==='rollback'){
    const version=rollbackVersions(page).find(v=>v.id===proposal.registryProposal.targetVersionId);const target=version?.snapshot?.remoteSnapshot;
    if(!target||!isDeepStrictEqual(target,proposal.registryProposal.targetSnapshot))fail('CONFLICT');
    rendered={config:target.config,html:target.content,expectedUrls:version.snapshot.expectedUrls};title=target.title;status=target.status;
   }else{let next;try{next=page.config.contentMode==='exact-import'?applyExactReplacement(page.config,proposal.registryProposal):registry.apply(page.config,proposal.registryProposal);}catch{fail('CONFLICT');}rendered=renderPage(next);}
   const payload={proposalId:proposal.id,expectedRevision:page.revision,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:rendered.expectedMarker||page.expectedMarker,operation:{kind:'update',postId:page.wpId,postType:page.wpType,title,content:rendered.html,status,expectedContentHash:proposal.expectedContentHash}};
   const job=store.enqueueJob({projectId:page.projectId,siteId:site.id,pageId:page.id,type:'replace',payload,idempotencyKey:'proposal:'+proposal.id});event(page,'replacement_confirmed','Пакет заміни підтверджено.');return job;
 });}
 async function handle(request,route,read){
  const nativeResult=await nativeReplacements?.handle(request,route,read);if(nativeResult)return nativeResult;
  const match=route.match(/^\/pages\/([a-zA-Z0-9-]+)\/(publish|placements|proposals|rollback-versions|rollback-proposals)$/);
  if(match){let page=pageFor(match[1]);const action=match[2];
   if(action==='rollback-versions'&&request.method==='GET')return response({pageRevision:page.revision,versions:rollbackVersions(page).map(v=>({id:v.id,revision:v.revision,title:v.snapshot.remoteSnapshot.title,createdAt:v.createdAt,status:v.snapshot.remoteSnapshot.status}))});
   if(action==='placements'&&request.method==='GET')return response({pageRevision:page.revision,placements:page.config.contentMode==='exact-import'?listExactPlacements(page.config):registry.list(page.config)});
   if(request.method!=='POST')return response({code:'NOT_FOUND'},404);
   const body=await read(request);
   if(action==='publish'){
    fields(body,['siteId','mode','expectedRevision','idempotencyKey']);if(!uuid.test(body.idempotencyKey)||!['draft','publish'].includes(body.mode))fail('VALIDATION');
    const prior=store.listJobs(page.projectId).find(j=>j.idempotencyKey===body.idempotencyKey);
    if(prior){if(prior.type!=='publish'||prior.pageId!==page.id||prior.siteId!==body.siteId||prior.payload.mode!==body.mode||prior.payload.requestRevision!==body.expectedRevision)fail('CONFLICT');return response({job:prior},202);}
    page=pageFor(page.id);if(page.revision!==body.expectedRevision||page.wpId)fail('CONFLICT');noPending(page);beforePublish(page);
    
    const site=siteFor(body.siteId,page.projectId);if(page.siteId&&page.siteId!==site.id)fail('CONFLICT');
    const rendered=renderPage(prepareConfig(page.config));
    const receipt=store.commitGeneration('publication:'+body.idempotencyKey,{pageId:page.id,sourceRevision:page.revision,patch:{siteId:site.id,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing'},publication:{idempotencyKey:body.idempotencyKey,mode:body.mode,html:rendered.html,maxPages}});
    const job=store.getJob(receipt.jobId);event(page,'queued','Запуск публікації додано до черги.');return response({job},202);
   }
   if(action==='rollback-proposals'){
    fields(body,['expectedRevision','versionId']);if(page.revision!==body.expectedRevision||!page.wpId||!page.remoteSnapshot||!isDeepStrictEqual(page.config,page.remoteSnapshot.config))fail('CONFLICT');noPending(page);
    const version=rollbackVersions(page).find(v=>v.id===body.versionId);if(!version)fail('CONFLICT');const target=version.snapshot.remoteSnapshot;
    const diff=[['version','Версія',String(page.revision),String(version.revision)],['title','Заголовок',page.remoteSnapshot.title,target.title],['status','Стан у WordPress',page.remoteSnapshot.status,target.status],['content','Повний HTML',page.remoteSnapshot.content,target.content]].map(([id,label,before,after])=>({id,label,before:{url:'',anchor:before},after:{url:'',anchor:after}}));
    const proposal=store.createProposal(page.id,{expectedPageRevision:page.revision,diff,nextConfig:target.config,registryProposal:{version:1,kind:'rollback',targetVersionId:version.id,targetSnapshot:target},expectedContentHash:page.remoteSnapshot.contentHash,kind:'rollback'});
    return response({proposal},201);
   }
   if(action==='proposals'){
    return response({proposal:prepareReplacement(page.id,body)},201);
   }
  }
  const confirm=route.match(/^\/proposals\/([a-zA-Z0-9-]+)\/confirm$/);
  if(confirm&&request.method==='POST'){
   return response({job:confirmReplacement(confirm[1],await read(request))},202);
  }
  const reconcile=route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/(reconcile|retry)$/);
  if(reconcile&&request.method==='POST'){
   fields(await read(request),[]);const job=store.getJob(reconcile[1]);if(!job)fail('NOT_FOUND');if(job.state!=='uncertain'||job.effect!=='write'||reconcile[2]==='retry'&&store.getProject(job.projectId)?.archived)fail('CONFLICT');const site=siteFor(job.siteId,job.projectId);
   const result=await bridge.getOperation({site:credentialSite(site),operationId:job.id});
   if(result.state==='completed')return response({job:accept(job,result)});
   if(result.state==='conflict')return response({job:store.reconcileJob(job.id,{state:'failed',error:{code:'CONFLICT'}})});
   if(result.state==='not_found'){const absent=store.markWriteAbsent(job.id,job.revision);return response({job:reconcile[2]==='retry'?store.retryUncertainJob(job.id,{expectedRevision:absent.revision,verifiedAbsent:true}):absent});}
   return response({job});
  }
  return null;
 }
 return {handle,perform,prepareReplacement,confirmReplacement,attachNativeReplacements:controller=>{nativeReplacements=controller;}};
}
