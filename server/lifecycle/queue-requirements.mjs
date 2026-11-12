import {createHash} from 'node:crypto';
import {normalizeSiteCriteria} from './site-source.mjs';
import {unusedDonorReservation,releasedDonorPatch} from './donor-reservations.mjs';
import {normalizeImportItems} from './project-import.mjs';
import {normalizeHtmlLanguage} from './import-regions.mjs';
import {EDITORIAL_LANGUAGES} from './editorial-brief.mjs';

const ITEM='project_queue_item';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('IMPORT_VALIDATION','Перевірте вибрані сторінки та вимоги до сайтів.');}
const present=value=>value!==undefined&&value!==null;
const hasEntries=value=>present(value)&&(!Array.isArray(value)||value.length>0);

// A candidate reservation alone is local. Every sign of a browser, manual
// destination, lease, job or WordPress operation makes this action unavailable.
function editable(item,run,page,project,store,now){
 if(!project||project.archived||project.trashed||item.deletedAt)return false;
 if(!run)return item.kind===ITEM&&item.state==='waiting';
 if(run.kind!=='autopilot'||run.projectId!==item.projectId||run.deletedAt||!page||page.projectId!==run.projectId||page.lifecycleState!=='draft'||page.siteId||page.wpId||page.fullUrl||page.remoteSnapshot)return false;
 const approval=run.publicationApproval,approvedUnstarted=approval&&approval.pageId===page.id&&approval.pageRevision===page.revision&&/^[a-f0-9]{64}$/.test(approval.reviewToken||'')&&/^[a-f0-9]{64}$/.test(approval.materialHash||'');
 if(!['awaiting_review','failed','needs_attention','waiting_source','paused'].includes(run.state)&&!(run.state==='queued'&&approvedUnstarted)||!['selecting','installing'].includes(run.stage))return false;
 if(approval&&!approvedUnstarted)return false;
 if(['leaseToken','leaseOwner','leaseUntil'].some(key=>present(run[key])))return false;
 if(['manualTarget','manualCredential','nativePublication','nativeSnapshot','siteId','jobId','checkJobId','bootstrapStage','apiCredential','publicationMode','browserPreparingUntil','nativePublishedRevision'].some(key=>present(run[key])&&run[key]!==false&&run[key]!==''))return false;
 if(run.browserWindow||run.browserPreparing||run.nativeCapacityReserved||run.publicationAttempt||run.candidateCredentialIndex||hasEntries(run.destinationHistory)||hasEntries(run.donorSkips)||hasEntries(run.candidateCredentialFailures))return false;
 if(run.error&&!/^(?:SOURCE_(?:EMPTY|NOT_CONFIGURED|RESERVED)|(?:source_|GOOGLE_)[A-Za-z_]+)$/.test(run.error.code||''))return false;
 if(store.listJobs(run.projectId).some(job=>job.pageId===page.id))return false;
 if(run.candidate)return (run.state==='awaiting_review'||run.state==='queued'&&approvedUnstarted)&&unusedDonorReservation(run,store,now);
 return run.stage==='selecting'&&!run.candidateCredential&&!run.alternateCredential;
}

function snapshot(item,store,now){
 const project=store.getProject(item.projectId),run=item.runId?store.getRecord(item.runId):null,page=run?.pageId?store.getPage(run.pageId):null;
 const requirementsRevision=digest({projectId:item.projectId,projectRevision:project?.revision||0,itemId:item.id,itemRevision:item.kind===ITEM?item.revision:null,runId:run?.id||null,runRevision:run?.revision||0,pageId:page?.id||null,pageRevision:page?.revision||0});
 return {run,page,requirementsRevision,canEditRequirements:editable(item,run,page,project,store,now)};
}

export function requirementsMetadata(item,store,now=Date.now()){
 const {requirementsRevision,canEditRequirements,run}=snapshot(item,store,now);
 return {requirementsRevision,canEditRequirements,canEditLanguage:canEditRequirements&&(item.input.source==='html'||!run)};
}

