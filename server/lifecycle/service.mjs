import {createAutopilot} from './autopilot.mjs';
import {ampErrorMessage} from './amp-mode.mjs';
import {createProjectQueue} from './project-queue.mjs';
import {projectImportCapabilities} from './import-capabilities.mjs';
import {createProjectLifecycle} from './project-lifecycle.mjs';
import {createGoogleOAuth} from './google-oauth.mjs';
import {createGoogleBrowser} from './google-browser.mjs';
import {createWordPressUI} from './wordpress-ui.mjs';
import {createProxySettings} from './proxy-settings.mjs';
import {createProxyMetering} from './proxy-metering.mjs';
import {proxyMessages} from './proxy-messages.mjs';
import {createBridgeClient} from './bridge-client.mjs';
import {createAdoption} from './adoption.mjs';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {createBrowserVerifier} from './browser-check.mjs';
import {safePublishedEvidence} from './published-diagnostics.mjs';
import {readLocalLinkReport,writeLocalLinkReport} from './published-link-report.mjs';
import {createSupportReport} from './support-diagnostics.mjs';
import {createNativeTelemetry} from './native-telemetry.mjs';
import {randomUUID} from 'node:crypto';
import {createMonitorScheduler} from './monitoring.mjs';
import {createReplacementBatches} from './replacement-batches.mjs';
import {createNativeReplacements,nativeUpdateSourceBinding} from './native-replacements.mjs';
import {createPublishedTrash} from './published-trash.mjs';
import {createStore} from './store.mjs';
import {createRuns} from './runs.mjs';
import {createCampaigns} from './campaigns.mjs';
import {prepareCampaign} from './campaign-input.mjs';
import {createWordPressClient} from './wordpress.mjs';
import {createWorkflow,prepareConfig} from './workflow.mjs';
const PREFIX='/api/lifecycle';
const message={source_limit_exceeded:"Діапазон таблиці перевищує 100 000 рядків. Звузьте діапазон до 100 000 рядків або менше. Частковий підбір не виконується.",source_auth_failed:"Google не підтвердив доступ сервісного акаунта. Перевірте файл акаунта й доступ до таблиці.",source_read_failed:"Не вдалося прочитати Google-таблицю. Перевірте її адресу, назву вкладки, діапазон і доступ сервісного акаунта.",source_validation:"Перевірте діапазон, колонки таблиці й критерії підбору сайту.",source_response_invalid:"Google-таблиця повернула непідтримувані дані. Перевірте вкладку й діапазон.",SOURCE_NOT_CONFIGURED:"Спочатку підключіть сервісний акаунт до збереженої Google-таблиці.",SOURCE_EMPTY:"У таблиці немає доступних невикористаних сайтів, які відповідають критеріям проєкту.",REVIEW_REQUIRED:'Відкрийте актуальний попередній перегляд запуску й підтвердьте публікацію в PagePoster.',HTML_REVIEW_REQUIRED:'Перегляньте поточний HTML перед публікацією. Після зміни коду або режиму потрібен новий перегляд.',CUSTOMER_HTML_INVALID:'Не вдалося підготувати HTML. Перевірте код, адреси та вибраний режим.',CUSTOMER_HTML_TOO_LARGE:'HTML перевищує 500 КБ. Скоротіть файл перед завантаженням.',CONTENT_DUPLICATE:'Такий згенерований текст уже є на іншій сторінці. Зміни завдання або відредагуй текст.',CONTENT_FACT_REVIEW_REQUIRED:'ШІ додав твердження, яких немає у твоїх даних. Перевір текст і факти перед публікацією.',AI_AUTH_FAILED:'Ключ OpenAI не прийнято. Перевір ключ у налаштуваннях.',AI_ACCESS_DENIED:'OpenAI відхилив доступ (HTTP 403). Перевір дозволи API-проєкту та доступність вибраної моделі в акаунті.',AI_MODEL_UNAVAILABLE:'Вибрана модель недоступна. Перевір налаштування ШІ.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Завершені частини збережено.',AI_PROVIDER_UNAVAILABLE:'OpenAI зараз недоступний. Завершені частини збережено.',AI_TIMEOUT:'OpenAI не відповів вчасно. Перевір стан запиту перед повтором.',AI_BUDGET_EXCEEDED:'Досягнуто встановлений ліміт витрат ШІ.',SITE_NOT_READY:'Спочатку перевір доступ до сайту у розділі Сайти.',GENERATION_HTML_UNSUPPORTED:'Готовий HTML можна передати без генерації ШІ.',GENERATION_INVALID_PLAN:'Перевір вибрані поля й вставки посилань.',not_configured:'Додайте ключ OpenAI у вкладці ШІ перед автоматичною генерацією.',AI_RESULT_UNCERTAIN:'Платний запит міг завершитися. Автоматичний повтор зупинено.',GENERATION_FAILED:'Не вдалося перевірити згенеровані тексти. Початкову сторінку збережено.',CAPACITY_EXCEEDED:'Досягнуто ліміт сторінок, включно із завданнями у черзі.',BACKUP_SECRET:'Резервна копія містить пароль у тексті. Прибери його з контенту перед експортом.',RESTORE_NOT_EMPTY:'Відновлення доступне лише у порожню базу.',PRECHECK_FAILED:'Свіжа перевірка сторінки не пройдена. Переглянь результати перевірок перед заміною.',VALIDATION:'Перевір поля форми та адреси.',NOT_FOUND:'Запис не знайдено.',CONFLICT:'Запис змінився. Онови список і повтори дію.',LEASE_CONFLICT:'Завдання вже обробляється іншим запуском.',KEY_REQUIRED:'Не налаштовано захищене зберігання доступів.',ENCRYPTION_UNAVAILABLE:'Не налаштовано захищене зберігання доступів.',auth_failed:'WordPress відхилив доступ. Перевір ім’я та пароль застосунку.',forbidden:'Недостатньо прав для цієї дії.',network_error:'Сайт не відповів. Повтори перевірку пізніше.',timeout:'Час перевірки вичерпано.',disabled:'Сайт вимкнено.',unsupported:'Цей тип завдання ще не підтримується.'};
function failure(code='VALIDATION'){const error=Error(message[code]||'Не вдалося виконати дію. Перевір налаштування сайту.');error.code=code;return error;}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
Object.assign(message,{GOOGLE_CLIENT_REQUIRED:'Спочатку налаштуйте вхід Google у підключеннях.',GOOGLE_CLIENT_INVALID:'Оберіть JSON OAuth-клієнта Google типу Desktop app.',GOOGLE_AUTH_REQUIRED:'Увійдіть у робочий Google-акаунт у підключеннях.',GOOGLE_AUTH_FAILED:'Google не підтвердив вхід. Повторіть підключення акаунта.',GOOGLE_AUTH_CANCELLED:'Вхід Google скасовано.',GOOGLE_AUTH_TIMEOUT:'Час входу Google минув. Натисніть «Увійти через Google» ще раз.',SOURCE_NOT_CONFIGURED:'Підключіть робочий або сервісний Google-акаунт до збереженої таблиці.',source_auth_failed:'Google не підтвердив доступ. Перевірте підключення обраного акаунта.',source_access_denied:'Обраний Google-акаунт не має доступу до таблиці (403). Надайте йому доступ на читання або оберіть інший акаунт.'});
const safeError=error=>({code:typeof error?.code==='string'&&/^[A-Za-z_]{1,50}$/.test(error.code)?error.code:'INTERNAL',message:message[error?.code]||ampErrorMessage(error?.code)||'Не вдалося виконати дію. Перевір підключення й налаштування сайту.'});
Object.assign(message,{BROWSER_CAPTCHA_REQUIRED:'Пройдіть CAPTCHA у відкритому вікні WordPress і натисніть «Продовжити». Поточне вікно збережено.',BROWSER_LOGIN_REQUIRED:'Завершіть вхід або додаткову перевірку у поточному вікні WordPress, потім натисніть «Продовжити».',BROWSER_BUSY:'Поточна сторінка ще не завершена. Наступні сторінки залишаються у черзі.'});
Object.assign(message,{source_rate_limited:'Google тимчасово обмежив читання таблиці. Повторні спроби вичерпано; частковий підбір не виконувався. Продовжіть пізніше.',source_read_aborted:'Читання Google-таблиці скасовано. Збережену сторінку можна продовжити пізніше.',GOOGLE_RATE_LIMITED:'Google тимчасово обмежив читання джерела. Повторні спроби вичерпано; повторіть імпорт пізніше.',GOOGLE_READ_ABORTED:'Читання джерела Google скасовано. Повторіть імпорт, коли будете готові.'});
Object.assign(message,{GOOGLE_BROWSER_REQUIRED:'Відкрийте підключення та увійдіть у Google через Chrome.',GOOGLE_BROWSER_AUTH_REQUIRED:'Завершіть вхід у Google у відкритому вікні Chrome.',GOOGLE_BROWSER_UNAVAILABLE:'Не вдалося відкрити Chrome. Перевірте встановлення браузера.',GOOGLE_BROWSER_READ_FAILED:'Не вдалося прочитати обрану вкладку Google-таблиці.',GOOGLE_BROWSER_ACCESS_DENIED:'Обраний акаунт не має доступу до цієї таблиці. Перевірте акаунт у Chrome.',GOOGLE_BROWSER_LIMIT:'Вкладка перевищує 100 000 рядків або 25 МБ. Створіть меншу вкладку для підбору або використайте підключення через API.',GOOGLE_SHEET_TAB_REQUIRED:'Вставте повне посилання на відкриту вкладку разом з gid.',source_sheet_not_found:'Вкладку з цього посилання не знайдено в Google-таблиці. Скопіюйте актуальну адресу.'});
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw failure();return {...value};}
Object.assign(message,proxyMessages);
async function input(request){const route=new URL(request.url).pathname,maxBody=route===PREFIX+'/backup/restore'?50010000:[PREFIX+'/project-import/preview',PREFIX+'/project-queue/import'].includes(route)?24*1024*1024:2*1024*1024;if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw failure();let total=0,parts=[];const reader=request.body?.getReader();if(!reader)throw failure();try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBody){await reader.cancel();throw failure();}parts.push(value);}}finally{reader.releaseLock();}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw failure();}}
function pageInput(body,store,projectId,previous){const allowed=['title','keyword','config','html','uniqueUrls','siteId','fullUrl','wpId','wpType','expectedRevision'];const value=fields(body,allowed);delete value.html;const urls=value.uniqueUrls;delete value.uniqueUrls;if(urls!==undefined){if(!Array.isArray(urls)||urls.some(v=>typeof v!=='string'||v.length>4000))throw failure();value.expectedUrls=[...new Set(urls)];}if(value.config!==undefined){if(!value.config||typeof value.config!=='object'||Array.isArray(value.config)||typeof value.config.title!=='string'||!Array.isArray(value.config.cards)||!Array.isArray(value.config.sections)||!Array.isArray(value.config.faq))throw failure();value.config=prepareConfig(value.config);value.expectedMarker='pp-landing';}
 const siteId=value.siteId||previous?.siteId;const fullUrl=value.fullUrl===undefined?previous?.fullUrl:value.fullUrl;
 if(fullUrl){let u;try{u=new URL(fullUrl);}catch{throw failure();}if(u.protocol!=='https:'||u.username||u.password||!siteId)throw failure();const site=store.getSite(siteId);if(!site||!store.siteBelongsToProject(projectId,site.id)||new URL(site.baseUrl).origin!==u.origin)throw failure();}
 if(value.wpId!==undefined&&value.wpId!==null&&(!Number.isSafeInteger(value.wpId)||value.wpId<1))throw failure();return value;}
