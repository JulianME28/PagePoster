const ID='publication-turn:global',KIND='publication_turn';
// This is a durable workflow turn, not a short worker lease. A failed or manual
// step still owns it, so releasing a lease cannot advance another publication.
export function createPublicationTurn({store,allRuns,enabled=true,clock=Date.now,closeBrowser=async()=>{},canCloseBrowser=false,hasActivePage=()=>false,isActive=()=>false,manualPublishedReview=false}){
 let retiring=null,parking=null;
 // Later reviews and monitoring must never reclaim a completed turn.
 function complete(id){if(!enabled)return;store.atomic(()=>{const record=store.getRecord(ID),run=store.getRecord(id);if(record?.runId===id&&!record.releasedAt&&run?.state==='completed')store.updateRecord(ID,{releasedAt:new Date(clock()).toISOString()},record.revision);});}
 function owner(){if(!enabled)return null;const record=store.getRecord(ID);if(!record||record.releasedAt)return null;const trash=record.trashRunId&&store.getRecord(record.trashRunId);if(trash?.kind==='published_trash'&&!trash.deletedAt&&trash.state!=='deleted')return trash;const run=store.getRecord(record.runId);return ['autopilot','native_update','published_trash'].includes(run?.kind)&&!run.deletedAt&&run.state!=='deleted'?run:null;}
 function finishTrash(id){return store.atomic(()=>{const run=owner();if(run?.id!==id||run.kind!=='published_trash'||!['completed','failed','uncertain'].includes(run.state))return;const turn=store.getRecord(ID);const patch=turn.trashRunId===id?{trashRunId:null}:{releasedAt:new Date(clock()).toISOString(),releaseReason:'trash_finished'};store.updateRecord(ID,patch,turn.revision);});}
 function releaseUnsent(id){if(!enabled)return false;return store.atomic(()=>{const record=store.getRecord(ID),run=store.getRecord(id),job=run?.jobId&&store.getJob(run.jobId);if(record?.runId!==id||record.releasedAt||run?.kind!=='native_update'||run.state!=='failed'||!['queued','prepared'].includes(run.phase)||job?.state!=='failed'||job.effect!=='write'||job.projectId!==run.projectId||job.result?.writeNotAttempted!==true)return false;store.updateRecord(ID,{releasedAt:new Date(clock()).toISOString(),releaseReason:'update_not_sent'},record.revision);return true;});}
 function claim(run){if(!enabled)return true;return store.atomic(()=>{const current=owner();if(current)return current.id===run.id;if(store.getProject(run.projectId)?.archived||store.getProject(run.projectId)?.trashed)return false;const old=store.getRecord(ID),patch={runId:run.id,ownerProjectId:run.projectId,acquiredAt:new Date(clock()).toISOString(),releasedAt:null,releaseReason:null,trashRunId:null};if(old)store.updateRecord(ID,patch,old.revision);else store.createRecord(run.projectId,KIND,patch,ID);return true;});}
 function claimTrash(run){
  if(run.kind!=='published_trash')return false;
  if(!owner())return claim(run);
  return store.atomic(()=>{
   const current=owner(),project=store.getProject(run.projectId),turn=store.getRecord(ID);
   if(!project||project.archived||project.trashed||turn.trashRunId||current?.kind!=='autopilot'||current.publicationMode!=='native'||
      !['failed','needs_attention'].includes(current.state)||current.error?.code!=='BROWSER_TIMEOUT'||
      current.nativePublication||current.nativeCleanup||current.jobId||current.checkJobId||current.leaseToken||current.browserPreparing||isActive(current.id))return false;
   const page=store.getPage(current.pageId);
   if(!page||page.wpId||page.fullUrl||store.listJobs(current.projectId).some(job=>job.pageId===page.id&&job.effect==='write'))return false;
   // Keep the blocked publication as the durable owner once the separate,
   // explicitly requested Trash operation ends, including after a restart.
   store.updateRecord(ID,{trashRunId:run.id},turn.revision);
   return true;
  });
 }
 async function prepareTrash(id){
  const turn=store.getRecord(ID);
  if(turn?.trashRunId!==id)return;
  await closeBrowser(turn.runId);
  store.atomic(()=>{
   if(store.getRecord(ID)?.trashRunId!==id)return;
   const current=store.getRecord(turn.runId);
   if(current?.browserWindow)store.updateRecord(current.id,{browserWindow:false},current.revision);
  });
 }
 function canPark(run){
  const project=run&&store.getProject(run.projectId);
  if(!enabled||!canCloseBrowser||!project||project.archived||project.trashed||retiring||parking||owner()?.id!==run.id||
    run.kind!=='autopilot'||(run.publicationMode&&run.publicationMode!=='native')||!['installing','publishing','checking'].includes(run.stage)||
    !['failed','uncertain','needs_attention'].includes(run.state)||run.publicationParked||isActive(run.id)||hasActivePage(run.pageId)||
    run.jobId||run.checkJobId||(run.browserPreparing&&!(Date.parse(run.browserPreparingUntil)<=clock()))||
    (run.leaseToken&&!(Date.parse(run.leaseUntil)<=clock())))return false;
  return !store.listJobs(run.projectId).some(job=>job.pageId===run.pageId&&job.effect==='write'&&['queued','paused','uncertain','running'].includes(job.state));
 }
 async function park(id){
  const conflict=()=>{throw Object.assign(Error('Стан публікації змінився. Оновіть чергу.'),{code:'CONFLICT'});};
  const before=store.getRecord(id);if(!before||!canPark(before))conflict();
  const fence=store.updateRecord(id,{browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString()},before.revision);
  parking=id;
  try{
   await closeBrowser(id);
   store.atomic(()=>{
    const current=store.getRecord(id),turn=store.getRecord(ID);
    if(current?.revision!==fence.revision||owner()?.id!==id)conflict();
    parking=null;
    if(!canPark({...current,browserPreparing:false}))conflict();
    store.updateRecord(id,{browserPreparing:false,browserPreparingUntil:null,browserWindow:false,publicationParked:true},current.revision);
    store.updateRecord(ID,{releasedAt:new Date(clock()).toISOString(),releaseReason:'manually_parked'},turn.revision);
   });
  }finally{
   parking=null;const current=store.getRecord(id);
   if(current?.browserPreparing&&current.browserPreparingUntil===fence.browserPreparingUntil)store.updateRecord(id,{browserPreparing:false,browserPreparingUntil:null},current.revision);
  }
 }
 function canRetire(run){
  if(parking)return false;
  if(run&&run.kind!=='autopilot')return false;
  const project=run&&store.getProject(run.projectId);
  const settling=run&&['publishing','checking'].includes(run.state)&&(run.stage==='publishing'&&run.jobId||run.stage==='checking'&&run.checkJobId);
  return !!(run&&(project?.archived||project?.trashed)&&run.state!=='running'&&!settling&&!isActive(run.id)&&(!run.leaseToken||Date.parse(run.leaseUntil)<=clock())&&(!run.browserPreparing||Date.parse(run.browserPreparingUntil)<=clock())&&!store.listJobs(run.projectId).some(job=>['queued','running'].includes(job.state)));
 }
 async function retireInactive(){
  if(!enabled)return;if(retiring)return retiring;
  const run=owner();if(!canRetire(run))return;
  // An explicitly closed project must not hold unrelated projects forever.
  // Keep its durable checkpoints and ownership until its private window closes.
  retiring=(async()=>{
   await closeBrowser(run.id);
   store.atomic(()=>{const current=owner();if(current?.id!==run.id||!canRetire(current))return;const record=store.getRecord(ID);store.updateRecord(ID,{releasedAt:new Date(clock()).toISOString(),releaseReason:'project_inactive'},record.revision);});
  })();
  try{return await retiring;}finally{retiring=null;}
 }
 function adoptLegacy(){if(!enabled)return;const record=store.getRecord(ID);if(record){complete(record.runId);return;}const previous=allRuns().filter(run=>!run.deletedAt&&run.state!=='deleted'&&run.state!=='completed'&&run.pageId&&!['generating','preparing'].includes(run.stage)&&!store.getProject(run.projectId)?.archived&&(run.browserWindow||run.nativePublication||run.publicationMode==='native'&&run.siteId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];if(previous)claim(previous);}
 function status(){const run=owner();if(!run)return null;const project=store.getProject(run.projectId),page=run.pageId&&store.getPage(run.pageId),paused=store.getRecord('queue-control:'+run.projectId)?.paused||project?.archived,blocked=!!paused||!['queued','running','publishing','checking'].includes(run.state),manual=['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(run.error?.code);
  if(run.kind==='published_trash')return {runId:run.id,pageId:run.pageId,projectId:run.projectId,title:page?.title||'Сторінка',state:run.state,stage:run.stage,blocked:false,manual:false,message:'Виконується перенесення сторінки в кошик WordPress.'};
  const next=manualPublishedReview?'підтвердження публікації WordPress.':'підтвердження публікації та перевірки.';
  const manualMessage=run.browserMode==='hidden'?'Натисніть «Продовжити», щоб відкрити WordPress у видимому вікні та завершити вхід або пройти CAPTCHA. Наступні сторінки чекають.':'Пройдіть CAPTCHA або завершіть вхід у поточному вікні WordPress, потім натисніть «Продовжити». Наступні сторінки чекають.';
  return {runId:run.id,pageId:run.pageId||null,projectId:run.projectId,title:page?.title||run.title||'Поточна сторінка',state:run.state,stage:run.stage,blocked,manual,code:run.error?.code||null,message:manual?manualMessage+(paused?' Проєкт на паузі: перед продовженням відновіть його.':''):paused?'Поточний проєкт на паузі. Наступні сторінки чекають завершення поточної.':blocked?'Поточна сторінка потребує дії. Наступні чекають '+next:'Працює одна сторінка. Наступна почнеться після '+next};
 }
 return {owner,claim,canPark,park,isParking:id=>parking===id,claimTrash,prepareTrash,complete,finishTrash,releaseUnsent,adoptLegacy,status,retireInactive};
}
