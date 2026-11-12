import {randomUUID,createHash} from 'node:crypto';
import {normalizeImportItems,createProjectImporter,publicImportProvenance} from './project-import.mjs';
import {requirementsMetadata,changeQueueRequirements} from './queue-requirements.mjs';
import {publishedCheckError} from './published-diagnostics.mjs';
import {publicDonorSkip,publicPublication} from './publication-diagnostics.mjs';
import {isPreCreationDonorFailure} from './publication-recovery.mjs';
import {createPreparedArchive,MAX_PREPARED_PAGES} from './prepared-archive.mjs';
const ITEM='project_queue_item',BATCH='project_queue_batch',CONTROL='project_queue_control';
const terminal=new Set(['completed','deleted']);
const importReadErrors={GOOGLE_RATE_LIMITED:'Google тимчасово обмежив читання джерела. Повторні спроби вичерпано; повторіть імпорт пізніше.',GOOGLE_READ_ABORTED:'Читання джерела Google скасовано. Повторіть імпорт, коли будете готові.'};
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
function fields(body,keys){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail('IMPORT_VALIDATION','Перевірте поля імпорту.');return body;}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Source coordinates and parsing notes are descriptive metadata. Keep existing
// pre-provenance snapshots and replay receipts bound to exactly the same content.
const semanticInput=({provenance,...input})=>input;
export function createProjectQueue({store,autopilot,clock=Date.now,manualPublishedReview=false,publishedTrash=null,openWordPressEditor=null,importer=createProjectImporter({getAccount:()=>autopilot.googleAccount(),getAccessToken:()=>autopilot.googleAccessToken?.()??null})}){
 let feeding=false,lastProject=null;const approvalEpoch=randomUUID();
 const items=()=>store.listProjects().flatMap(p=>store.listRecords(p.id,ITEM));
 const control=id=>store.getRecord('queue-control:'+id)||{paused:false,priority:0};
 const fromRun=run=>({id:run.id,key:run.id,batchId:null,projectId:run.projectId,runId:run.id,state:run.state,updatedAt:run.updatedAt,input:{title:run.title||'',source:run.source||'ai',language:run.language||run.editorial?.language||'en',siteSelection:run.siteSelection||{minDr:null,minTraffic:null,geo:''}}});
 const itemFor=id=>{const value=store.getRecord(id);if(value?.kind==='autopilot'&&!value.deletedAt){const bound=value.queueItemId&&store.getRecord(value.queueItemId);return bound?.kind===ITEM&&bound.runId===value.id&&bound.projectId===value.projectId?bound:fromRun(value);}if(!value||value.kind!==ITEM)fail('NOT_FOUND','Сторінку в черзі не знайдено.');return value;};
 function publishedReview(page,run){
  const trash=publishedTrash?.view(page,run);
  if(trash?.state==='trashed')return trash;
  if(!manualPublishedReview||!page?.fullUrl||!Number.isSafeInteger(page.wpId)||page.wpId<1||page.remoteSnapshot?.status!=='publish'||run&&(run.state!=='completed'||run.deletedAt||run.nativeCleanup))return null;
  const site=page.siteId&&store.getSite(page.siteId);
  let editorUrl;
  try{
   const base=new URL(site.baseUrl),publicUrl=new URL(page.fullUrl);
   if(!['http:','https:'].includes(base.protocol)||base.username||base.password||publicUrl.username||publicUrl.password||publicUrl.origin!==base.origin)return null;
   base.pathname=base.pathname.replace(/\/?$/,'/');
   const editor=new URL('wp-admin/post.php',base);editor.searchParams.set('post',page.wpId);editor.searchParams.set('action','edit');editorUrl=editor.href;
  }catch{return null;}
  const review=store.getRecord('published-review:'+page.id);
  const canOpenEditor=!!openWordPressEditor&&site.enabled!==false&&site.bootstrap?.mode==='browser'&&site.hasBrowserCredential&&editorUrl.startsWith('https://')&&store.siteBelongsToProject(page.projectId,site.id);
  return {state:review?.pageRevision===page.revision?review.state:'pending',editorUrl,canOpenEditor,...trash};
 }
 function publishedReviewTarget(id){
  const record=store.getRecord(id),run=record?.kind===ITEM?(record.runId&&store.getRecord(record.runId)):record?.kind==='autopilot'?record:null;
  const page=store.getPage(run?.pageId||id),project=page&&store.getProject(page.projectId);
  if(!page||!project||project.archived)fail('NOT_FOUND','Опубліковану сторінку не знайдено.');
  const owner=run||store.listRecords(page.projectId,'autopilot').find(value=>value.pageId===page.id);
  return {page,owner,review:publishedReview(page,owner)};
 }
 async function openPublishedEditor(id,body){
  fields(body,['expectedPageRevision']);
  const {page,owner,review}=publishedReviewTarget(id);
  if(page.revision!==body.expectedPageRevision)fail('CONFLICT','Сторінка змінилася. Оновіть список і відкрийте її ще раз.');
  if(!review?.canOpenEditor)fail('CONFLICT','Для автоматичного входу потрібен збережений доступ до WordPress.');
  const site=store.getSite(page.siteId);
  const assertCurrent=()=>{
   const current=publishedReviewTarget(id);
   if(!current.review?.canOpenEditor||current.page.id!==page.id||current.page.revision!==page.revision||current.review.editorUrl!==review.editorUrl||store.getSite(page.siteId)?.revision!==site.revision)fail('CONFLICT','Сторінка або її доступ змінилися. Оновіть список і відкрийте її ще раз.');
  };
  await openWordPressEditor({page,site,owner,assertCurrent});
  return {opened:true};
 }
 function savePublishedReview(id,body){
  fields(body,['decision','expectedPageRevision']);
  if(!['approved','declined'].includes(body.decision)||!Number.isSafeInteger(body.expectedPageRevision))fail('IMPORT_VALIDATION','Оберіть рішення для опублікованої сторінки.');
  return store.atomic(()=>{
   const {page,owner,review}=publishedReviewTarget(id);
   if(body.decision==='declined'&&review?.state==='trashed'&&publishedTrash.get(page.id)?.pageRevision===body.expectedPageRevision)return {manualReview:review};
   if(!review||page.revision!==body.expectedPageRevision)fail('CONFLICT','Сторінка змінилася. Відкрийте її ще раз перед підтвердженням.');
   if(body.decision==='declined'&&publishedTrash)return {manualReview:{...review,...publishedTrash.schedule(page,owner)}};
   if(['trash_queued','trash_uncertain','trashed'].includes(review.state))fail('CONFLICT','Спочатку дочекайтеся результату перенесення в кошик.');
   const key='published-review:'+page.id,previous=store.getRecord(key),patch={pageId:page.id,pageRevision:page.revision,state:body.decision,reviewedAt:new Date(clock()).toISOString()};
   if(previous)store.updateRecord(key,patch,previous.revision);else store.createRecord(page.projectId,'published_review',patch,key);
   return {manualReview:{...review,state:body.decision}};
  });
 }
 function canRetryPublishing(run,page,projectId){
  if(!run||run.deletedAt||run.publicationMode!=='native'||run.stage!=='publishing'||run.jobId||run.checkJobId||!page||page.wpId||page.fullUrl)return false;
  const stopped=['failed','needs_attention'].includes(run.state),draft=run.nativePublication,evidence=run.publicationEvidence;
  const [publish,create]=run.publicationDiagnostics?.slice(-2)||[];
  // Older builds logged the blocked Create navigation without a separate
  // not-started flag. Require the final completed spans and no write checkpoint.
  const legacyCreateStopped=isPreCreationDonorFailure(run.error?.code)&&publish?.phase==='publish'&&create?.phase==='create'&&[publish,create].every(step=>step.code===run.error.code&&step.endedAt!=null&&step.checkpoint===null);
  const beforeCreate=stopped&&!draft&&!run.nativeCleanup&&(run.nativeCreationNotStarted===true||legacyCreateStopped);
  const readInterrupted=['network_timeout','network_failed','dns_failed','BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE','BROWSER_CLOSED','BROWSER_NOT_OPEN'].includes(run.error?.code);
  // A native Publish must persist the dispatching checkpoint before sending.
  const beforePublish=draft?.phase==='draft'&&Number.isSafeInteger(draft.postId)&&draft.postId>0&&run.nativeSnapshot?.pageRevision===page.revision&&
   ((stopped||run.state==='uncertain')&&readInterrupted||stopped&&['NATIVE_PUBLISH_NOT_SENT','NATIVE_RESULT_UNCERTAIN'].includes(run.error?.code)||run.state==='uncertain'&&run.error?.code==='NATIVE_NOT_PUBLISHED'&&evidence?.observation==='draft'&&evidence.postId===draft.postId&&evidence.destinationRevision===(run.destinationRevision||0));
  return !!((beforeCreate||beforePublish)&&(!run.leaseToken||Date.parse(run.leaseUntil)<=clock())&&(!run.browserPreparing||Date.parse(run.browserPreparingUntil)<=clock())&&!control(projectId).paused&&!store.getProject(projectId)?.archived&&!store.listJobs(projectId).some(job=>job.pageId===page.id&&job.effect==='write'));
 }
 function itemView(item){const run=item.runId&&store.getRecord(item.runId),page=run?.pageId&&store.getPage(run.pageId),candidate=run?.candidate,destination=run&&!run.deletedAt&&autopilot.destinationStatus?.(run.id),crawlBlocked=autopilot.crawlBlocked?.(run,page)===true;return {id:item.id,key:item.key,batchId:item.batchId,title:page?.title||item.input.title||item.key,language:item.input.language,...(item.input.slug?{slug:item.input.slug}:{}),...(item.input.donor?{requestedDonor:item.input.donor}:{}),geo:item.input.siteSelection.geo,source:item.input.source,provenance:publicImportProvenance(item.input.provenance),siteSelection:item.input.siteSelection,state:run?.deletedAt?'deleted':run?.state||item.state,stage:run?.stage||'waiting',runId:run?.id||null,pageId:run?.pageId||null,wpId:page?.wpId||null,publishedStatus:page?.remoteSnapshot?.status||null,fullUrl:page?.fullUrl||'',publication:publicPublication(run,page,{now:clock(),crawlBlocked}),canContinueQueue:crawlBlocked&&autopilot.canContinueCrawlBlocked(run,page),canRecheckPublished:autopilot.canRecheckPublished?.(run,page)===true,pluginFallback:run?.nativePluginFallback?{code:run.nativePluginFallback.code}:null,cleanupPhase:run?.nativeCleanup?.phase||null,verification:page?.verification||null,manualReview:publishedReview(page,run),selectedSite:run?.manualTarget?{baseUrl:run.manualTarget.baseUrl,dr:null,traffic:null,geo:[],manual:true}:candidate?{baseUrl:candidate.baseUrl,dr:candidate.metrics?.dr??null,traffic:candidate.metrics?.traffic??null,geo:candidate.metrics?.geo||[],pinned:run?.donorPinned===true}:null,skippedSites:(run?.donorSkips||[]).map(publicDonorSkip),error:crawlBlocked?null:publishedCheckError(run?.error||item.error,page?.verification),selectionDiagnostics:run?.selectionDiagnostics||null,warnings:run?.warnings||[],canRetry:canRetryPublishing(run,page,item.projectId),canSetDestination:destination?.canSetDestination===true,destinationRevision:destination?.destinationRevision??0,destinationBlockedReason:destination?.destinationBlockedReason||'',donorPinned:run?.donorPinned===true,canApprove:run?.state==='awaiting_review'&&!!page&&!run.jobId&&!store.getProject(item.projectId)?.archived,...requirementsMetadata(item,store,clock()),...(run?{pageRevision:page?.revision||0,updatedAt:run.updatedAt}:{updatedAt:item.updatedAt})};}
 function publishedPageView(page,project){
  const site=page.siteId&&store.getSite(page.siteId),geo=page.config?.geo||project.country||'';
  return {id:page.id,key:page.id,batchId:null,pageId:page.id,runId:null,title:page.title||page.config?.title||page.id,source:page.config?.source||'html',language:page.config?.language||project.language||'en',geo,siteSelection:{minDr:null,minTraffic:null,geo},wpId:page.wpId||null,publishedStatus:page.remoteSnapshot?.status||null,fullUrl:page.fullUrl,publication:publicPublication(null,page,{now:clock()}),state:'completed',stage:'completed',selectedSite:site?{baseUrl:site.baseUrl,dr:null,traffic:null,geo:[]}:null,verification:page.verification,manualReview:publishedReview(page),canApprove:false,canEditRequirements:false,canRetry:false,canSetDestination:false,destinationBlockedReason:'Сторінка вже опублікована.',requirementsRevision:null,readOnly:true,error:null,selectionDiagnostics:null,skippedSites:[],warnings:[],pageRevision:page.revision,updatedAt:page.updatedAt};
 }
 function members(projectId){const imported=store.listRecords(projectId,ITEM),bound=new Set(imported.map(item=>item.runId));return [...imported,...store.listRecords(projectId,'autopilot').filter(run=>!run.deletedAt&&!bound.has(run.id)).map(fromRun)];}
 function readyForProject(run){return !!(run&&!run.deletedAt&&run.pageId&&store.getPage(run.pageId)&&run.state==='awaiting_review'&&(run.candidate||run.manualTarget)&&!run.jobId&&(!run.browserPreparing||Date.parse(run.browserPreparingUntil)<=clock())&&(!run.leaseToken||Date.parse(run.leaseUntil)<=clock())&&(!run.nativePublication||run.nativePublication.phase==='draft'));}
 function publicationPlan(project,list=members(project.id)){
  const entries=[];let blockedReason='';
  if(project.archived)blockedReason='Проєкт закрито.';else if(control(project.id).paused)blockedReason='Проєкт на паузі. Спочатку відновіть його.';
  for(const item of list){const run=item.runId&&store.getRecord(item.runId);if(run?.deletedAt||run?.state==='completed')continue;
   const page=run?.pageId&&store.getPage(run.pageId);
   entries.push({id:item.id,...(run?.ampMode?{ampMode:true}:{}),runId:run?.id||null,ready:readyForProject(run),state:run?.state||item.state,pageId:page?.id||null,pageRevision:page?.revision||0,content:page?digest({title:page.title,config:page.config,expectedUrls:page.expectedUrls,wpType:page.wpType}):null,site:run?.manualTarget||run?.candidate||null,destinationRevision:run?.destinationRevision||0,criteria:run?.siteSelection||item.input.siteSelection});
  }
  const count=entries.filter(entry=>entry.ready).length,unreadyCount=entries.length-count;if(!count)blockedReason||=entries.length?'Немає готових сторінок із підібраними сайтами. Дочекайтеся підготовки або виправте помилки.':'Немає сторінок для публікації.';
  return {token:blockedReason?null:digest({approvalEpoch,projectId:project.id,projectRevision:project.revision,entries}),count,unreadyCount,notice:count&&unreadyCount?'Зараз буде запущено готових сторінок: '+count+'. Інші '+unreadyCount+' не запускаються цим натисканням і залишаються у списку.':'',blockedReason};
 }
 function startProject(id,body){
  fields(body,['planToken']);if(typeof body.planToken!=='string'||! /^[a-f0-9]{64}$/.test(body.planToken))fail('IMPORT_VALIDATION','Оновіть список сайтів перед запуском проєкту.');
  return store.atomic(()=>{const project=store.getProject(id);if(!project||project.archived)fail('NOT_FOUND','Проєкт не знайдено.');
   const receiptId='project-start:'+id+':'+body.planToken,previous=store.getRecord(receiptId);if(previous?.kind==='project_queue_start')return {queued:previous.count,reused:true};
   const list=members(id),plan=publicationPlan(project,list);if(!plan.token||plan.token!==body.planToken)fail('CONFLICT',plan.blockedReason||'Сторінки або підібрані сайти змінилися. Перегляньте оновлений список і повторіть запуск.');
   for(const item of list){const run=item.runId&&store.getRecord(item.runId);if(!readyForProject(run))continue;autopilot.approve(run.id,{reviewToken:autopilot.reviewToken(run.id)});}
   store.createRecord(id,'project_queue_start',{count:plan.count},receiptId);return {queued:plan.count,reused:false};
  });
 }
 function overview(){return store.readSnapshot?store.readSnapshot(readOverview):readOverview();}
 function readOverview(){
  const projects=store.listProjects().filter(p=>!p.archived&&(p.workflowType||store.listRecords(p.id,ITEM).length||store.listRecords(p.id,'autopilot').some(r=>!r.deletedAt)||store.listPages(p.id).some(page=>page.fullUrl))).map(project=>{
   const imported=store.listRecords(project.id,ITEM),runs=store.listRecords(project.id,'autopilot'),bound=new Set(imported.map(i=>i.runId));
   // Deleted runs retain ownership of their page ID, so an old deletion never
   // comes back as a new legacy row even if its page predates discard support.
   const ownedPages=new Set(runs.map(run=>run.pageId).filter(Boolean)),published=store.listPages(project.id).filter(page=>page.fullUrl&&!ownedPages.has(page.id));
   const list=[...[...imported,...runs.filter(r=>!r.deletedAt&&!bound.has(r.id)).map(fromRun)].map(itemView),...published.map(page=>publishedPageView(page,project))],settings=control(project.id),counts={total:list.length,waiting:0,generating:0,ready:0,publishing:0,completed:0,attention:0};
   for(const item of list){
    const ampRun=item.runId&&store.getRecord(item.runId);if(ampRun?.ampMode){const contentHash=item.pageId&&store.getPage(item.pageId)?.remoteSnapshot?.contentHash;item.amp={enabled:true,...(ampRun.ampStatus||{state:'pending'}),...(ampRun.ampStatus&&ampRun.ampStatus.contentHash!==contentHash?{state:'unknown',code:'AMP_RECHECK_REQUIRED'}:{})};}
    const hasPublication=item.state!=='deleted'&&!!item.fullUrl,checkAttention=hasPublication&&(item.manualReview?['declined','trash_failed','trash_uncertain'].includes(item.manualReview.state):['problem','unknown'].includes(item.verification?.state));
    if(hasPublication||item.state==='completed'&&item.manualReview?.state!=='trashed')counts.completed++;
    if(checkAttention)counts.attention++;
    if(item.state==='completed')continue;
    if(item.state==='waiting'||item.state==='queued'&&['waiting','generating','preparing'].includes(item.stage))counts.waiting++;else if(item.state==='running'&&['generating','preparing'].includes(item.stage))counts.generating++;else if(item.state==='awaiting_review')counts.ready++;else if(['queued','running','publishing','checking'].includes(item.state))counts.publishing++;else if(!terminal.has(item.state)&&!checkAttention)counts.attention++;
   }
   return {projectId:project.id,name:project.name,type:project.workflowType||null,paused:settings.paused,priority:settings.priority,ampMode:store.getRecord('amp-mode:'+project.id)?.enabled===true,counts,publicationPlan:publicationPlan(project),items:list};
  });
  const all=projects.flatMap(p=>p.items),owner=autopilot.publicationStatus?.()||null;
  if(owner&&all.some(item=>item.runId===owner.runId&&item.canContinueQueue))owner.message='Сторінку опубліковано. robots.txt блокує обхід Googlebot. Можна зберегти сторінку й продовжити чергу.';
  return {projects,...(manualPublishedReview?{manualPublishedReview:true}:{}),generation:{active:all.filter(i=>i.state==='running'&&['generating','preparing'].includes(i.stage)).length,waiting:projects.reduce((n,p)=>n+p.counts.waiting,0),concurrency:2},publication:{active:all.filter(i=>['running','publishing','checking'].includes(i.state)&&!['generating','preparing'].includes(i.stage)).length,waiting:all.filter(i=>i.state==='queued'&&!['generating','preparing'].includes(i.stage)).length,concurrency:1,owner}};
 }
 function importItems(body){
  fields(body,['idempotencyKey','projectId','name','type','items']);if(!uuid.test(body.idempotencyKey||''))fail('IMPORT_VALIDATION','Не вдалося визначити імпорт. Оновіть форму.');
  const normalized=normalizeImportItems(body.type,body.items),requestHash=digest({projectId:body.projectId||null,name:body.name||'',type:body.type,items:normalized.map(semanticInput)});
  return store.atomic(()=>{
   const previous=store.getRecord(body.idempotencyKey);if(previous){if(previous.kind!==BATCH||previous.requestHash!==requestHash)fail('CONFLICT','Цей імпорт уже має інші дані.');return {project:store.getProject(previous.projectId),batch:{id:previous.id,count:previous.count},reused:true};}
   let project=body.projectId&&store.getProject(body.projectId);if(body.projectId&&(!project||project.archived))fail('NOT_FOUND','Проєкт не знайдено.');
   if(project){
    if(project.workflowType&&project.workflowType!==body.type)fail('PROJECT_TYPE_MISMATCH','Проєкт уже має інший тип джерела. Створіть окремий проєкт.');
    if(store.listRecords(project.id,'autopilot').some(r=>!r.deletedAt&&(r.source||'ai')!==body.type))fail('PROJECT_TYPE_MISMATCH','У проєкті є сторінки з іншого джерела. Створіть окремий проєкт.');
    if(!project.workflowType)project=store.updateProject(project.id,{workflowType:body.type},project.revision);
   }else{if(typeof body.name!=='string'||!body.name.trim()||body.name.length>120)fail('IMPORT_VALIDATION','Введіть назву проєкту.');project=store.createProject({name:body.name.trim(),workflowType:body.type});}
   const existing=store.listRecords(project.id,ITEM),keys=new Map(existing.map(i=>[i.key,i]));
   // Old positional HTML snapshots lack filenames. Do not guess which new
   // filename owns one: require an explicit table ID to add an identical copy.
   const legacyHtml=new Set(existing.filter(item=>/^row-[1-9]\d*$/.test(item.key)&&item.input?.source==='html'&&typeof item.input.html==='string').map(item=>item.input.html));
   for(const input of normalized)if(!keys.has(input.key)&&input.source==='html'&&/^local-file-[a-f0-9]{64}$/.test(input.key)&&legacyHtml.has(input.html))fail('IMPORT_DUPLICATE_KEY','HTML цього файлу вже є у старому імпорті без збереженого імені файлу. Щоб додати окрему копію, вкажіть явний ID у таблиці імпорту.');
   let duplicate=0;
   for(const input of normalized){const prior=keys.get(input.key);if(prior){if(prior.inputHash!==digest(semanticInput(input)))fail('IMPORT_DUPLICATE_KEY','Рядок '+input.key+' уже існує з іншими даними. Змініть його ID.');duplicate++;continue;}const id=randomUUID();store.createRecord(project.id,ITEM,{key:input.key,input,inputHash:digest(semanticInput(input)),batchId:body.idempotencyKey,runId:randomUUID(),state:'waiting',error:null},id);}
   const batch=store.createRecord(project.id,BATCH,{requestHash,count:normalized.length-duplicate,duplicateCount:duplicate,source:body.type},body.idempotencyKey);
   if(!store.getRecord('queue-control:'+project.id))store.createRecord(project.id,CONTROL,{paused:false,priority:0},'queue-control:'+project.id);
   return {project,batch:{id:batch.id,count:batch.count,duplicateCount:duplicate},reused:false};
  });
 }
 function setControl(projectId,body){fields(body,['action','priority']);const project=store.getProject(projectId);if(!project||project.archived)fail('NOT_FOUND','Проєкт не знайдено.');if(body.action!==undefined&&!['pause','resume'].includes(body.action)||body.priority!==undefined&&(!Number.isSafeInteger(body.priority)||body.priority<0||body.priority>10))fail('IMPORT_VALIDATION','Перевірте дію та пріоритет.');return store.atomic(()=>{const old=store.getRecord('queue-control:'+projectId),patch={paused:body.action?body.action==='pause':old?.paused||false,priority:body.priority??old?.priority??0};if(old)store.updateRecord(old.id,patch,old.revision);else store.createRecord(projectId,CONTROL,patch,'queue-control:'+projectId);return {projectId,...patch};});}
 function feed(){
  if(feeding)return;feeding=true;try{
   const running=store.listProjects().flatMap(p=>store.listRecords(p.id,'autopilot')).filter(r=>!r.deletedAt&&['preparing','generating'].includes(r.stage)&&['queued','running'].includes(r.state)&&((r.leaseToken&&Date.parse(r.leaseUntil)>clock())||!control(r.projectId).paused&&!store.getProject(r.projectId)?.archived)).length;
   for(let slot=running;slot<2;slot++){
    const waiting=items().filter(i=>i.state==='waiting'&&!store.getRecord(i.runId)&&!control(i.projectId).paused&&!store.getProject(i.projectId)?.archived);
    waiting.sort((a,b)=>(control(b.projectId).priority||0)-(control(a.projectId).priority||0)||Number(a.projectId===lastProject)-Number(b.projectId===lastProject)||a.createdAt.localeCompare(b.createdAt));const next=waiting[0];if(!next)break;lastProject=next.projectId;
    try{store.atomic(()=>{const input=next.input,body={idempotencyKey:next.runId,source:input.source,chromeMode:input.chromeMode,reviewBeforePublish:true,...(input.source==='ai'?{links:input.links,editorial:input.editorial}:{html:input.html,baseUrl:input.baseUrl||'',brand:input.brand||'',brandUrl:input.brandUrl||''})};if(input.source==='html'){const {idempotencyKey,reviewBeforePublish,...preview}=body;body.reviewToken=autopilot.previewHtml(preview).reviewToken;}autopilot.launch(next.projectId,body,{queueItemId:next.id,language:input.language,siteSelection:input.siteSelection,slug:input.slug,donor:input.donor});const current=store.getRecord(next.id);store.updateRecord(next.id,{state:'queued'},current.revision);});}
    catch(error){const current=store.getRecord(next.id);store.updateRecord(next.id,{state:'failed',error:{code:error.code||'IMPORT_VALIDATION',message:/^[\w-]{1,80}$/.test(error.code||'')?String(error.message||'Не вдалося підготувати рядок.').slice(0,500):'Не вдалося підготувати рядок.'}},current.revision);}
   }
  }finally{feeding=false;}
 }
 function approve(body){fields(body,['items']);if(!Array.isArray(body.items)||!body.items.length||body.items.length>1000)fail('IMPORT_VALIDATION','Оберіть переглянуті сторінки.');return store.atomic(()=>{const seen=new Set();for(const entry of body.items){fields(entry,['id','reviewToken']);if(seen.has(entry.id))fail('IMPORT_VALIDATION','Повтор сторінки у виборі.');seen.add(entry.id);const item=itemFor(entry.id);if(control(item.projectId).paused)fail('CONFLICT','Проєкт на паузі. Спочатку відновіть чергу.');autopilot.approve(item.runId,{reviewToken:entry.reviewToken});}return {queued:body.items.length};});}
 async function retry(id){const item=itemFor(id),run=store.getRecord(item.runId);if(control(item.projectId).paused)fail('CONFLICT','Проєкт на паузі.');if(run){if(!autopilot.retrySelection(run.id))await autopilot.resume(run.id);}else{if(item.state!=='failed')fail('CONFLICT','Завдання вже виконується.');store.updateRecord(item.id,{state:'waiting',error:null},item.revision);}return {item:itemView(itemFor(id))};}
 function exportPrepared(body){
  fields(body,['items']);
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>MAX_PREPARED_PAGES)fail('EXPORT_LIMIT','Оберіть від 1 до 100 готових сторінок для ZIP.');
  const seen=new Set();
  const targets=body.items.map(entry=>{
   fields(entry,['id','pageId','pageRevision']);
   if(typeof entry.id!=='string'||!entry.id||entry.id.length>200||typeof entry.pageId!=='string'||!entry.pageId||entry.pageId.length>200||!Number.isSafeInteger(entry.pageRevision)||entry.pageRevision<1)
    fail('EXPORT_VALIDATION','Оновіть список і виберіть готові сторінки.');
   const item=itemFor(entry.id),run=item.runId&&store.getRecord(item.runId),page=run?.pageId&&store.getPage(run.pageId);
   if(!run||run.deletedAt||page?.id!==entry.pageId||page.revision!==entry.pageRevision)fail('CONFLICT','Готова сторінка змінилася. Оновіть список перед експортом.');
   if(seen.has(page.id))fail('EXPORT_VALIDATION','Оберіть кожну сторінку лише один раз.');
   seen.add(page.id);
   return {item,run};
  });
  const archive=createPreparedArchive((function* (){
   for(const {item,run} of targets){
    let prepared;
    try{prepared=autopilot.preparedExport(run.id,'prepared',false);}
    catch{fail('CONFLICT','Не вдалося підтвердити готовий HTML. Оновіть список і перевірте передперегляд.');}
    yield {key:item.key,language:item.input.language,geo:item.input.siteSelection.geo,prepared};
   }
  })());
  return new Response(archive,{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="pageposter-prepared.zip"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 async function handle(request,route,read){
  if(!route.startsWith('/project-import')&&!route.startsWith('/project-queue')&&!/^\/projects\/[^/]+\/queue(?:\/start)?$/.test(route))return null;
  try{
   if(route==='/project-import/preview'&&request.method==='POST')return json(await importer.preview(await read(request),{signal:request.signal}));
   if(route==='/project-queue/import'&&request.method==='POST'){const result=importItems(await read(request));return json(result,result.reused?200:201);}
   if(route==='/project-queue'&&request.method==='GET')return json(overview());
   if(route==='/project-queue/export-prepared'&&request.method==='POST')return exportPrepared(await read(request));
   if(route==='/project-queue/requirements'&&request.method==='POST')return json(changeQueueRequirements({store,autopilot,itemFor,clock},await read(request)));
   if(route==='/project-queue/approve'&&request.method==='POST')return json(approve(await read(request)),202);
   const review=/^\/project-queue\/items\/([a-zA-Z0-9-]+)\/published-review$/.exec(route);
   if(review&&request.method==='POST'&&manualPublishedReview)return json(savePublishedReview(review[1],await read(request)));
   const editor=/^\/project-queue\/items\/([a-zA-Z0-9-]+)\/open-wordpress$/.exec(route);
   if(editor&&request.method==='POST'&&manualPublishedReview){
    try{return json(await openPublishedEditor(editor[1],await read(request)));}
    catch(error){
     if(['NOT_FOUND','CONFLICT','IMPORT_VALIDATION'].includes(error.code))throw error;
     const message={BROWSER_CAPTCHA_REQUIRED:'Пройдіть CAPTCHA у вікні WordPress, потім натисніть цю кнопку ще раз.',BROWSER_LOGIN_REQUIRED:'Завершіть вхід у відкритому вікні WordPress і натисніть цю кнопку ще раз.',bootstrap_auth_failed:'WordPress відхилив збережені дані для входу.',BROWSER_ORIGIN_BLOCKED:'WordPress перенаправив на іншу адресу. Перевірте збережену адресу сайту.',BROWSER_EDITOR_ACCESS:'WordPress не відкрив редактор цієї сторінки. Перевірте права збереженого акаунта.'};
     return json({code:error.code||'BROWSER_EDITOR_UNAVAILABLE',error:message[error.code]||'Не вдалося відкрити редактор WordPress. Перевірте доступність сайту та налаштування з’єднання.'},400);
    }
   }
   const start=/^\/projects\/([a-zA-Z0-9-]+)\/queue\/start$/.exec(route);if(start&&request.method==='POST')return json(startProject(start[1],await read(request)),202);
   const project=/^\/projects\/([a-zA-Z0-9-]+)\/queue$/.exec(route);if(project&&request.method==='POST')return json(setControl(project[1],await read(request)));
   const crawl=/^\/project-queue\/items\/([a-zA-Z0-9-]+)\/continue-crawl-blocked$/.exec(route);
   if(crawl&&request.method==='POST'){
    const body=fields(await read(request),['expectedRevision']),item=itemFor(crawl[1]);
    if(!item.runId||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail('CONFLICT','Оновіть результат перевірки сторінки.');
    await autopilot.continueCrawlBlocked(item.runId,body.expectedRevision);
    return json({item:itemView(itemFor(crawl[1]))});
   }
   const item=/^\/project-queue\/items\/([a-zA-Z0-9-]+)\/retry$/.exec(route);if(item&&request.method==='POST'){fields(await read(request),[]);return json(await retry(item[1]));}
   return null;
  }catch(error){const code=error.code||'IMPORT_FAILED',friendly={...importReadErrors,REVIEW_REQUIRED:'Сторінка змінилася. Відкрийте актуальний перегляд і підтвердьте його ще раз.',HTML_REVIEW_REQUIRED:'HTML змінився після перегляду. Перевірте новий результат.',AI_RESULT_UNCERTAIN:'Результат платного запиту не підтверджено. Автоматичний повтор зупинений, щоб не оплатити його двічі.'},known=/^(IMPORT_|EXPORT_|GOOGLE_|DRIVE_|PROJECT_TYPE_|CONFLICT|NOT_FOUND)/.test(code);return json({code,error:friendly[code]||(known&&error.message!==code?error.message:'Не вдалося завершити імпорт або дію черги. Перевірте джерело та доступ.')},['CONFLICT','PROJECT_TYPE_MISMATCH','IMPORT_DUPLICATE_KEY'].includes(code)?409:code==='NOT_FOUND'?404:400);}
 }
 return {handle,feed,overview,importItems};
}