export function finishMeasuredRead(store,job,input,measurement){
  if(job.effect!=='read'||!measurement)return store.finishJob(job.id,job.leaseToken,input);
  let timing;try{const created=Date.parse(job.createdAt),claimed=Date.parse(job.updatedAt),ended=Date.parse(measurement.endedAt);timing={timingScope:'worker_operation',workerStartedAt:measurement.startedAt,workerEndedAt:measurement.endedAt,workerElapsedMs:measurement.elapsedMs,queueWaitMs:Number.isFinite(created)&&Number.isFinite(claimed)&&claimed>=created?claimed-created:null,queueWaitScope:'job_created_to_claim_wall',jobLifetimeMs:Number.isFinite(created)&&Number.isFinite(ended)&&ended>=created?ended-created:null,networkMs:null};}catch{return store.finishJob(job.id,job.leaseToken,input);}
  try{return store.finishJob(job.id,job.leaseToken,{...input,result:{...input.result,timing}});}catch(error){
   // Optional metadata can be omitted if persistence rejects it. Never repeat
   // perform(), reclaim a job, or bypass the original completion lease token.
   try{const current=store.getJob(job.id);if(current?.state===input.state&&current.attempt===job.attempt)return current;}catch{}
   return store.finishJob(job.id,job.leaseToken,input);
  }
 }