export function changeQueueRequirements({store,autopilot,itemFor,clock=Date.now},body){
 fields(body,['items','changes']);fields(body.changes,['minDr','minTraffic','geo','language']);
 if(!Object.keys(body.changes).length||!Array.isArray(body.items)||!body.items.length||body.items.length>1000)fail('IMPORT_VALIDATION','Оберіть від 1 до 1000 сторінок і вкажіть мову, гео, DR або трафік.');
 const {language:rawLanguage,...criteria}=body.changes;
 const language=rawLanguage===undefined?undefined:normalizeHtmlLanguage(rawLanguage);
 if(rawLanguage!==undefined&&!language)fail('IMPORT_VALIDATION','Вкажіть код мови, наприклад pl або en-NZ.');
 let changes;try{const normalized=normalizeSiteCriteria(criteria);changes=Object.fromEntries(Object.keys(criteria).map(key=>[key,normalized[key]]));}catch{fail('IMPORT_VALIDATION','DR має бути числом від 0 до 100, трафік — цілим невід’ємним числом, гео — кодами країн із двох літер.');}
 const seen=new Set();for(const entry of body.items){fields(entry,['id','expectedRevision']);if(typeof entry.id!=='string'||!entry.id||entry.id.length>200||typeof entry.expectedRevision!=='string'||!entry.expectedRevision||entry.expectedRevision.length>200||seen.has(entry.id))fail('IMPORT_VALIDATION','Оновіть список і виберіть кожну сторінку лише один раз.');seen.add(entry.id);}
 return store.atomic(()=>{
  // Validate the complete batch before changing either queue inputs or runs.
  const targets=new Set(),updates=body.items.map(entry=>{
   const item=itemFor(entry.id),current=snapshot(item,store,clock());
   const target=item.runId||item.id;if(targets.has(target))fail('IMPORT_VALIDATION','Одну сторінку не можна змінити двічі в одному пакеті.');targets.add(target);
   if(!current.canEditRequirements||current.requirementsRevision!==entry.expectedRevision)fail('CONFLICT','Сторінка змінилася або вже почала роботу з WordPress. Оновіть список перед зміною вимог.');
   const languageChanged=language!==undefined&&language!==item.input.language;
   if(languageChanged&&item.input.source==='ai'){
    if(current.run)fail('CONFLICT','Зміна мови підготовленої AI-сторінки потребує нової генерації. Створіть нове завдання з потрібною мовою.');
    if(!Object.hasOwn(EDITORIAL_LANGUAGES,language))fail('IMPORT_VALIDATION','Для AI оберіть en, es, pl, de або fr.');
   }
   const inputCriteria=normalizeSiteCriteria(item.input.siteSelection),runCriteria=current.run?normalizeSiteCriteria(current.run.siteSelection):inputCriteria,siteSelection=normalizeSiteCriteria({...inputCriteria,...runCriteria,...changes});
   const changed=languageChanged||Object.keys(changes).some(key=>siteSelection[key]!==inputCriteria[key]||siteSelection[key]!==runCriteria[key]);
   return {item,run:current.run,siteSelection,languageChanged,changed};
  });
  let updated=0;
  for(const {item,run,siteSelection,languageChanged,changed} of updates){
   if(!changed)continue;
   const locale=languageChanged?{language}:{};
   if(item.kind===ITEM){
    const editorial=languageChanged&&item.input.source==='ai'?{editorial:{...item.input.editorial,language}}:{};
    const input=normalizeImportItems(item.input.source,[{...item.input,...locale,...editorial,geo:siteSelection.geo,siteSelection}])[0],{provenance,...semantic}=input;
    store.updateRecord(item.id,{input,inputHash:digest(semantic)},item.revision);
   }
   if(run)store.updateRecord(run.id,{...releasedDonorPatch(run),...locale,siteSelection,reviewBeforePublish:true,donorSkips:[],leaseToken:null,leaseOwner:null,leaseUntil:null},run.revision);
   updated++;
  }
  // This also fences pending source reads and forces the next selection to read
  // a fresh pool. Generation/payment identities and the prepared page stay intact.
  if(updated)autopilot.invalidateSelection();
  return {updated};
 });
}
