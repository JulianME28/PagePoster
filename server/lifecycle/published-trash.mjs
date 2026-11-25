import {isDeepStrictEqual} from 'node:util';
import {nativeUpdateSourceBinding} from './native-replacements.mjs';

const kind='published_trash';
const key=pageId=>'published-trash:'+pageId;
const fail=(code,message=code)=>{throw Object.assign(Error(message),{code});};
const pending=record=>['queued','running'].includes(record?.state);
const needsFreshDecline=record=>record?.requireFreshDecline===true||record?.phase==='published_verified';
const terminal=record=>['completed','failed','uncertain'].includes(record?.state);
export function createPublishedTrash({store,publicationTurn,browser,hasActivePage,clock=Date.now}){
 const get=pageId=>store.getRecord(key(pageId));
 const update=(record,patch)=>store.updateRecord(record.id,patch,store.getRecord(record.id).revision);
 function target(page,run){
  const saved=page?.remoteSnapshot,site=page?.siteId&&store.getSite(page.siteId);
  if(!browser?.nativeEditor||run?.kind!=='autopilot'||run.deletedAt||run.state!=='completed'||run.nativeCleanup||run.pageId!==page?.id||run.projectId!==page.projectId||run.siteId!==site?.id||run.nativePublication?.phase!=='published'||run.nativePublication.postId!==page.wpId||run.nativePublication.url!==page.fullUrl)return null;
  if(!site||site.enabled===false||site.bootstrap?.mode!=='browser'||!site.hasBrowserCredential||site.baseUrl!==run.candidate?.baseUrl||!store.siteBelongsToProject(page.projectId,site.id))return null;
  if(saved?.mode!=='browser'||saved.status!=='publish'||saved.postType!=='page'||saved.postId!==page.wpId||saved.url!==page.fullUrl||saved.title!==page.title||typeof saved.content!=='string'||!saved.contentHash)return null;
  return {site,saved,sourceBinding:nativeUpdateSourceBinding(run)};
 }
 function view(page,run){
  if(!page?.fullUrl&&page?.lifecycleState!=='trashed')return null;
  const record=get(page.id);
  if(record?.state==='completed'&&page.lifecycleState==='trashed')return {state:'trashed',canTrash:false};
  const canTrash=!!target(page,run);
  if(record?.pageRevision!==page.revision)return {canTrash};
  if(pending(record))return {state:'trash_queued',canTrash:false};
  if(record?.state==='uncertain')return {state:'trash_uncertain',canTrash,...(needsFreshDecline(record)?{retryTrashRevision:record.revision}:{}),trashMessage:'WordPress ще не підтвердив кошик. Повторна дія лише звірить стан.'};
  if(record?.state==='failed'){
   const message=record.errorCode==='NATIVE_TRASH_STILL_PUBLISHED'?'WordPress підтвердив, що сторінка досі опублікована без змін. Відхиліть її ще раз для перенесення в кошик.':record.errorCode==='PROJECT_CLOSED'?'Проєкт було закрито до перенесення. Щоб продовжити, відхиліть сторінку ще раз.':
    record.errorCode==='RESTORED_PAUSED'?'Дію відновлено з резервної копії. Перевірте доступ до WordPress і відхиліть сторінку ще раз.':
    record.errorCode==='NATIVE_CONTENT_CHANGED'?'Вміст у WordPress змінився після публікації. Відкрийте редактор, щоб перевірити сторінку.':
    ['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED','bootstrap_auth_failed','NATIVE_TRASH_ACCESS'].includes(record.errorCode)?'Не вдалося ввійти у WordPress зі збереженим доступом.':
    'Не вдалося перенести сторінку в кошик. Перевірте доступ і права у WordPress.';
   return {state:'trash_failed',canTrash,trashMessage:message,...(needsFreshDecline(record)?{retryTrashRevision:record.revision}:{})};
  }
  return {canTrash};
 }
 function hasWrite(page){
  return hasActivePage(page.id)||store.listRecords(page.projectId,'native_update').some(record=>record.pageId===page.id&&!['completed','failed'].includes(record.state))||
   store.listJobs(page.projectId).some(job=>job.pageId===page.id&&job.effect==='write'&&['queued','running','uncertain','paused'].includes(job.state));
 }
 function schedule(page,run,expectedTrashRevision){
  const previous=get(page.id);
  if(pending(previous)&&previous.pageRevision===page.revision)return view(page,run);
  const destination=target(page,run);
  if(!destination)fail('CONFLICT','Для перенесення в кошик потрібна сторінка PagePoster зі збереженим доступом до WordPress.');
  if(hasWrite(page))fail('CONFLICT','Дочекайтеся завершення поточних змін сторінки.');
  if(needsFreshDecline(previous)&&(previous.revision!==expectedTrashRevision||previous.pageRevision!==page.revision))fail('CONFLICT','Оновіть рішення після підтвердження стану сторінки у WordPress.');
  if(previous?.state==='uncertain'&&previous.pageRevision!==page.revision)fail('CONFLICT','Сторінка змінилася, поки WordPress підтверджував кошик.');
  const patch={requireFreshDecline:needsFreshDecline(previous),pageId:page.id,pageRevision:page.revision,originRunId:run.id,siteId:page.siteId,postId:page.wpId,url:page.fullUrl,contentHash:destination.saved.contentHash,sourceBinding:destination.sourceBinding,
   state:'queued',phase:previous?.state==='uncertain'?previous.phase:'prepared',stage:'trashing',errorCode:null};
  if(previous)update(previous,patch);else store.createRecord(page.projectId,kind,patch,key(page.id));
  return view(page,run);
 }
 function guard(record,{allowArchived=false}={}){
  const current=get(record.pageId),page=store.getPage(record.pageId),run=store.getRecord(record.originRunId),destination=target(page,run),project=store.getProject(record.projectId);
  if(publicationTurn.owner()?.id!==record.id||current?.state!=='running'||!project||(!allowArchived&&project.archived)||!destination||page.revision!==record.pageRevision||page.siteId!==record.siteId||page.wpId!==record.postId||page.fullUrl!==record.url||destination.saved.contentHash!==record.contentHash||!isDeepStrictEqual(destination.sourceBinding,record.sourceBinding)||hasWrite(page))fail('NATIVE_CONTENT_CHANGED');
  return {current,page,run,...destination};
 }
 async function close(record){
  try{await browser.reset(record.id);publicationTurn.finishTrash(record.id);}catch{/* Keep ownership until this context has closed. */}
 }
 async function tick(){
  if(!browser?.nativeEditor)return;
  const owner=publicationTurn.owner();
  let record=owner?.kind===kind?owner:null;
  if(record&&terminal(record)){await close(record);return;}
  if(!record){
   record=store.listProjects().filter(project=>!project.archived).flatMap(project=>store.listRecords(project.id,kind)).find(pending);
   if(!record||!publicationTurn.claimTrash(record))return;
  }
  try{await publicationTurn.prepareTrash(record.id);}catch{return;}
  record=update(record,{state:'running'});
  try{
   const {page,site,saved,run}=guard(record,{allowArchived:record.phase!=='prepared'}),binding=store.getBrowserCredentials(site.id);
   if(!binding?.username||!binding.applicationPassword)fail('NATIVE_TRASH_ACCESS');
   const session=await browser.open(record.id,site.baseUrl,{headless:run.browserMode==='hidden'});
   if(session.baseUrl&&session.baseUrl!==site.baseUrl)fail('NATIVE_CONTENT_CHANGED');
   await session.login(binding);
   const input={saved:{postId:page.wpId,phase:'published',url:page.fullUrl},title:saved.title,html:saved.content};
   const proof=async()=>{
    const result=await session.inspectOwnedTrash(input);
    if(result?.postId===page.wpId&&result.status==='trash')return result;
    if(result?.postId===page.wpId&&result.status==='unknown'&&get(page.id)?.phase==='dispatching'&&session.inspectOwnedPublished){
     const published=await session.inspectOwnedPublished(input);
     if(published?.postId===page.wpId&&published.status==='publish'&&published.url===page.fullUrl){
      store.atomic(()=>{
       const {current}=guard(record);
       if(current.phase!=='dispatching')fail('NATIVE_TRASH_UNCERTAIN');
       update(current,{state:'failed',phase:'published_verified',requireFreshDecline:true,errorCode:'NATIVE_TRASH_STILL_PUBLISHED'});
      });
      return null;
     }
    }
    fail('NATIVE_TRASH_UNCERTAIN');
   };
   const beforeSend=()=>{
    const {current}=guard(record);
    if(current.phase!=='dispatching'||!isDeepStrictEqual(binding,store.getBrowserCredentials(site.id)))fail('NATIVE_CONTENT_CHANGED');
   };
   const checkpoint=value=>store.atomic(()=>{
    const {current}=guard(record,{allowArchived:value.phase==='trashed'});
    if(value.postId!==record.postId||!(value.phase==='dispatching'&&current.phase==='prepared'||value.phase==='trashed'&&current.phase==='dispatching'))fail('NATIVE_TRASH_UNCERTAIN');
    update(current,{phase:value.phase});
   });
   let result;
   if(record.phase!=='prepared')result=await proof();
   else{
    try{result=await session.trashPublished({...input,beforeSend,checkpoint});}
    catch(error){if(get(page.id)?.phase==='prepared')throw error;result=await proof();}
   }
   if(!result&&get(page.id)?.phase==='published_verified')return;
   if(result?.status!=='trash'||result.postId!==page.wpId)fail('NATIVE_TRASH_UNCERTAIN');
   store.atomic(()=>{
    const {page:current}=guard(record,{allowArchived:true});
    store.updatePage(current.id,{fullUrl:'',lifecycleState:'trashed',remoteSnapshot:{...saved,status:'trash',contentHash:null}},current.revision);
    update(record,{state:'completed',phase:'trashed',confirmedAt:new Date(clock()).toISOString()});
   });
  }catch(error){
   const latest=get(record.pageId),uncertain=latest.phase!=='prepared';
   update(latest,{state:uncertain?'uncertain':'failed',errorCode:typeof error?.code==='string'?error.code:'NATIVE_TRASH_UNAVAILABLE'});
  }finally{await close(record);}
 }
 return {get,schedule,view,tick};
}
