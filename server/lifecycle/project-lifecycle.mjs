import {unusedDonorReservation,releasedDonorPatch} from './donor-reservations.mjs';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};

// Closing/trashing is local and reversible. No WordPress delete request is made.
export function createProjectLifecycle({store,automation,campaigns,clock=Date.now}){
 function change(id,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['action','expectedRevision'].includes(key))||!['close','reopen','trash','restore'].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)fail('VALIDATION','Перевірте дію над проєктом.');
  const project=store.getProject(id);if(!project)fail('NOT_FOUND','Проєкт не знайдено.');
  if(project.revision!==body.expectedRevision)fail('CONFLICT','Проєкт змінився. Оновіть список і повторіть дію.');
  const hiding=['close','trash'].includes(body.action);
  if(body.action==='close'&&project.archived||body.action==='reopen'&&(!project.archived||project.trashed)||body.action==='trash'&&project.trashed||body.action==='restore'&&!project.trashed)fail('CONFLICT','Стан проєкту змінився. Оновіть список.');
  const jobs=store.listJobs(id),runs=store.listRecords(id,'autopilot'),trashActions=store.listRecords(id,'published_trash');
  const generation=automation.runs.listRuns(id,{states:['queued','running'],limit:1000});
  if(hiding&&(trashActions.some(action=>action.state==='running')||jobs.some(job=>job.state==='running')||generation.some(run=>run.state==='running')||runs.some(run=>!run.deletedAt&&(run.state==='running'||run.leaseToken&&Date.parse(run.leaseUntil)>clock()||run.browserPreparing&&(!run.browserPreparingUntil||Date.parse(run.browserPreparingUntil)>clock())))))fail('PROJECT_BUSY','Зараз у проєкті виконується дія. Дочекайтеся її завершення й повторіть.');
  // Legacy generation uses a separate database. Record its pause before making
  // the project inactive, so reopening never repeats a paid request implicitly.
  if(hiding){
   campaigns.pauseProject(id);
   for(const run of generation){const current=automation.runs.getRun(run.id);if(current?.state==='queued')automation.runs.pauseRun(current.id,{expectedRevision:current.revision});}
  }
  return store.atomic(()=>{
   for(const run of runs)if(unusedDonorReservation(run,store,clock()))store.updateRecord(run.id,releasedDonorPatch(run),run.revision);
   if(hiding){
    for(const action of trashActions)if(action.state==='queued')store.updateRecord(action.id,{state:action.phase==='prepared'?'failed':'uncertain',errorCode:'PROJECT_CLOSED'},action.revision);
    for(const job of jobs)if(job.state==='queued')store.pauseJob(job.id);
    for(const run of runs)if(!run.deletedAt&&run.state==='queued'){const current=store.getRecord(run.id);if(current.state==='queued')store.updateRecord(run.id,{state:'paused',leaseToken:null,leaseUntil:null},current.revision);}
   }
   const control=store.getRecord('queue-control:'+id);
   if(control)store.updateRecord(control.id,{paused:true},control.revision);
   else store.createRecord(id,'project_queue_control',{paused:true,priority:0},'queue-control:'+id);
   const updated=store.updateProject(id,{archived:hiding,trashed:body.action==='trash'},project.revision);
   store.recordEvent({projectId:id,type:'project.'+body.action,entityId:id,message:'Local project management'});
   return updated;
  });
 }
 function respond(id,body){
  try{return json({project:change(id,body)});}
  catch(error){const known=['VALIDATION','NOT_FOUND','CONFLICT','PROJECT_BUSY'].includes(error.code);return json({code:known?error.code:'INTERNAL',error:known?error.message:'Не вдалося змінити стан проєкту.'},['CONFLICT','PROJECT_BUSY'].includes(error.code)?409:error.code==='NOT_FOUND'?404:known?400:500);}
 }
 async function handle(request,route,read){const match=/^\/projects\/([a-zA-Z0-9-]+)\/lifecycle$/.exec(route);if(!match||request.method!=='POST')return null;return respond(match[1],await read(request));}
 return {handle,change,respond};
}
