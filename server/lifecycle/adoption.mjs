import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createBridgeClient,bridgeContentHash} from './bridge-client.mjs';
import {inspectExactImport,renderExactImport} from './exact-import.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(value,names)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))fail('VALIDATION');};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createAdoption({store,bridge=createBridgeClient(),clock=Date.now}={}){
 function siteFor(projectId,id){const site=store.getSite(id);if(!site||!store.siteBelongsToProject(projectId,id))fail('NOT_FOUND');if(site.enabled===false)fail('disabled');if(!site.hasCredential)fail('auth_failed');return site;}
 function recordFor(id){const record=store.getRecord(id);if(!record||record.kind!=='adoption')fail('NOT_FOUND');return record;}
 function publicPreview(record){return Object.fromEntries(['id','revision','confirmationHash','title','fullUrl','wpId','wpType','managed','summary','warnings','canAdopt','state','pageId','jobId'].filter(k=>Object.hasOwn(record,k)).map(k=>[k,record[k]]));}
 function bound(site,wpId,exceptId){const base=new URL(site.baseUrl).href.replace(/\/$/,'');for(const project of store.listProjects())for(const page of store.listPages(project.id)){if(page.id===exceptId||page.wpId!==wpId)continue;const other=store.getSite(page.siteId);if(other&&new URL(other.baseUrl).href.replace(/\/$/,'')===base)return true;}return false;}
 function fingerprint(record){return digest({siteId:record.siteId,siteRevision:record.siteRevision,wpId:record.wpId,wpType:record.wpType,snapshotHash:record.snapshot.contentHash,config:record.config});}
 async function prepare(projectId,body){
  fields(body,['siteId','wpId','wpType']);if(!Number.isSafeInteger(body.wpId)||body.wpId<1||!['page','post'].includes(body.wpType))fail('VALIDATION');
  const site=siteFor(projectId,body.siteId),credentials=store.getSiteCredentials(site.id),remote={site:{baseUrl:site.baseUrl,...credentials}};
  const [status,snapshot]=await Promise.all([bridge.checkStatus(remote),bridge.inspectPage({...remote,postId:body.wpId})]);
  if(snapshot.postId!==body.wpId||snapshot.postType!==body.wpType||bridgeContentHash(snapshot)!==snapshot.contentHash||new URL(snapshot.url).origin!==new URL(site.baseUrl).origin)fail('CONFLICT');
  const warnings=[];let imported=null;
  try{imported=inspectExactImport(snapshot.content);warnings.push(...imported.warnings);}catch(error){if(!['IMPORT_UNMARKED','IMPORT_AMBIGUOUS','VALIDATION'].includes(error.code))throw error;warnings.push(error.code==='IMPORT_UNMARKED'?'Сторінка не має однозначного маркера PagePoster.':'Переходи чи HTML неоднозначні; кероване редагування поки недоступне.');}
  const occupied=bound(site,body.wpId);if(occupied)warnings.push('Цю WordPress-сторінку вже прив’язано до локальної сторінки.');
  if(!status.ready)warnings.push('Онови й активуй потрібні версії PagePoster Bridge та Clean Links.');
  if(!['draft','publish'].includes(snapshot.status))warnings.push('Керований імпорт підтримує лише чернетку або опубліковану сторінку.');
  const config=imported?{...imported.config,title:snapshot.title}:null;
  const data={siteId:site.id,siteRevision:site.revision,siteBaseUrl:site.baseUrl,wpId:body.wpId,wpType:body.wpType,title:snapshot.title,fullUrl:snapshot.url,managed:snapshot.managed,snapshot,config,state:'preview',warnings,canAdopt:!!imported&&status.ready===true&&snapshot.canEdit===true&&!occupied&&['draft','publish'].includes(snapshot.status),summary:{placements:imported?.placements.length||0,bytes:Buffer.byteLength(snapshot.content),marker:imported?.marker||'',preservesSource:true}};
  data.confirmationHash=fingerprint(data);return publicPreview(store.createRecord(projectId,'adoption',data));
 }
 function confirm(id,body){
  fields(body,['expectedRevision','confirmationHash','confirmed']);if(body.confirmed!==true)fail('VALIDATION');
  return store.atomic(()=>{const record=recordFor(id);if(body.confirmationHash!==record.confirmationHash||fingerprint(record)!==record.confirmationHash)fail('CONFLICT');
   if(record.state==='confirmed'){if(record.confirmedFromRevision!==body.expectedRevision)fail('CONFLICT');return {preview:publicPreview(record),page:store.getPage(record.pageId),job:store.getJob(record.jobId)};}
   if(record.state!=='preview'||record.revision!==body.expectedRevision||!record.canAdopt)fail('CONFLICT');
   const site=siteFor(record.projectId,record.siteId);if(site.revision!==record.siteRevision||bound(site,record.wpId))fail('CONFLICT');
   const rendered=renderExactImport(record.config),page=store.createPage(record.projectId,{siteId:site.id,title:record.title||'WordPress '+record.wpId,wpId:record.wpId,wpType:record.wpType,fullUrl:record.fullUrl,config:record.config,expectedUrls:rendered.expectedUrls,expectedMarker:rendered.expectedMarker,lifecycleState:'review_required'});
   const job=store.enqueueJob({projectId:record.projectId,siteId:site.id,pageId:page.id,type:'adopt',payload:{adoptionId:record.id,expectedRevision:page.revision,siteBaseUrl:site.baseUrl,config:record.config,expectedUrls:rendered.expectedUrls,expectedMarker:rendered.expectedMarker,snapshot:record.snapshot,operation:{kind:'adopt',postId:record.wpId,postType:record.wpType,expectedContentHash:record.snapshot.contentHash}},idempotencyKey:'adopt:'+record.id});
   const updated=store.updateRecord(record.id,{state:'confirmed',confirmedFromRevision:record.revision,pageId:page.id,jobId:job.id},record.revision);return {preview:publicPreview(updated),page,job};
  });
 }
 function beforeSend(job,credentials){const current=store.getJob(job.id),page=store.getPage(job.pageId),site=siteFor(job.projectId,job.siteId);if(!page||page.siteId!==site.id||page.revision!==job.payload.expectedRevision||current.state!=='running'||current.leaseToken!==undefined&&current.leaseToken!==job.leaseToken||!current.leaseUntil||Date.parse(current.leaseUntil)<=clock()||site.baseUrl!==job.payload.siteBaseUrl||!isDeepStrictEqual(store.getSiteCredentials(site.id),credentials))fail('CONFLICT');}
 function accept(job,result){
  const current=store.getJob(job.id);if(current.state==='completed')return current;
  const snapshot=job.payload.snapshot,page=store.getPage(job.pageId),site=siteFor(job.projectId,job.siteId);
  if(result.state==='conflict')fail('CONFLICT');
  if(result.state!=='completed'||result.operationId!==job.id||result.kind!=='adopt'||result.postId!==snapshot.postId||result.contentHash!==snapshot.contentHash||result.postType!==snapshot.postType||result.status!==snapshot.status||new URL(result.url).origin!==new URL(site.baseUrl).origin)throw Object.assign(new Error('pp_bridge_uncertain'),{code:'pp_bridge_uncertain',uncertain:true});
  if(!page||page.siteId!==job.siteId||page.wpId!==snapshot.postId)throw Object.assign(new Error('CONFLICT'),{code:'CONFLICT',uncertain:true});
  const localChanged=page.revision!==job.payload.expectedRevision||!isDeepStrictEqual(page.config,job.payload.config);
  const patch={wpId:snapshot.postId,wpType:snapshot.postType,fullUrl:result.url,remoteSnapshot:{...snapshot,managed:true,operationId:job.id,config:job.payload.config},expectedUrls:job.payload.expectedUrls,expectedMarker:job.payload.expectedMarker,lifecycleState:localChanged?'review_required':snapshot.status==='publish'?'published':'draft'};
  if(!localChanged)patch.config=job.payload.config;
  const completed=store.completeRemoteWrite(job.id,{...(job.leaseToken?{leaseToken:job.leaseToken}:{}),expectedPageRevision:page.revision,patch,result:{...result,localChanged,pageRevision:page.revision+1,verification:'pending'}});
  if(snapshot.status==='publish')try{store.enqueueJob({projectId:job.projectId,siteId:job.siteId,pageId:job.pageId,type:'page_check',payload:{},idempotencyKey:'verify:'+job.id});}catch{}
  return completed;
 }
 async function perform(job,site,credentials){if(job.type!=='adopt')fail('VALIDATION');site=siteFor(job.projectId,job.siteId);beforeSend(job,credentials);const result=await bridge.submitOperation({site:{baseUrl:site.baseUrl,...credentials},operation:{...job.payload.operation,operationId:job.id},beforeSend:()=>beforeSend(job,credentials)});if(result.state==='conflict')fail('CONFLICT');try{return accept(job,result);}catch(error){error.uncertain=true;throw error;}}
 async function recover(job,shouldRetry){
  if(!job||job.type!=='adopt')fail('VALIDATION');
  const current=store.getJob(job.id);if(current.state==='completed')return current;if(current.state!=='uncertain')fail('CONFLICT');
  const site=siteFor(current.projectId,current.siteId),result=await bridge.getOperation({site:{baseUrl:site.baseUrl,...store.getSiteCredentials(site.id)},operationId:current.id});
  if(result.state==='completed')return accept(current,result);
  if(result.state==='conflict')return store.reconcileJob(current.id,{state:'failed',error:{code:'CONFLICT'}});
  if(result.state!=='not_found')return store.getJob(current.id);
  const absent=store.markWriteAbsent(current.id,current.revision);if(!shouldRetry)return absent;
  const page=store.getPage(current.pageId),freshSite=siteFor(current.projectId,current.siteId);
  if(!page||page.siteId!==current.siteId||page.revision!==current.payload.expectedRevision||page.wpId!==current.payload.snapshot.postId||freshSite.baseUrl!==current.payload.siteBaseUrl||bound(freshSite,page.wpId,page.id))fail('CONFLICT');
  return store.retryUncertainJob(current.id,{expectedRevision:absent.revision,verifiedAbsent:true});
 }
 async function reconcile(job){return recover(job,false);}
 async function retry(job){return recover(job,true);}
 async function handle(request,route,read){let match=route.match(/^\/projects\/([^/]+)\/imports\/preview$/);if(match&&request.method==='POST')return response({preview:await prepare(match[1],await read(request))},201);match=route.match(/^\/imports\/([^/]+)\/confirm$/);if(match&&request.method==='POST')return response(confirm(match[1],await read(request)),202);return null;}
 return {prepare,confirm,perform,reconcile,retry,handle};
}