export async function createLifecycleService({dataDir,masterKey,client=createWordPressClient(),clock=Date.now,workerIntervalMs=5000,monitorIntervalMs=21600000,bridgeClient,ai,autopilotOptions={},projectImporter,googleAuth,googleBrowser,googleClient=null,maxPages=1000,browserVerifier=createBrowserVerifier(),visibleBrowserEnabled=false,visibleBrowser=null,reviewBrowser=null,desktop=false,proxyOptions={},wordPressFactory=createWordPressUI,supportMetadata=null}={}){
 if(!dataDir)throw Error('Missing lifecycle dataDir');await mkdir(dataDir,{recursive:true});
 const proxies=await createProxySettings({dataDir,masterKey,clock,...proxyOptions});
 const candidateKey=run=>run?.candidate?.id?run.candidate.id+(run.manualTarget?'|'+(run.canonicalLogin?.requestedBaseUrl||run.manualTarget.baseUrl):''):null;
 const routeBinding=run=>run?.proxyBinding?.candidateKey===candidateKey(run)?run.proxyBinding:undefined;
 const usageRunId=run=>['native_update','published_trash'].includes(run?.kind)?run.originRunId:run?.id||null;
 function bindProxyMeter(session,{projectId,runId,attemptId}){
  if(session.route.mode!=='proxy')return session;
  const binding={projectId,runId,attemptId};
  const browser=meter.observer({...binding,scope:'browser'}),verification=meter.observer({...binding,scope:'verification'});
  return {...session,transport:(url,{proxyUsageScope,...options}={})=>
   session.transport(url,{...options,onProxyUsage:proxyUsageScope==='verification'?verification:browser})};
 }
 function saveProxyBinding(current,prior,route,identity){
  if(prior&&(route.mode!=='proxy'||prior.usageAttemptId))return prior;
  const binding={...identity,...route,...(route.mode==='proxy'?{usageAttemptId:randomUUID()}:{})};
  store.updateRecord(current.id,{proxyBinding:binding},current.revision);
  return binding;
 }
 async function publicationTransport({id}){
  const run=store.getRecord(id);
  if(['native_update','published_trash'].includes(run?.kind)){
   const origin=store.getRecord(run.originRunId),source=run.sourceBinding,key=JSON.stringify(source);
   const valid=()=>{const current=store.getRecord(run.originRunId);return current&&!current.deletedAt&&JSON.stringify(nativeUpdateSourceBinding(current))===key;};
   if(!valid()||publicationTurnOwner()?.id!==id)throw failure('PROXY_SESSION_CONFLICT');
   if(run.proxyBinding&&run.proxyBinding.sourceKey!==key)throw failure('PROXY_SESSION_CONFLICT');
   const previous=run.proxyBinding||routeBinding(origin);if(!previous&&proxies.status().enabled)throw failure('PROXY_SESSION_CONFLICT');
   const session=await proxies.open(id,{binding:previous});
   try{
    const binding=store.atomic(()=>{const latest=store.getRecord(id);if(!valid()||JSON.stringify(latest.sourceBinding)!==key||publicationTurnOwner()?.id!==id)throw failure('PROXY_SESSION_CONFLICT');return saveProxyBinding(latest,latest.proxyBinding,session.route,{sourceKey:key});});
    return bindProxyMeter(session,{projectId:run.projectId,runId:usageRunId(run),attemptId:binding.usageAttemptId});
   }catch(error){await session.close();throw error;}
  }
  const key=candidateKey(run);if(!key)throw failure('PROXY_SESSION_CONFLICT');
  const session=await proxies.open(id,{binding:routeBinding(run)});
  try{
   const binding=store.atomic(()=>{const latest=store.getRecord(id);if(candidateKey(latest)!==key)throw failure('CONFLICT');return saveProxyBinding(latest,routeBinding(latest),session.route,{candidateKey:key});});
   return bindProxyMeter(session,{projectId:run.projectId,runId:run.id,attemptId:binding.usageAttemptId});
  }
  catch(error){await session.close();throw error;}
 }
 const liveBrowser=visibleBrowser||(visibleBrowserEnabled?wordPressFactory({sessionTransportFactory:publicationTransport}):null);
 const editorBrowser=desktop?(reviewBrowser||(visibleBrowserEnabled?wordPressFactory({manualEditor:true,sessionTransportFactory:async({id,binding})=>{
  const session=await proxies.open(id,{binding:binding.route});
  return bindProxyMeter(session,{projectId:binding.projectId,runId:binding.runId,attemptId:randomUUID()});
 }}):null)):null;
 if(!dataDir)throw Error('Missing lifecycle dataDir');await mkdir(dataDir,{recursive:true});const store=createStore({filename:path.join(dataDir,'pageposter.sqlite'),masterKey,clock});let timer=null,active=null,closed=false,closePromise=null,suspended=false;const workerId=randomUUID();const workflow=createWorkflow({store,bridge:bridgeClient,maxPages,client,verifier:browserVerifier,artifactRoot:path.join(dataDir,'screenshots'),clock,beforeRemoteWrite:job=>autopilot.beforeRemoteWrite(job),browserSubmit:job=>autopilot.browserSubmit?.(job)||null,beforePublish:page=>{automation.beforePublish(page);autopilot.beforePublish(page);}});
 const meter=createProxyMetering(store);
 const automation=createRuns({filename:path.join(dataDir,'generation-runs.sqlite'),store,...(ai||{}),maxPages,clock});
 const campaigns=createCampaigns({store,automation,prepare:prepareCampaign,env:ai?.env||{},maxPages,clock});
 const adoption=createAdoption({store,bridge:bridgeClient,clock});const bridgeReadiness=bridgeClient||createBridgeClient({wordpressClient:client});
 const google=googleAuth||await createGoogleOAuth({dataDir,masterKey,clock,defaultClient:googleClient});
 const browserGoogle=googleBrowser||await createGoogleBrowser({dataDir,clock});
 const sourceController=new AbortController();
 const autopilot=await createAutopilot({store,dataDir,masterKey,ai,client,workflow,googleAuth:google,googleBrowser:browserGoogle,visibleBrowser:liveBrowser,hasActivePage:automation.hasActivePage,bridge:bridgeReadiness,maxPages,clock,manualPublishedReview:desktop,...autopilotOptions,sourceSignal:sourceController.signal});
 const publicationTurnOwner=()=>autopilot.publicationTurn?.owner();
 const nativeReplacements=createNativeReplacements({store,publicationTurn:autopilot.publicationTurn,clock,...(liveBrowser?.nativeEditor===true?{openSession:(id,baseUrl)=>liveBrowser.open(id,baseUrl),finishSession:id=>liveBrowser.reset(id)}:{})});workflow.attachNativeReplacements(nativeReplacements);
 const publishedTrash=desktop?createPublishedTrash({store,publicationTurn:autopilot.publicationTurn,browser:liveBrowser,hasActivePage:automation.hasActivePage,clock}):null;
 const openingEditors=new Map();
 function openWordPressEditor({page,site,owner,assertCurrent}){
  const id='review-'+page.id+'-'+page.revision+'-'+site.revision;
  if(openingEditors.has(id))return openingEditors.get(id);
  const pending=(async()=>{
   const credentials=store.getBrowserCredentials(site.id);
   if(!credentials?.username||!credentials.applicationPassword)throw failure('BROWSER_EDITOR_ACCESS');
   const binding={route:routeBinding(owner),projectId:page.projectId,runId:owner?.id||null};
   try{
    const session=await editorBrowser.open(id,site.baseUrl,{headless:false,binding});
    assertCurrent();
    if(session.baseUrl!==site.baseUrl)throw failure('BROWSER_ORIGIN_BLOCKED');
    await session.login(credentials);
    if(session.baseUrl!==site.baseUrl)throw failure('BROWSER_ORIGIN_BLOCKED');
    await session.openEditor(page.wpId,assertCurrent);
   }catch(error){
    if(['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code))await editorBrowser.focus(id).catch(()=>{});
    else await editorBrowser.reset(id).catch(()=>{});
    throw error;
   }
  })().finally(()=>openingEditors.delete(id));
  openingEditors.set(id,pending);
  return pending;
 }
 const projectQueue=createProjectQueue({store,autopilot,clock,manualPublishedReview:desktop,publishedTrash,openWordPressEditor:editorBrowser?openWordPressEditor:null,...(projectImporter?{importer:projectImporter}:{})}),generationTasks=new Set();
 const projectLifecycle=createProjectLifecycle({store,automation,campaigns,clock});
 const batches=createReplacementBatches({store,workflow});const monitor=createMonitorScheduler({store,clock,artifactRoot:path.join(dataDir,'screenshots')});let lastPrune=0;
 const needProject=id=>{if(!store.getProject(id))throw failure('NOT_FOUND');};
 function enqueue(type,entity,key){return monitor.enqueue(type,entity,key).job;}
 function maintain(shouldSchedule){if(shouldSchedule)monitor.schedule();else monitor.pauseScheduled();if(clock()-lastPrune>86400000){lastPrune=clock();for(const project of store.listProjects())store.pruneChecks(project.id,project.monitoringPolicy.retentionDays);monitor.pruneArtifacts().catch(()=>{});}}
 async function perform(job){if(job.payload?.mode==='native-update')return nativeReplacements.perform(job);const site=job.siteId&&store.getSite(job.siteId);if(!site)throw failure('NOT_FOUND');if(site.enabled===false&&!(job.type==='site_check'&&site.bootstrap?.restored))throw failure('disabled');const credentials=store.getSiteCredentials(site.id)||{};
  if(job.type==='adopt')return adoption.perform(job,site,credentials);
  if(job.effect==='write'){if(proxies.status().enabled)throw failure('PROXY_MODE_UNSUPPORTED');if(liveBrowser?.nativeEditor===true)autopilot.beforeRemoteWrite(job);return workflow.perform(job,site,credentials);}
  if(job.type==='site_check'){
   if(site.bootstrap?.mode==='browser'){const checks=[{kind:'wp_access',state:'not_applicable',evidence:'Browser-only connection. Public pages are checked separately; no API credential is stored.'}];monitor.complete(job,checks);return {state:'not_applicable',checks};}
   const result=await client.checkSite({baseUrl:site.baseUrl,...credentials});
   if(result.state==='ok'&&result.plugins&&result.apiRoot&&['active','discovered'].includes(result.plugins.bridge?.state)){
    try{
     const verified=await bridgeReadiness.checkStatus({site:{baseUrl:site.baseUrl,...credentials},apiRoot:result.apiRoot});
     for(const key of ['bridge','cleanLinks'])result.plugins[key]={...result.plugins[key],integrityVerified:verified.integrity?.[key]===true,compatible:verified.ready===true&&verified.integrityVerified===true&&result.plugins[key]?.compatible===true};
     result.bootstrap={state:verified.ready&&verified.integrityVerified?'ready':verified.integrityVerified?'update_required':'checksum_required'};
    }catch(error){for(const key of ['bridge','cleanLinks'])result.plugins[key]={...result.plugins[key],integrityVerified:false,compatible:false};result.bootstrap={state:'verification_required',code:safeError(error).code};}
   }
   const latest=store.getSite(site.id);const restoredReady=site.bootstrap?.restored&&result.state==='ok'&&result.bootstrap?.state==='ready';store.updateSite(site.id,{...(restoredReady?{enabled:true}:{}),status:result.plugins&&Object.values(result.plugins).some(p=>p.compatible!==true)?'setup_required':result.state||'unknown',capabilities:result.capabilities||{},plugins:result.plugins||{},bootstrap:{...(result.bootstrap||{}),...(site.bootstrap?.restored&&!restoredReady?{restored:true}:{})},lastCheckedAt:new Date(clock()).toISOString()},latest.revision);
   if(result.state==='problem'||result.code==='auth_failed')throw failure(result.code||'forbidden');monitor.complete(job,[{state:result.state||'unknown'}]);return result;
  }
  if(job.type==='page_check'){const page=store.getPage(job.pageId);if(!page||!page.fullUrl||page.siteId!==job.siteId)throw failure();
   const nativeUpdate=job.payload?.nativeUpdateId?store.getRecord(job.payload.nativeUpdateId):store.listRecords(page.projectId,'native_update').find(r=>r.pageId===page.id&&r.state==='checking'&&r.publishedRevision===page.revision);
   const run=nativeUpdate||store.listRecords(page.projectId,'autopilot').find(r=>r.pageId===page.id&&!r.deletedAt),binding=nativeUpdate?nativeUpdate.proxyBinding:routeBinding(run),inherited=run&&liveBrowser?.transportFor?.(run.id);
   const temporary=inherited?null:await proxies.open('verify:'+page.id,{binding});
   const activeTransport=inherited||bindProxyMeter(temporary,{projectId:page.projectId,runId:usageRunId(run),attemptId:binding?.usageAttemptId||job.id}).transport;
   const transport=(url,options)=>activeTransport(url,{...options,proxyUsageScope:'verification'});
   try{
   const checkClient=(binding?.mode==='proxy'||temporary?.route.mode==='proxy')?createWordPressClient({transport}):client;
   const publicOnly=page.remoteSnapshot?.mode==='browser',checks=await checkClient.checkPage({site:{baseUrl:site.baseUrl,...(publicOnly?{}:credentials)},page,...(publicOnly?{publicOnly:true}:{})});if(publicOnly)for(const kind of ['wp_access','wp_status','wp_content'])if(!checks.some(check=>check.kind===kind))checks.push({kind,state:'not_applicable',evidence:'Published content was verified in the native editor. This check reads only the public page.'});for(const check of checks)store.addCheck(page.id,{kind:check.kind,state:check.state,evidence:check.code?{detail:check.evidence,code:check.code}:check.evidence});const live=await browserVerifier.verifyPublished({url:page.fullUrl,page,expectedUrls:page.expectedUrls,expectedMarker:page.expectedMarker,artifactDir:path.join(dataDir,'screenshots',page.id),transport,...(run?.nativePluginFallback&&run.checkJobId===job.id&&run.nativePublication?.phase==='published'&&page.wpId===run.nativePublication.postId?{compareVisual:true}:{})});
   const screenshots=(live.viewports||[]).filter(v=>typeof v.screenshot?.path==='string'&&path.dirname(path.resolve(v.screenshot.path))===path.resolve(dataDir,'screenshots',page.id)).map(v=>({name:v.name,url:'/api/lifecycle/pages/'+page.id+'/screenshots/'+path.basename(v.screenshot.path)}));
   const browserCheck={kind:'live_browser',state:live.state||'unknown',evidence:safePublishedEvidence(live,screenshots)};
   store.addCheck(page.id,browserCheck);checks.push(browserCheck);
   if(run?.nativePluginFallback&&run.checkJobId===job.id&&page.wpId===run.nativePublication?.postId){const code=value=>typeof value==='string'&&/^[a-z_]{1,80}$/.test(value)?value:'visual_unconfirmed',visual=live.visual;const visualCheck={kind:'visual_layout',state:['ok','problem'].includes(visual?.state)?visual.state:'unknown',evidence:{code:code(visual?.code),viewports:(Array.isArray(visual?.viewports)?visual.viewports:[]).filter(v=>v.name==='desktop').map(v=>({name:v.name,state:['ok','problem'].includes(v.state)?v.state:'unknown',code:code(v.code)}))}};store.addCheck(page.id,visualCheck);checks.push(visualCheck);}
   const required=['public','content','wp_access','wp_status','wp_content','noindex','robots','links','live_browser'];
   for(const kind of required)if(!checks.some(c=>c.kind===kind))checks.push({kind,state:'unknown',evidence:{code:'missing_check'}});
   const verification=store.observeChecks(page.id,checks,page.revision);monitor.complete(job,checks);
   // A report is an optional private sidecar, never durable/public check data.
   // Do not rebind captured bytes to a page changed while verification ran.
   try{const current=store.getPage(page.id);if(current?.revision===page.revision)await writeLocalLinkReport(dataDir,current,live.localLinkReport,{verificationState:verification.state,capturedAt:new Date(clock()).toISOString()});}catch{}
   return {checks,verification};
   }finally{await temporary?.close();}}

  throw failure('unsupported');
 }
 async function tick({schedule:shouldSchedule=false,lane='all'}={}){if(closed||suspended)return;if(active)return active;const completion=(async()=>{
  store.recoverExpiredJobs();maintain(shouldSchedule);await campaigns.tick();if(closed||suspended)return;
  projectQueue.feed();if(lane!=='generation')await publishedTrash?.tick();await nativeReplacements.sync();await autopilot.tick({lane});if(lane==='all')await autopilot.selectPending();if(closed||suspended)return;
  await nativeReplacements.sync();const allowedWriteJobId=nativeReplacements.allowedWriteJobId();
  const job=store.claimJob({workerId,leaseMs:180000,...(allowedWriteJobId===undefined?{}:{allowedWriteJobId})});if(!job){if(closed||suspended)return;return automation.tick();}
  const timer=job.effect==='read'?createNativeTelemetry({clock}):null;let measurement=null;
  try{const result=await perform(job);measurement=timer?.finish();if(job.effect!=='write')finishMeasuredRead(store,job,{state:'completed',result},measurement);return {id:job.id,state:'completed'};}
  catch(error){measurement||=timer?.finish();const info=safeError(error);if(job.effect==='read'){monitor.complete(job,[{state:'unknown'}]);if(job.pageId){store.addCheck(job.pageId,{kind:'monitor',state:'unknown',evidence:{code:info.code}});store.observeChecks(job.pageId,[{kind:'monitor',state:'unknown'}]);}}try{finishMeasuredRead(store,job,{state:error?.uncertain?'uncertain':'failed',error:info,...(error?.writeNotAttempted===true&&job.effect==='write'&&(job.attempt===1||job.payload?.mode==='native-update')?{result:{writeNotAttempted:true}}:{})},measurement);}catch{}return{id:job.id,state:error?.uncertain?'uncertain':'failed'};}
 })().finally(async()=>{try{await nativeReplacements.sync();}finally{if(active===completion)active=null;}});active=completion;return completion;}
 const pump=()=>{if(closed||suspended)return;projectQueue.feed();const selection=autopilot.selectPending().catch(()=>{});generationTasks.add(selection);selection.finally(()=>generationTasks.delete(selection));for(let slot=0;slot<2;slot++){const task=autopilot.tick({lane:'generation',slot}).catch(()=>{});generationTasks.add(task);task.finally(()=>generationTasks.delete(task));}tick({lane:'publication'}).catch(()=>{});};
 const start=()=>{if(timer||closed)return;timer=setInterval(pump,workerIntervalMs);timer.unref?.();pump();};
 async function handle(request){const url=new URL(request.url),route=url.pathname.slice(PREFIX.length);if(!url.pathname.startsWith(PREFIX))return json({error:'Не знайдено.'},404);if(closed)return json({error:'Сервер зупинено.'},503);
  const method=request.method;const origin=request.headers.get('origin');if((origin&&origin!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Відкрий PagePoster у його власній вкладці.'},403);
  if(!['GET','HEAD'].includes(method)&&(origin!==url.origin||request.headers.get('X-PagePoster-Request')!=='1'))return json({error:'Запит має надійти з PagePoster.'},403);
  try{
   const linkReport=route.match(/^\/pages\/([a-zA-Z0-9-]+)\/link-report$/);
   if(linkReport&&method==='GET'){
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||request.headers.get('X-PagePoster-Request')!=='1'||origin!==url.origin&&request.headers.get('sec-fetch-site')!=='same-origin')return json({error:'Відкрийте звіт у локальному PagePoster.'},403);
    const revisions=url.searchParams.getAll('expectedRevision');if([...url.searchParams.keys()].some(k=>k!=='expectedRevision')||revisions.length!==1||!/^\d{1,12}$/.test(revisions[0]))throw failure();
    const page=store.getPage(linkReport[1]);if(!page)throw failure('NOT_FOUND');if(Number(revisions[0])!==page.revision)throw failure('CONFLICT');
    const report=await readLocalLinkReport(dataDir,page);if(store.getPage(page.id)?.revision!==page.revision)throw failure('CONFLICT');return json({report});
   }
   if(route==='/support/export'&&method==='POST'){
    fields(await input(request),[]);
    let metadata=null;try{metadata=typeof supportMetadata==='function'?await supportMetadata():null;}catch{}
    const report=store.readSnapshot(()=>createSupportReport({store,metadata,now:clock(),desktop}));
    return new Response(JSON.stringify(report),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="pageposter-support.json"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
   }
   if(route==='/proxy/settings'&&method==='GET')return json({proxy:proxies.status()});
   if(route==='/proxy/usage'&&method==='POST'){
    const body=fields(await input(request),['projectId','runId']);
    return json(store.readSnapshot(()=>{
     const usage=meter.proxyUsageSummary(body),run=body.runId?store.getRecord(body.runId):null;
     if(body.runId&&(run?.kind!=='autopilot'||run.projectId!==body.projectId||run.deletedAt))throw failure('NOT_FOUND');
     const binding=routeBinding(run);
     const route=binding?.mode==='proxy'?{label:binding.label,country:binding.country||null,...proxies.lastObservation(binding.proxyId)}:null;
     return {usage,route};
    }));
   }
   if(route==='/proxy/settings'&&method==='POST')return json({proxy:await proxies.save(await input(request))});
   if(route==='/proxy/checks'&&method==='GET')return json({check:proxies.checkStatus()});
   if(route==='/proxy/checks'&&method==='POST')return json({check:await proxies.check(await input(request))},202);
   if(route==='/proxy/checks/cancel'&&method==='POST'){const body=fields(await input(request),['id']);if(typeof body.id!=='string'||body.id.length>100)throw failure();return json({check:await proxies.cancelCheck(body.id)});}
   if(route==='/project-import/capabilities'&&method==='GET')return json(projectImportCapabilities({source:autopilot.status(),account:google.status(),serviceReady:!!autopilot.googleAccount()}));
   if(route==='/google/account'&&method==='GET')return json({account:google.status()});
   if(route==='/google/browser/account'&&method==='GET')return json({account:browserGoogle.status()});
   if(route==='/google/browser/close'&&method==='POST'){fields(await input(request),[]);autopilot.invalidateSelection();await browserGoogle.close();return json({account:browserGoogle.status()});}
   if(route==='/google/browser/connect'&&method==='POST'){const body=fields(await input(request),['spreadsheetUrl']);autopilot.invalidateSelection();const result=await browserGoogle.connect(body.spreadsheetUrl||autopilot.status().spreadsheetUrl);return json(result?.connectionUrl?result:{status:result});}
   if(route==='/google/browser/disconnect'&&method==='POST'){fields(await input(request),[]);autopilot.invalidateSelection();return json({account:await browserGoogle.disconnect()});}
   if(route==='/google/client'&&method==='POST'){const body=fields(await input(request),['client']);return json({account:await google.configure(body.client)});}
   if(['/google/connect','/google/cancel','/google/disconnect'].includes(route)&&method==='POST'){fields(await input(request),[]);autopilot.invalidateSelection();if(route==='/google/connect')return json(await google.start());return json({account:await(route==='/google/cancel'?google.cancel():google.disconnect())});}
   const projectAction=await projectLifecycle.handle(request,route,input);if(projectAction)return projectAction;
   const queueResult=await projectQueue.handle(request,route,input);if(queueResult)return queueResult;
   const screenshot=route.match(/^\/pages\/([a-zA-Z0-9-]+)\/screenshots\/(pageposter-[a-f0-9-]+-(?:desktop|mobile)\.png)$/);if(screenshot&&method==='GET'){if(!store.getPage(screenshot[1]))throw failure('NOT_FOUND');try{return new Response(await readFile(path.join(dataDir,'screenshots',screenshot[1],screenshot[2])),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{throw failure('NOT_FOUND');}}
   const autopilotResult=await autopilot.handle(request,route,input);if(autopilotResult)return autopilotResult;
   const adoptionResult=await adoption.handle(request,route,input);if(adoptionResult)return adoptionResult;
   const adoptionReconcile=route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/(reconcile|retry)$/);if(adoptionReconcile&&method==='POST'){const job=store.getJob(adoptionReconcile[1]);if(job?.type==='adopt'){fields(await input(request),[]);return json({job:await (adoptionReconcile[2]==='retry'?adoption.retry(job):adoption.reconcile(job))});}}
   const batchResult=await batches.handle(request,route,input);if(batchResult)return batchResult;
   if(route==='/sites'&&method==='GET')return json({sites:store.listAllSites()});
   const attach=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/sites\/link$/);if(attach&&method==='POST'){const body=fields(await input(request),['siteId']);return json({site:store.attachSite(attach[1],body.siteId)});}
   const campaignResult=await campaigns.handle(request,route,input);if(campaignResult)return campaignResult;
   const runResult=await automation.handle(request,route,input);if(runResult)return runResult;
   const workflowResult=await workflow.handle(request,route,input);if(workflowResult)return workflowResult;
   if(route==='/status'&&method==='GET')return json({available:true,runtime:desktop?'desktop':'local',automation:true,credentialStorage:!!masterKey,monitoring:{enabled:!!timer,mode:'on-demand',scheduled:false,requiresRunningServer:true},publication:true});
   const checkPages=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/check-pages$/);
   if(method==='POST'&&(route==='/check-pages'||checkPages)){fields(await input(request),[]);if(checkPages)needProject(checkPages[1]);return json(monitor.checkPages(checkPages?.[1]),202);}
   if(route==='/backup'&&method==='GET')return json(store.exportBackup());
   if(route==='/backup/restore'&&method==='POST'){const body=fields(await input(request),['backup']);return json({restored:store.restoreBackup(body.backup)},201);}
   if(route==='/projects'){if(method==='GET')return json({projects:store.listProjects()});if(method==='POST'){const body=fields(await input(request),['name','description','language','country','tags','responsible','archived','monitoringPolicy','siteSelection','workflowType']);return json({project:store.createProject(body)},201);}}
   const project=route.match(/^\/projects\/([a-zA-Z0-9-]+)(?:\/(sites|pages|jobs|events|overview))?$/);
   if(project){const id=project[1],kind=project[2];needProject(id);if(!kind){if(method==='GET')return json({project:store.getProject(id)});if(method==='PATCH'){const body=fields(await input(request),['name','description','language','country','tags','responsible','archived','monitoringPolicy','siteSelection','expectedRevision']);const revision=body.expectedRevision;delete body.expectedRevision;if(typeof body.archived==='boolean'&&body.archived!==store.getProject(id).archived){fields(body,['archived']);return projectLifecycle.respond(id,{action:body.archived?'close':'reopen',expectedRevision:revision});}return json({project:store.updateProject(id,body,revision)});}}
    if(method==='GET'&&kind==='overview') {
      const byPage=new Map();for(const check of store.listLatestProjectChecks(id)){if(!byPage.has(check.pageId))byPage.set(check.pageId,[]);byPage.get(check.pageId).push(check);}
      return json({pages:store.listPageSummaries(id).map(p=>({pageId:p.id,checks:byPage.get(p.id)||[],verification:p.verification})),incidents:store.listRecords(id,'incident'),runs:automation.runs.listRuns(id,{states:['queued','running','paused','uncertain','failed','review'],limit:1000}).map(r=>({id:r.id,pageId:r.spec.pageId,state:r.state,stage:r.stage,updatedAt:r.updatedAt}))});
    }
    if(method==='GET'){if(kind==='sites')return json({sites:store.listSites(id)});if(kind==='pages')return json({pages:url.searchParams.get('summary')==='1'?store.readSnapshot(()=>store.listPageSummaries(id)):store.listPages(id).map(nativeReplacements.decoratePage)});if(kind==='jobs')return json({jobs:store.listJobs(id)});if(kind==='events')return json({events:store.listEvents(id)});}
    if(method==='POST'&&kind==='sites')return json({site:store.createSite(id,fields(await input(request),['name','baseUrl','username','applicationPassword']))},201);
    if(method==='POST'&&kind==='pages')return json({page:store.createPage(id,pageInput(await input(request),store,id))},201);
   }
   const entity=route.match(/^\/(sites|pages)\/([a-zA-Z0-9-]+)(?:\/(check|checks))?$/);
   if(entity){const [_,kind,id,action]=entity;const item=kind==='sites'?store.getSite(id):store.getPage(id);if(!item)throw failure('NOT_FOUND');
    if(action==='check'&&method==='POST'){fields(await input(request),[]);if(kind==='pages'&&(!item.siteId||!item.fullUrl))throw failure();return json({job:enqueue(kind==='sites'?'site_check':'page_check',item)},202);}
    if(action==='checks'&&kind==='pages'&&method==='GET')return json({checks:store.listChecks(id)});
    if(!action&&method==='GET')return json({[kind==='sites'?'site':'page']:kind==='pages'?nativeReplacements.decoratePage(item):item});
    if(!action&&method==='PATCH'){let value=kind==='sites'?fields(await input(request),['name','enabled','username','applicationPassword','expectedRevision']):pageInput(await input(request),store,item.projectId,item);const revision=value.expectedRevision;delete value.expectedRevision;if(kind==='pages'&&['siteId','wpId','wpType','fullUrl'].some(k=>value[k]!==undefined&&value[k]!==item[k])&&(item.wpId||store.listJobs(item.projectId).some(j=>j.pageId===item.id&&j.effect==='write'&&['queued','running','uncertain','paused'].includes(j.state))))throw failure('CONFLICT');const updated=kind==='sites'?store.updateSite(id,value,revision):store.updatePage(id,value,revision);return json({[kind==='sites'?'site':'page']:updated});}
   }
   const pause=route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/(pause|resume)$/);if(pause&&method==='POST'){fields(await input(request),[]);return json({job:pause[2]==='resume'?store.resumeJob(pause[1]):store.pauseJob(pause[1])});}
   return json({error:'Ця дія недоступна.',code:'NOT_FOUND'},404);
  }catch(error){const info=safeError(error);return json({error:info.message,code:info.code},info.code==='CONFLICT'||info.code==='LEASE_CONFLICT'?409:info.code==='NOT_FOUND'?404:info.code==='INTERNAL'?500:400);}
 }
 function close(){if(closePromise)return closePromise;closed=true;sourceController.abort();if(timer)clearInterval(timer);timer=null;closePromise=(async()=>{await Promise.allSettled([browserGoogle.close(),google.close()]);if(active)await active.catch(()=>{});await Promise.allSettled([...generationTasks]);try{try{await liveBrowser?.close();}finally{await editorBrowser?.close();await Promise.allSettled([...openingEditors.values()]);}}finally{try{await proxies.close();}finally{automation.close();store.close();}}})();return closePromise;}
 async function quiesce(){suspended=true;if(active)await active.catch(()=>{});await Promise.allSettled([...generationTasks]);return ()=>{if(!closed)suspended=false;};}
 return {store,handle,tick,start,close,quiesce,automation,campaigns,batches,adoption,autopilot,projectQueue,nativeReplacements};
}
export function unavailableLifecycleResponse(){return json({available:false,runtime:'editor',credentialStorage:false,monitoring:{enabled:false},publication:false,message:'Проєкти й моніторинг доступні через локальний сервер PagePoster. Онлайн-сховище ще не підключено.'});}
