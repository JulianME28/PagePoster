import {normalizeEditorial} from './editorial-brief.mjs';
import {safeAIDiagnostics,aiDiagnosticMessage,safeAIOutputIssues,aiOutputMessage} from '../ai-diagnostics.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createSecretBox} from './secrets.mjs';
import {prepareConfig} from './workflow.mjs';
import {renderPage,isPreparedRendererTrusted} from './render.mjs';
import {buildAmpPayload,appendAmpPayload,renderAmpDocument} from './amp-mode.mjs';
import {initializeAmpValidator,validateAmpDocument} from './amp-validator.mjs';
import {checkAmpPair} from './amp-check.mjs';
import {createPreparedRenderCache} from './prepared-render-cache.mjs';
import {bridgeContentHash} from './bridge-client.mjs';
import {createAIPagePlanner} from './ai-page-planner.mjs';
import {createSiteSource,validateSiteSourceConfig,normalizeSiteCriteria,siteSourcePolicyIdentity} from './site-source.mjs';
import {createWordPressBootstrap} from './wordpress-bootstrap.mjs';
import {validatePublicUrl} from './network.mjs';
import {prepareCustomerHtml} from './customer-html.mjs';
import {describeSiteSelection} from './site-selection.mjs';
import {unusedDonorReservation} from './donor-reservations.mjs';
import {donorDomainKey} from './donor-domain.mjs';
import {rankDonorRecommendations} from './donor-recommendations.mjs';
import {allocateDonors} from './donor-allocation.mjs';
import {createDonorExclusions} from './donor-exclusions.mjs';
import {createManualExport} from './manual-export.mjs';
import {publishedCheckError} from './published-diagnostics.mjs';
import {createPublicationTurn} from './publication-turn.mjs';
import {canonicalLoginProofBase} from './wordpress-canonical-login.mjs';
import {proxyMessages} from './proxy-messages.mjs';
import {publicDonorSkip,publicPublication,safePublicationDiagnostics} from './publication-diagnostics.mjs';
import {isPreCreationDonorFailure,recoverSafeRead,safeReadRecoverable} from './publication-recovery.mjs';
import {createAccountCapabilityHistory} from './account-capabilities.mjs';
import {createNativeTelemetry} from './native-telemetry.mjs';
const KIND='autopilot',SOURCE_ID='pageposter:source:v1';
const googleReadMessages={source_rate_limited:'Google тимчасово обмежив читання таблиці. Повторні спроби вичерпано; частковий підбір не виконувався. Продовжіть пізніше.',source_read_aborted:'Читання Google-таблиці скасовано. Збережену сторінку можна продовжити пізніше.',GOOGLE_RATE_LIMITED:'Google тимчасово обмежив читання джерела. Повторні спроби вичерпано; повторіть імпорт пізніше.',GOOGLE_READ_ABORTED:'Читання джерела Google скасовано. Повторіть імпорт, коли будете готові.'};
// A standalone sandbox may navigate itself, but cannot open popups. Keep the
// exported HTML untouched and adapt only this disposable preview document.
const previewNavigation='<script data-pp-preview-navigation="1">document.querySelectorAll("#pp-landing a[href],#pp-landing [data-pp-url]").forEach(function(node){node.setAttribute("target","_self");if(node.hasAttribute("data-pp-url"))node.setAttribute("data-pp-target","_self");});</script>';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const messages={IMPORT_DONOR_UNAVAILABLE:'Вказаний у проєкті донор недоступний у базі або не відповідає вимогам.',NATIVE_SLUG_MISMATCH:'WordPress не підтвердив заданий слаг. Звірте адресу поточної сторінки.',AI_OUTPUT_INVALID:'ШІ повернув сторінку в непридатному форматі. Сторінку не підготовлено; посилання й анкори збережено.',source_limit_exceeded:"Діапазон таблиці перевищує 100 000 рядків. Звузьте діапазон до 100 000 рядків або менше. Частковий підбір не виконується.",source_auth_failed:"Google не підтвердив доступ сервісного акаунта. Перевірте файл акаунта й доступ до таблиці.",source_read_failed:"Не вдалося прочитати Google-таблицю. Перевірте її адресу, назву вкладки, діапазон і доступ сервісного акаунта.",source_validation:"Перевірте діапазон, колонки таблиці й критерії підбору сайту.",source_response_invalid:"Google-таблиця повернула непідтримувані дані. Перевірте вкладку й діапазон.",REVIEW_REQUIRED:'Відкрийте актуальний попередній перегляд і підтвердьте публікацію цієї версії сторінки.',HTML_REVIEW_REQUIRED:'Обробка HTML змінилася після перегляду. Створіть новий запуск і перевірте оновлений попередній перегляд.',CUSTOMER_HTML_INVALID:'Не вдалося підготувати HTML. Перевірте код і адреси ресурсів.',SOURCE_NOT_CONFIGURED:"Спочатку підключіть сервісний акаунт до збереженої Google-таблиці.",SOURCE_EMPTY:"У таблиці немає доступних невикористаних сайтів, які відповідають критеріям проєкту.",AI_RESULT_UNCERTAIN:'Відповідь ШІ не підтверджено. Автоматичне повторення зупинено, щоб не оплатити запит двічі.',not_configured:'Підключіть ключ OpenAI у налаштуваннях.',CONTENT_DUPLICATE:'ШІ повторив текст раніше створеної сторінки. Публікацію зупинено.',CONTENT_FACT_REVIEW_REQUIRED:'У тексті є непідтверджені твердження. Публікацію зупинено.',SITE_NOT_READY:'WordPress не пройшов перевірку доступу й плагінів.',CHECK_FAILED:'Сторінку опубліковано, але не всі перевірки пройдено. Відкрийте результати перевірки.',VALIDATION:'Перевірте адреси й анкори.',CONFLICT:'Запуск змінився або вже виконується.',KEY_REQUIRED:'Не налаштовано шифрування підключень.',AI_AUTH_FAILED:'Ключ OpenAI не прийнято. Перевірте налаштування.',AI_ACCESS_DENIED:'OpenAI відхилив доступ (HTTP 403). Перевірте дозволи API-проєкту й доступність вибраної моделі в акаунті.',AI_BUDGET_EXCEEDED:'Досягнуто ліміту витрат на ШІ.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Можна продовжити пізніше.',AI_PROVIDER_UNAVAILABLE:'OpenAI зараз недоступний.',RESTORED_PAUSED:'Запуск відновлено з резервної копії. Продовжіть його вручну.'};
Object.assign(messages,{SOURCE_RESERVED:'На цьому сайті вже є незавершена публікація. Завершіть її або вкажіть інший сайт.',bootstrap_auth_failed:'WordPress не прийняв логін або пароль. Перевірте дані доступу.'});
Object.assign(messages,{DONOR_MANUALLY_BLOCKED:'Донор у ручному стоп-листі. Зніміть заборону або оберіть інший сайт.',DONOR_POLICY_BLOCKED:'Донор має чинне обмеження. Перегляньте стоп-лист і причину.',SOURCE_POLICY_SCAN_LIMIT:'Джерело не дало завершити перевірку обмежень. Оновіть базу донорів.'});
Object.assign(messages,{BROWSER_UNAVAILABLE:'Не вдалося відкрити Chrome або Edge. Установіть браузер і продовжіть збережений запуск.',BROWSER_CLOSED:'Вікно WordPress закрито. Продовжіть збережений запуск, щоб відкрити його знову. Уже надіслана дія може завершитися; програма спочатку перевірить її результат.',BROWSER_NOT_OPEN:'Вікно WordPress ще не відкрито або сервер було перезапущено. Продовжіть збережений запуск.',BROWSER_LOGIN_REQUIRED:'У вікні WordPress не вдалося підтвердити вхід. Перевірте логін, пароль і вимоги сайту.',BROWSER_ACTION_FAILED:'Дія у вікні WordPress не завершилася. Вікно залишено відкритим для перевірки.',BROWSER_TIMEOUT:'WordPress не завершив дію за відведений час. Перевірте відкрите вікно.',BROWSER_ORIGIN_BLOCKED:'WordPress запропонував перехід на інший сайт або непідтримувану дію. Виконання зупинено.'});
const fail=code=>{throw Object.assign(Error(code),{code});};
Object.assign(messages,googleReadMessages);
Object.assign(messages,proxyMessages);
Object.assign(messages,{BROWSER_CAPTCHA_REQUIRED:'Пройдіть CAPTCHA у відкритому вікні WordPress, потім натисніть «Продовжити». Вікно та поточна сторінка збережені; наступні сторінки чекають.',BROWSER_LOGIN_REQUIRED:'Завершіть вхід або додаткову перевірку у поточному вікні WordPress і натисніть «Продовжити». Наступні сторінки чекають.',BROWSER_BUSY:'Спочатку завершіть поточну сторінку у відкритому вікні WordPress. Інші сторінки залишаються у черзі.'});
messages.BROWSER_LOGIN_UNCONFIRMED='WordPress повернув відповідь, за якою не вдалося підтвердити вхід. Повторіть спробу або змініть сайт.';
messages.NATIVE_NAVIGATION_UNAVAILABLE='У WordPress немає доступної кнопки створення сторінки.';
Object.assign(messages,{BROWSER_EDITOR_UNAVAILABLE:'WordPress не відкрив стандартний редактор сторінки. Перевірте відкрите вікно й права акаунта. Готовий HTML збережено.',BROWSER_EMAIL_CONFIRMATION_REQUIRED:'WordPress просить підтвердити email адміністратора й не пропонує «Нагадати пізніше». Адресу не змінено; перевірте відкрите вікно.',BROWSER_PUBLICATION_UNCERTAIN:'Форму публікації надіслано, але результат не підтверджено. Під час продовження програма спочатку перевірить наявну операцію, щоб не створити дублікат.',pp_bridge_nonce:'Сесія редактора WordPress закінчилася. Продовжіть збережений запуск, щоб увійти знову.'});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
Object.assign(messages,{SOURCE_NOT_CONFIGURED:'Підключіть робочий або сервісний акаунт Google до збереженої таблиці.',source_auth_failed:'Google не підтвердив доступ вибраного акаунта. Перевірте підключення.',source_read_failed:'Не вдалося прочитати Google-таблицю. Перевірте вкладку, діапазон і доступ вибраного акаунта.',source_access_denied:'Вибраний Google-акаунт не має доступу до таблиці (403). Надайте йому доступ для читання або виберіть інший акаунт.',GOOGLE_AUTH_REQUIRED:'Увійдіть у робочий Google-акаунт у налаштуваннях.',GOOGLE_AUTH_FAILED:'Google не підтвердив вхід. Підключіть робочий акаунт ще раз.',GOOGLE_CLIENT_REQUIRED:'Спочатку налаштуйте вхід Google у налаштуваннях.'});
Object.assign(messages,{source_sheet_not_found:'Вкладку з цього посилання не знайдено. Скопіюйте повну актуальну адресу потрібної вкладки.',source_limit_exceeded:'Джерело перевищує обмеження читання. Для входу через Chrome використовуйте вкладку до 100 000 рядків і 25 МБ; для API можна обмежити діапазон.',GOOGLE_BROWSER_REQUIRED:'Увійдіть у робочий Google-акаунт через Chrome у налаштуваннях.',GOOGLE_BROWSER_AUTH_REQUIRED:'Завершіть вхід у Google у відкритому вікні Chrome.',GOOGLE_BROWSER_READ_FAILED:'Не вдалося прочитати вибрану вкладку. Перевірте посилання й доступ акаунта в Chrome.',GOOGLE_BROWSER_IMPORT_UNSUPPORTED:'Вхід через Chrome використовується для бази сайтів. Імпортуйте локальні HTML або CSV; для Google Drive виберіть OAuth або сервісний акаунт у налаштуваннях.'});
Object.assign(messages,{
 NATIVE_EDITOR_UNAVAILABLE:'Не вдалося відкрити стандартний редактор сторінок WordPress. Перевірте вікно браузера; HTML збережено.',
 NATIVE_EDITOR_CONTENT_PENDING:'Редактор WordPress ще не підтвердив введені назву та HTML. Публікацію не відправлено; поточний чернетковий запис збережено.',
 NATIVE_PUBLISH_NOT_SENT:'WordPress не відправив публікацію. Натисніть «Повторити», щоб продовжити з цієї чернетки.',
 NATIVE_RESULT_UNCERTAIN:'Результат публікації не підтверджено. Продовження спочатку перевірить збережену сторінку WordPress, щоб не створити дублікат.',
 NATIVE_CONTENT_CHANGED:'Заголовок або HTML у WordPress не збігається з підтвердженою версією. Публікацію не підтверджено; перевірте наявну сторінку.',
 NATIVE_NOT_PUBLISHED:'WordPress показує збережену чернетку. Результат попереднього надсилання не підтверджено.',
 NATIVE_CHECKPOINT_REQUIRED:'Не вдалося зберегти ідентифікатор сторінки перед публікацією. Надсилання зупинено.',
 NATIVE_LEGACY_PUBLICATION:'Запуск уже має попередню операцію публікації. Перевірте її результат перед подальшими діями; нова сторінка автоматично не створюється.',
 NATIVE_VISUAL_UNCONFIRMED:'Не вдалося однозначно перевірити вигляд сторінки на комп’ютері. Сторінка збережена; автоматичне видалення та зміна донора не виконувалися.',
 NATIVE_TRASH_UNCERTAIN:'Переміщення створеної сторінки в кошик ще не підтверджено. Тул спочатку перевірить саме цю сторінку; іншого донора поки не використовує.',
 NATIVE_VISUAL_REJECTED:'Створена сторінка мала зламаний вигляд і підтверджено переміщена в кошик. HTML збережено для іншого донора.',
 CLEAN_LINKS_NOT_ACTIVE:'Clean Links установлено, але його активацію не підтверджено. Перевірте відкрите вікно WordPress.',
 CLEAN_LINKS_NOT_INSTALLED:'Не вдалося підтвердити встановлення Clean Links. Перевірте відкрите вікно WordPress.',
 AMP_PLUGIN_REQUIRED:'Для AMP потрібна експериментальна версія Clean Links 1.2.1. Підтримку AMP на сайті не підтверджено; сторінку не створено.',
 AMP_VALIDATION_FAILED:'AMP-копія не пройшла офіційну перевірку. Звичайний HTML збережено. Вимкніть AMP для цього проєкту або виправте матеріал.',
 AMP_UNSUPPORTED_CONTENT:'У матеріалі є елементи, які цей AMP-режим ще не підтримує. Звичайна публікація залишається доступною.',
 AMP_EXTERNAL_STYLES_REQUIRED:'AMP-режим потребує стилів усередині HTML. Зовнішні CSS-файли автоматично не завантажуються.',
 AMP_IMAGE_DIMENSIONS_REQUIRED:'Для AMP потрібні ширина й висота кожного зображення. Додайте їх у HTML або використайте звичайний режим.',
 AMP_CSS_LIMIT:'Стилі перевищують ліміт AMP у 75 000 байтів. Звичайний HTML не змінено.',
 AMP_VALIDATOR_UNAVAILABLE:'Локальний AMP-валідатор недоступний або пошкоджений. Відновіть збірку PagePoster.',
 CLEAN_LINKS_UPDATE_REQUIRED:'Оновіть PagePoster Clean Links до версії 1.1.3. Вона містить шаблон для готового HTML; стара версія може залишити сторінку порожньою.',
 CLEAN_LINKS_PACKAGE_INVALID:'Архів Clean Links відсутній або не пройшов перевірку. Відновіть архів плагіна в PagePoster.',
 CLEAN_LINKS_FILESYSTEM_REQUIRED:'WordPress запитує доступ до файлової системи для встановлення Clean Links. Завершіть цей крок у відкритому вікні.',
 CLEAN_LINKS_INSTALL_FORBIDDEN:'У акаунта немає прав установити Clean Links. Тул спробує запасний акаунт, якщо він є, потім опублікує HTML і перевірить вигляд.',
 SOURCE_REPLACEMENTS_EXHAUSTED:'Перевірено 10 сайтів: вхід або вигляд опублікованої сторінки не підійшли. Готовий HTML збережено.',
 BROWSER_PAGE_UNAVAILABLE:'Сторінка WordPress недоступна в браузері. Перевірте адресу й відкрите вікно.'
});
const fields=(o,keys)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k)))fail('VALIDATION');return o;};
export function validateAutopilotLinks(links){
 if(!Array.isArray(links)||!links.length||links.length>20)fail('VALIDATION');
 return links.map(link=>{fields(link,['url','anchor']);if(typeof link.url!=='string'||link.url.length>4000||link.url!==link.url.trim()||/[\s\u0000-\u001f]/.test(link.url)||typeof link.anchor!=='string'||!link.anchor.trim()||link.anchor.length>300||/[\u0000-\u001f]/.test(link.anchor))fail('VALIDATION');let u;try{u=new URL(link.url);}catch{fail('VALIDATION');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)fail('VALIDATION');return {url:link.url,anchor:link.anchor};});
}
function sourceInput(body,preview=false){
 fields(body,preview?['source','html','baseUrl','brand','brandUrl','chromeMode']:['idempotencyKey','links','source','html','baseUrl','brand','brandUrl','chromeMode','reviewToken','reviewBeforePublish','editorial']);
 if(body.reviewBeforePublish!==undefined&&typeof body.reviewBeforePublish!=='boolean')fail('VALIDATION');
 const source=body.source??'ai',chromeMode=body.chromeMode??'custom';
 if(!['ai','html'].includes(source)||!['custom','overlay-only'].includes(chromeMode))fail('VALIDATION');
 if(source==='ai'){
  if(preview||['html','baseUrl','brand','brandUrl','reviewToken'].some(k=>body[k]!==undefined))fail('VALIDATION');
  return {source,chromeMode,links:validateAutopilotLinks(body.links),...(body.editorial!==undefined?{editorial:normalizeEditorial(body.editorial)}:{})};
 }
 if(body.links!==undefined||body.editorial!==undefined)fail('VALIDATION');
 return {source,chromeMode,html:body.html,baseUrl:body.baseUrl??'',brand:body.brand??'',brandUrl:body.brandUrl??''};
}
function renderedHash(rendered){return createHash('sha256').update(JSON.stringify({html:rendered.html,title:rendered.title,expectedUrls:rendered.expectedUrls})).digest('hex');}
function manualDestination(body){
 fields(body,['baseUrl','username','password','expectedRevision']);
 if(typeof body.baseUrl!=='string'||body.baseUrl.length>2000||typeof body.username!=='string'||!body.username.trim()||body.username.length>200||/[:\u0000-\u001f]/.test(body.username)||typeof body.password!=='string'||!body.password.trim()||body.password.length>4096||/[\u0000-\u001f]/.test(body.password))fail('MANUAL_SITE_INVALID');
 if(body.expectedRevision!==undefined&&(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0))fail('MANUAL_SITE_INVALID');
 const address=body.baseUrl.trim(),input=address.includes('://')?address:'https://'+address;
 let url;try{url=validatePublicUrl(input);}catch{fail('MANUAL_SITE_INVALID');}
 if(url.search||url.hash)fail('MANUAL_SITE_INVALID');
 url.pathname=url.pathname.replace(/\/(?:wp-admin(?:\/index\.php)?\/?|wp-login\.php)$/i,'/');
 if(!url.pathname.endsWith('/'))url.pathname+='/';
 return {baseUrl:url.href,username:body.username.trim(),password:body.password};
}
function destinationBlockedReason(run,store){
 if(run.deletedAt||!run.pageId||store.getProject(run.projectId)?.archived)return 'Сторінка недоступна для зміни сайту.';
 if(run.nativePublication&&run.nativePublication.phase!=='draft')return 'Публікацію могло бути надіслано. Спочатку перевірте наявну сторінку; зміну сайту заблоковано.';
 if(run.state==='uncertain')return 'Результат попередньої дії не підтверджено. Спочатку перевірте його результат; зміну сайту заблоковано.';
 const queuedBeforeWordPress=run.state==='queued'&&['selecting','installing'].includes(run.stage)&&!run.browserWindow&&!run.bootstrapStage&&!run.apiCredential&&!run.nativePublication&&!run.jobId&&!run.siteId;
 if(run.leaseToken||run.browserPreparing||!['selecting','installing','publishing'].includes(run.stage)||!['failed','needs_attention','paused','awaiting_review','waiting_source'].includes(run.state)&&!queuedBeforeWordPress&&!canDeleteRun(run,store))return 'Дочекайтеся зупинки поточного запуску перед зміною сайту.';
 const page=store.getPage(run.pageId);if(!page||page.wpId||page.fullUrl||run.checkJobId)return 'Публікацію вже створено або її результат перевіряється. Зміна сайту недоступна.';
 const jobs=store.listJobs(run.projectId).filter(job=>job.pageId===page.id);
 if(run.jobId&&!jobs.some(job=>job.id===run.jobId)||jobs.some(job=>job.effect==='write'?!(job.type==='publish'&&job.state==='failed'&&job.attempt===1&&job.result?.writeNotAttempted===true):['queued','running','paused','uncertain'].includes(job.state)))return 'Попередня публікація виконується або могла бути надіслана. Спочатку перевірте її результат; зміну сайту заблоковано.';
 return '';
}
function canSetDestination(run,store){return !destinationBlockedReason(run,store);}
function verifyCustomerOutput(run,rendered,page){if(run.source==='html'&&(renderedHash(rendered.ampOriginalHtml?{...rendered,html:rendered.ampOriginalHtml}:rendered)!==run.approvedHtmlHash||page&&(page.title!==rendered.title||page.wpType!=='page')))fail('HTML_REVIEW_REQUIRED');}
// Publication approval is distinct from the customer-input import proof. It binds
// the exact prepared render and page revision, including metadata used by the write.
const preparedRender=createPreparedRenderCache(config=>renderPage(prepareConfig(config)),isPreparedRendererTrusted);
const ampRenderCache=new Map();
function preparedSnapshot(run,store){
 const page=run.pageId&&store.getPage(run.pageId);if(!page)fail('NOT_FOUND');
 let rendered=preparedRender(store,page.config);
 if(run.ampMode===true){
  const key=renderedHash(rendered)+'|'+(run.language||'en');let prepared=ampRenderCache.get(key);
  if(!prepared){const payload=buildAmpPayload({html:rendered.html,title:rendered.title,language:run.language||'en'});validateAmpDocument(renderAmpDocument(payload,'https://pageposter.invalid/amp-validation/'));prepared={...rendered,ampOriginalHtml:rendered.html,html:appendAmpPayload(rendered.html,payload)};if(ampRenderCache.size>=16)ampRenderCache.delete(ampRenderCache.keys().next().value);ampRenderCache.set(key,prepared);}rendered=prepared;
 }
 const materialHash=createHash('sha256').update(JSON.stringify({renderedHash:renderedHash(rendered),title:page.title,...(run.slug?{slug:run.slug}:{}),postType:page.wpType,expectedUrls:page.expectedUrls,destinationRevision:run.destinationRevision||0,siteSelection:normalizeSiteCriteria(run.siteSelection),...(run.manualTarget?{destination:run.manualTarget}:{}),...(run.queueItemId&&run.candidate?{selectedSite:{id:run.candidate.id,baseUrl:run.candidate.baseUrl}}:{})})).digest('hex');
 const reviewToken=createHash('sha256').update(JSON.stringify({runId:run.id,pageId:page.id,pageRevision:page.revision,materialHash})).digest('hex');
 return {page,rendered,materialHash,reviewToken};
}
// A completed native page can have reviewed URL-only updates while its original
// imported configuration remains intact. Copy/preview the confirmed bytes.
function readPreparedSnapshot(run,store){
 const snapshot=preparedSnapshot(run,store),page=snapshot.page,raw=page.remoteSnapshot;
 if(run.state!=='completed'||raw?.mode!=='browser')return snapshot;
 const title=raw.title??page.title,postId=raw.postId??page.wpId,url=raw.url??page.fullUrl;
 const legacy=typeof raw.content==='string'?createHash('sha256').update(JSON.stringify([raw.postType,title,raw.content,raw.status])).digest('hex'):null;
 if(raw.status!=='publish'||raw.postType!=='page'||postId!==page.wpId||title!==page.title||url!==page.fullUrl||typeof raw.content!=='string'||![legacy,bridgeContentHash({...raw,title})].includes(raw.contentHash))fail('NATIVE_SNAPSHOT_UNAVAILABLE');
 return {...snapshot,reviewToken:null,rendered:{...snapshot.rendered,html:raw.content,title,expectedUrls:page.expectedUrls,expectedMarker:page.expectedMarker||'pp-landing'}};
}
function verifyPublicationApproval(run,store,snapshot){
 if(!run.reviewBeforePublish)return;
 const current=snapshot||preparedSnapshot(run,store),approval=run.publicationApproval;
 if(!approval||approval.pageId!==current.page.id||approval.materialHash!==current.materialHash||(!run.jobId&&(run.nativePublishedRevision??approval.pageRevision)!==current.page.revision))fail('REVIEW_REQUIRED');
 // Once enqueued, the immutable job is the authorized snapshot. The workflow also
 // fences its page revision immediately before dispatching the remote write.
 if(run.jobId){const job=store.getJob(run.jobId),expectedRevision=job?.state==='completed'?job.result?.pageRevision:job?.payload.expectedRevision;if(!job||job.pageId!==approval.pageId||job.payload.requestRevision!==approval.pageRevision||current.page.revision!==expectedRevision||job.payload.operation.title!==current.page.title||job.payload.operation.postType!==current.page.wpType||job.payload.operation.content!==current.rendered.html)fail('REVIEW_REQUIRED');}
 return current;
}
function customerPreview(input){
 const {source,...customerInput}=input;const prepared=prepareCustomerHtml(customerInput);if(prepared.error)fail('CUSTOMER_HTML_INVALID');
 let rendered;try{rendered=renderPage(prepareConfig(prepared.config));}catch(error){if(error.code)throw error;fail('CUSTOMER_HTML_INVALID');}
 const reviewToken=createHash('sha256').update(JSON.stringify({input,html:rendered.html,warnings:prepared.warnings,outputHash:renderedHash(rendered)})).digest('hex');
 return {config:rendered.config,html:rendered.html,title:rendered.title,warnings:prepared.warnings,reviewToken,approvedHtmlHash:renderedHash(rendered)};
}
// Only explicit public fields leave the runtime. Candidate passwords and checkpoints never do.
function canDeleteRun(run,store){
 const reservedOnly=run.queueItemId&&run.reviewBeforePublish&&!run.publicationApproval&&run.state==='awaiting_review'&&run.stage==='installing'&&!run.browserWindow&&!run.nativePublication;
 if(run.deletedAt||run.leaseToken||run.jobId||run.checkJobId||run.siteId||run.candidate&&!reservedOnly||run.bootstrapStage||run.apiCredential)return false;
 if(!reservedOnly&&!['generating','preparing','selecting'].includes(run.stage)||!['queued','failed','uncertain','paused','needs_attention','awaiting_review','waiting_source'].includes(run.state))return false;
 const page=run.pageId&&store.getPage(run.pageId);
 return !run.pageId||!!page&&!page.wpId&&!page.fullUrl&&!page.siteId&&!store.listJobs(run.projectId).some(job=>job.pageId===page.id);
}
function publicRun(run,store){const page=run.pageId&&store.getPage(run.pageId);return {id:run.id,revision:run.revision,publication:publicPublication(run,page),projectId:run.projectId,state:run.state,stage:run.stage,source:run.source||'ai',chromeMode:run.chromeMode||'custom',warnings:run.warnings||[],links:run.links,...(run.editorial?{editorial:run.editorial}:{}),title:page?.title||run.title||'',pageId:run.pageId||null,jobId:run.jobId||null,fullUrl:page?.fullUrl||'',selectedDomain:run.candidate?.baseUrl||run.manualTarget?.baseUrl||'',skippedSites:(run.donorSkips||[]).map(s=>({...publicDonorSkip(s),message:messages[s.code]||s.code})),browserWindow:run.browserWindow===true,browserMode:run.browserMode||'visible',destinationBlockedReason:destinationBlockedReason(run,store),destinationMode:run.manualTarget?'manual':'sheet',destinationRevision:run.destinationRevision||0,donorPinned:run.donorPinned===true,canSetDestination:canSetDestination(run,store),hasHtml:!!run.pageId,reviewBeforePublish:run.reviewBeforePublish===true,canDelete:canDeleteRun(run,store),canApprove:run.reviewBeforePublish===true&&!!page&&run.state==='awaiting_review'&&!run.jobId&&(!run.nativePublication||run.nativePublication.phase==='draft')&&!store.getProject(run.projectId)?.archived,pluginFallback:run.nativePluginFallback?{code:run.nativePluginFallback.code,message:'Clean Links недоступний. Вигляд сторінки перевіряється окремо.'}:null,cleanupPhase:run.nativeCleanup?.phase||null,verification:page?.verification||null,error:publishedCheckError(run.error?{...run.error,message:aiOutputMessage(run.error.issues)||aiDiagnosticMessage(run.error.diagnostics)||messages[run.error.code]||run.error.message}:null,page?.verification),selectionDiagnostics:run.selectionDiagnostics||null,createdAt:run.createdAt,updatedAt:run.updatedAt};}
export async function createAutopilot({store,dataDir,masterKey,ai={},client,bridge,workflow,visibleBrowser=null,hasActivePage=()=>false,planner=ai.handler?createAIPagePlanner(ai):{generate:async()=>fail('not_configured')},source,sourceSignal,googleAuth=null,googleBrowser=null,bootstrapFactory=createWordPressBootstrap,maxPages=1000,clock=Date.now,manualPublishedReview=false,ampValidatorInit=initializeAmpValidator}={}){
 if(store.listProjects().some(project=>store.getRecord('amp-mode:'+project.id)?.enabled)){try{await ampValidatorInit();}catch{ /* Optional AMP must never prevent ordinary workspace startup. */ }}
 const ampModeChanges=new Set();
 const box=masterKey?createSecretBox(masterKey):null,capabilityHistory=masterKey?createAccountCapabilityHistory({store,masterKey,clock}):null,sourceFile=path.join(dataDir,'autopilot-source.json'),browserSettingsFile=path.join(dataDir,'autopilot-browser-settings.json');let sourceConfig=null,browserMode='visible',publicationCurrent=null;const workerId=randomUUID(),activeLeases=new Map(),busyLanes=new Set(),lastProjects=new Map();
 try{const saved=JSON.parse(await readFile(browserSettingsFile,'utf8'));if(['visible','hidden'].includes(saved.mode))browserMode=saved.mode;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{const envelope=JSON.parse(await readFile(sourceFile,'utf8'));if(!box)fail('KEY_REQUIRED');sourceConfig=JSON.parse(box.decrypt(SOURCE_ID,envelope).applicationPassword);}catch(e){if(e.code!=='ENOENT')throw e;}
 const allRuns=()=>store.listProjects().flatMap(p=>store.listRecords(p.id,KIND));
 const donorExclusions=masterKey?createDonorExclusions({store,masterKey,clock,allRuns}):null;
 const publicationTurn=createPublicationTurn({store,allRuns,enabled:visibleBrowser?.nativeEditor===true,clock,closeBrowser:id=>visibleBrowser?.reset?.(id),hasActivePage,canCloseBrowser:typeof visibleBrowser?.reset==='function',isActive:id=>activeLeases.has(id),manualPublishedReview});publicationTurn.adoptLegacy();
 const get=id=>{const run=store.getRecord(id);if(!run||run.kind!==KIND||run.deletedAt)fail('NOT_FOUND');return run;};
 const update=(id,patch)=>store.atomic(()=>{const run=get(id),lease=activeLeases.get(id);if(lease&&(run.leaseToken!==lease.token||Date.parse(run.leaseUntil)<=clock()))fail('LEASE_CONFLICT');const manual=visibleBrowser?.nativeEditor&&['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(patch.error?.code),destinationChanged=patch.destinationRevision!==undefined&&patch.destinationRevision!==(run.destinationRevision||0)&&!patch.canonicalLogin;const saved=store.updateRecord(id,{...(destinationChanged?{publicationRecovery:null,publicationEvidence:null,publicationCapabilities:null,capabilityHistoryId:null,capabilityAccountRef:null,publicationCheckedJob:null,nativeDispatchNotStarted:null}:{}),...patch,...(manual?{browserWindow:true}:{})},run.revision);return manual?beginManualWait(saved)||saved:saved;});
 const publicationComplete={state:'completed',stage:'completed',error:null,checkJobId:null,candidateCredential:null};
 async function closeCompletedPublication(run){
  if(manualPublishedReview){
   await visibleBrowser?.reset?.(run.id);
   if(run.browserWindow)update(run.id,{browserWindow:false});
  }else if(visibleBrowser)await visibleBrowser.done(run.id).catch(()=>{});
  publicationTurn.complete(run.id);
 }
 function finishConfirmedLegacyPublications(){
  for(const run of allRuns()){
   if(run.deletedAt||run.stage!=='checking'||activeLeases.has(run.id)||run.leaseToken&&Date.parse(run.leaseUntil)>clock()||store.getProject(run.projectId)?.archived)continue;
   const page=run.pageId&&store.getPage(run.pageId),native=run.nativePublication;
   if(!page?.fullUrl||!page.wpId||page.siteId!==run.siteId||page.remoteSnapshot?.status!=='publish')continue;
   if(run.nativeCleanup&&run.nativeCleanup.phase!=='prepared')continue;
   if(run.publicationMode==='native'?(native?.phase!=='published'||native.postId!==page.wpId||native.url!==page.fullUrl):!run.jobId||store.getJob(run.jobId)?.state!=='completed')continue;
   store.atomic(()=>{
    const check=run.checkJobId&&store.getJob(run.checkJobId);
    if(check?.type==='page_check'&&check.pageId===page.id&&check.siteId===page.siteId&&['queued','running'].includes(check.state))store.pauseJob(check.id);
    update(run.id,{...publicationComplete,nativeCleanup:null,publicationRecovery:null});
   });
  }
 }
 function manualWaitMatches(run,binding){const page=run.pageId&&store.getPage(run.pageId);return !!binding&&binding.pageId===run.pageId&&binding.pageRevision===page?.revision&&binding.destinationRevision===(run.destinationRevision||0)&&binding.publicationAttempt===(run.publicationAttempt||0);}
 function beginManualWait(run){try{
  const owner=publicationTurn.owner();if(owner&&owner.id!==run.id)return run;
  if(manualWaitMatches(run,run.nativeManualWait))return run;
  const page=store.getPage(run.pageId);if(!page)return run;const startedAt=new Date(clock()).toISOString();
  return store.updateRecord(run.id,{nativeManualWait:{startedAt,pageId:run.pageId,pageRevision:page.revision,destinationRevision:run.destinationRevision||0,publicationAttempt:run.publicationAttempt||0},publicationDiagnostics:safePublicationDiagnostics([...(run.publicationDiagnostics||[]),{phase:'manual_wait',startedAt,endedAt:null,elapsedMs:null,manualWaitMs:null,timingScope:'manual_wait_wall',manualWaitScope:'until_validated_resume_wall',code:run.error?.code,checkpoint:run.nativePublication?.phase}])},run.revision);
 }catch{return null;}}
 function finishManualWait(id,binding){try{
  const owner=publicationTurn.owner();if(owner&&owner.id!==id)return;
  const run=get(id);if(!manualWaitMatches(run,binding)||run.nativeManualWait?.startedAt!==binding.startedAt)return;
  const endedAt=new Date(clock()).toISOString(),start=Date.parse(binding.startedAt),end=Date.parse(endedAt),diagnostics=[...(run.publicationDiagnostics||[])],index=diagnostics.findLastIndex(row=>row.phase==='manual_wait'&&row.startedAt===binding.startedAt&&row.endedAt===null);
  if(index>=0)diagnostics[index]={...diagnostics[index],endedAt,manualWaitMs:Number.isFinite(start)&&end>=start?end-start:null,code:'OK'};
  // The wall interval includes time while the app was closed. It proves only
  // that a validated Resume was accepted, never that a challenge was solved.
  store.updateRecord(id,{nativeManualWait:null,publicationDiagnostics:safePublicationDiagnostics(diagnostics)},run.revision);
 }catch{}}
 const safeError=e=>{const code=/^[a-zA-Z_]{1,80}$/.test(e?.code||'')?e.code:'AUTOPILOT_FAILED';const diagnostics=safeAIDiagnostics(e?.diagnostics),issues=safeAIOutputIssues(e?.issues);return {code,...(['preparing','generating','selecting','installing','publishing','checking'].includes(e?.stage)?{stage:e.stage}:{}),...(diagnostics?{diagnostics}:{}),...(issues.length?{issues}:{}),message:aiOutputMessage(issues)||aiDiagnosticMessage(diagnostics)||messages[code]||(/bootstrap/.test(code)?'WordPress не завершив автоматичне налаштування. Код причини: '+code:/source|sheet|google/.test(code)?'Не вдалося прочитати базу сайтів. Перевірте підключення Google-таблиці.':'Не вдалося завершити крок. Готові результати збережено. Код: '+code)};};
 const sourceConfigured=()=>!!sourceConfig&&(sourceConfig.authMode==='browser'?googleBrowser?.status().connected===true&&googleBrowser.status().spreadsheetUrl===sourceConfig.spreadsheetUrl:sourceConfig.authMode==='user'?googleAuth?.status().connected===true:!!sourceConfig.serviceAccount);
 const sourceStatus=()=>({configured:sourceConfigured(),authMode:sourceConfig?.authMode||(sourceConfig?'service':'user'),spreadsheetId:sourceConfig?.spreadsheetId||'',...(sourceConfig?.spreadsheetUrl?{spreadsheetUrl:sourceConfig.spreadsheetUrl,sheetId:sourceConfig.sheetId}:{}),range:sourceConfig?.range||'',columns:sourceConfig?.columns||{url:'B',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O',dr:'D',traffic:'E',geo:'F'},headerRows:sourceConfig?.headerRows??1,accountEmail:sourceConfig?.authMode==='browser'?'':sourceConfig?.authMode==='user'||!sourceConfig?googleAuth?.status().email||'':sourceConfig?.serviceAccount?.clientEmail||''});
 const googleAccessToken=()=>{if(sourceConfig?.authMode==='browser')fail('GOOGLE_BROWSER_IMPORT_UNSUPPORTED');if(sourceConfig&&sourceConfig.authMode!=='user'||!sourceConfig&&!googleAuth?.status().connected)return null;if(!googleAuth)fail('GOOGLE_AUTH_REQUIRED');return googleAuth.accessToken();};
 if(!source){const apiSource=createSiteSource({getAccessToken:googleAccessToken}),browserSource=createSiteSource({readSheet:config=>{if(!googleBrowser)fail('GOOGLE_BROWSER_REQUIRED');return googleBrowser.readSheet(config);}});source={readCandidates:(config,options)=>(config.authMode==='browser'?browserSource:apiSource).readCandidates(config,options),pickUnused:(config,options)=>(config.authMode==='browser'?browserSource:apiSource).pickUnused(config,options)};}
 // Background reads end with the Desktop service; a source-check request can
 // additionally be cancelled by its caller. Neither cancellation replays writes.
 const readSource=(method,config,options={})=>{const signal=sourceSignal&&options.signal?AbortSignal.any([sourceSignal,options.signal]):sourceSignal||options.signal;if(signal?.aborted)fail('source_read_aborted');return source[method](config,{...options,...(signal?{signal}:{})});};
 function launch(projectId,body,queueOptions={}){
  return store.atomic(()=>{
  const input=sourceInput(body),project=store.getProject(projectId);if(!project||project.archived)fail('NOT_FOUND');if(!uuid.test(body.idempotencyKey))fail('VALIDATION');
  if(project.workflowType&&project.workflowType!==input.source)throw Object.assign(Error('Тип цього проєкту вже зафіксований. Створіть окремий проєкт для іншого джерела.'),{code:'PROJECT_TYPE_MISMATCH'});
  // Preserve the original identity for old AI launches; the mode/options are part of all new identities.
  const legacyIdentity=input.source==='ai'&&input.chromeMode==='custom'&&!input.editorial?{projectId,links:input.links}:{projectId,...input};
  const identity={...legacyIdentity,...(body.reviewBeforePublish===true?{reviewBeforePublish:true}:{}),...(queueOptions.slug?{slug:queueOptions.slug}:{}),...(queueOptions.donor?{requestedDonor:queueOptions.donor}:{})};
  const old=store.getRecord(body.idempotencyKey),siteSelection=normalizeSiteCriteria(old?old.siteSelection:queueOptions.siteSelection||project.siteSelection);
  // Replays use the stored snapshot, including legacy records whose hash predates criteria.
  const requestHash=createHash('sha256').update(JSON.stringify(old&&!Object.hasOwn(old,'siteSelection')?identity:{...identity,siteSelection})).digest('hex');
  if(old){if(old.kind!==KIND||old.requestHash!==requestHash)fail('CONFLICT');if(old.deletedAt)fail('NOT_FOUND');return publicRun(old,store);}
  if(!queueOptions.queueItemId&&allRuns().filter(r=>!store.getProject(r.projectId)?.archived&&['queued','running','publishing','checking'].includes(r.state)).length>=20)fail('CAPACITY_EXCEEDED');
  let imported=null;
  if(input.source==='html'){
   imported=customerPreview(input);
   if(typeof body.reviewToken!=='string'||body.reviewToken!==imported.reviewToken)fail('HTML_REVIEW_REQUIRED');
  }
  const editorialVariant=input.editorial?allRuns().reduce((max,run)=>Number.isSafeInteger(run.editorialVariant)?Math.max(max,run.editorialVariant):max,-1)+1:undefined;
  const created=store.createRecord(projectId,KIND,{source:input.source,chromeMode:input.chromeMode,browserMode,...(input.editorial?{editorial:input.editorial,editorialVariant}:{}),...(queueOptions.queueItemId?{queueItemId:queueOptions.queueItemId,language:queueOptions.language||'en',...(queueOptions.slug?{slug:queueOptions.slug}:{}),...(queueOptions.donor?{requestedDonor:queueOptions.donor}:{})}:{}),siteSelection,reviewBeforePublish:body.reviewBeforePublish===true,links:input.links||[],requestHash,state:'queued',stage:imported?'preparing':'generating',requestId:body.idempotencyKey+'-page',pageId:null,jobId:null,error:null,...(imported?{customerConfig:imported.config,title:imported.title,warnings:imported.warnings,reviewToken:imported.reviewToken,approvedHtmlHash:imported.approvedHtmlHash}:{})},body.idempotencyKey);
  if(imported&&!queueOptions.queueItemId)store.createRecord(projectId,'customer_original',{runId:created.id,html:input.html,sourceHash:createHash('sha256').update(input.html,'utf8').digest('hex')},'original-html:'+created.id);
  if(store.getRecord('amp-mode:'+projectId)?.enabled)store.updateRecord(created.id,{ampMode:true},created.revision);
  return publicRun(store.getRecord(created.id),store);
  });
 }
 function setDestination(id,body){
  const destination=manualDestination(body);if(!box)fail('KEY_REQUIRED');
  return store.atomic(()=>{const run=get(id);
   if(!canSetDestination(run,store)||hasActivePage(run.pageId)||body.expectedRevision!==undefined&&body.expectedRevision!==(run.destinationRevision||0))fail('CONFLICT');
   if(manualOriginReserved(id,destination.baseUrl))fail('SOURCE_RESERVED');
   if(!candidatePolicy({id:'manual:'+id,baseUrl:destination.baseUrl,username:destination.username,password:destination.password},run,{mode:'manual'}).candidate)fail('DONOR_POLICY_BLOCKED');
   const page=store.getPage(run.pageId),previousTarget=run.candidate?.baseUrl||run.manualTarget?.baseUrl;
   if(page.siteId)store.updatePage(page.id,{siteId:null,lifecycleState:'draft'},page.revision);
   const destinationHistory=[...(run.destinationHistory||[]),...(previousTarget?[{baseUrl:previousTarget,siteId:run.siteId||null,jobId:run.jobId||null,stage:run.stage,changedAt:new Date(clock()).toISOString()}]:[])];
   return publicRun(update(id,{manualTarget:{baseUrl:destination.baseUrl},manualCredential:box.encrypt(id+':manual',{username:destination.username,applicationPassword:destination.password}),destinationRevision:(run.destinationRevision||0)+1,destinationHistory,publicationAttempt:(run.publicationAttempt||0)+1,donorPinned:false,candidate:null,candidateCredential:null,alternateCredential:null,candidateCredentialIndex:0,candidateCredentialFailures:[],apiCredential:null,bootstrapStage:null,nativeCapacityReserved:false,nativePublication:null,nativeCreationNotStarted:false,nativeSnapshot:null,nativePublishedRevision:null,publicationMode:null,siteId:null,jobId:null,checkJobId:null,browserWindow:false,browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString(),reviewBeforePublish:true,publicationApproval:null,stage:'selecting',state:'awaiting_review',error:null}),store);
  });
 }
 function remove(id){return store.atomic(()=>{
  const run=store.getRecord(id);if(!run||run.kind!==KIND)fail('NOT_FOUND');
  if(run.deletedAt)return {deleted:true,id,pageId:run.pageId||null};
  if(!canDeleteRun(run,store)||run.pageId&&hasActivePage(run.pageId))fail('CONFLICT');
  if(run.pageId){const page=store.getPage(run.pageId);store.updatePage(page.id,{lifecycleState:'discarded'},page.revision);}
  // Keep the identity and payment history, so a lost response or stale tab
  // cannot recreate the same launch or dispatch it again.
  const original=store.getRecord('original-html:'+id);if(original?.kind==='customer_original'&&original.runId===id&&original.projectId===run.projectId)store.updateRecord(original.id,{html:null,deletedAt:new Date(clock()).toISOString()},original.revision);
  store.updateRecord(id,{state:'deleted',deletedAt:new Date(clock()).toISOString(),browserPreparing:false,browserPreparingUntil:null,publicationApproval:null,customerConfig:null,manualCredential:null,candidate:null,candidateCredential:null,alternateCredential:null},run.revision);
  return {deleted:true,id,pageId:run.pageId||null};
 });}
 async function removeWithBrowser(id){
  const previous=store.getRecord(id);if(previous?.deletedAt)return remove(id);
  store.atomic(()=>{const run=get(id);if(run.browserPreparing&&!(Date.parse(run.browserPreparingUntil)<=clock())||!canDeleteRun(run,store)||run.pageId&&hasActivePage(run.pageId))fail('CONFLICT');update(id,{state:run.state==='awaiting_review'?'awaiting_review':'paused',browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString()});});
  try{await visibleBrowser?.reset?.(id);return remove(id);}finally{const run=store.getRecord(id);if(run&&!run.deletedAt)update(id,{browserPreparing:false,browserPreparingUntil:null});}
 }
 function approve(id,body){
  fields(body,['reviewToken']);
  if(typeof body.reviewToken!=='string'||!body.reviewToken)fail('REVIEW_REQUIRED');
  return store.atomic(()=>{
   const run=get(id);if(!run.reviewBeforePublish||!run.pageId||store.getProject(run.projectId)?.archived)fail('CONFLICT');
   if(run.slug&&visibleBrowser?.nativeEditor!==true)fail('NATIVE_SLUG_MISMATCH');
   if(run.requestedDonor&&!run.candidate&&!run.manualTarget)fail('IMPORT_DONOR_UNAVAILABLE');
   const snapshot=preparedSnapshot(run,store);
   if(run.publicationApproval?.reviewToken===body.reviewToken){verifyPublicationApproval(run,store,snapshot);return publicRun(run,store);}
   if(run.browserPreparing&&!(Date.parse(run.browserPreparingUntil)<=clock()))fail('CONFLICT');
   if(body.reviewToken!==snapshot.reviewToken)fail('REVIEW_REQUIRED');
   if(run.state!=='awaiting_review'||run.jobId||run.nativePublication&&run.nativePublication.phase!=='draft'||(run.leaseToken&&Date.parse(run.leaseUntil)>clock()))fail('CONFLICT');
   verifyCustomerOutput(run,snapshot.rendered,snapshot.page);
   return publicRun(update(id,{publicationApproval:{reviewToken:snapshot.reviewToken,pageId:snapshot.page.id,pageRevision:snapshot.page.revision,materialHash:snapshot.materialHash,approvedAt:new Date(clock()).toISOString()},...(run.nativePublication?.phase==='draft'?{nativeSnapshot:null}:{}),state:'queued',error:null}),store);
  });
 }
 async function saveSource(body){
  fields(body,['spreadsheetId','spreadsheetUrl','sheetId','range','serviceAccount','columns','headerRows','authMode']);if(!box)fail('KEY_REQUIRED');let next;
  try{next=validateSiteSourceConfig({...body,authMode:body.authMode??sourceConfig?.authMode??'service',serviceAccount:body.serviceAccount||sourceConfig?.serviceAccount},{allowMissingAccount:true});}catch{fail('VALIDATION');}
  const encoded=JSON.stringify(next);if(encoded.length>32768)fail('VALIDATION');await mkdir(dataDir,{recursive:true});const temporary=sourceFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(box.encrypt(SOURCE_ID,{username:'sheets',applicationPassword:encoded})),{mode:0o600,flag:'wx'});await rename(temporary,sourceFile);sourceConfig=next;
  if(sourceConfigured())for(const r of allRuns())if(r.state==='waiting_source'&&!store.getProject(r.projectId)?.archived)update(r.id,{state:'queued',error:null});return sourceStatus();
 }
 function donorOrigins(entry,base){return [new URL(base).origin,...(entry.canonicalLogin?.baseUrl===base?[new URL(entry.canonicalLogin.requestedBaseUrl).origin]:[])];}
 const policyMaterials=new WeakMap();
 function policySource(descriptor){
  const cached=selectionCache?.config===sourceConfig&&selectionCache.account===(googleAuth?.status().email||'')?selectionCache.sourceIdentity:null;
  let identity=descriptor||cached;try{identity=identity||sourceConfig&&siteSourcePolicyIdentity(sourceConfig);}catch{return null;}
  if(!identity)return null;const mode=sourceConfig?.authMode||'service',readerPrincipal=mode==='user'?googleAuth?.status().email:mode==='browser'?googleBrowser?.status().email||googleBrowser?.status().accountEmail:sourceConfig?.serviceAccount?.clientEmail;
  return readerPrincipal?{...identity,authMode:mode,readerPrincipal}:null;
 }
 function policyMaterial(run,engine){
  if(!engine?.hasMaterialRestrictions||!run?.pageId)return null;const page=store.getPage(run.pageId);if(!page)return null;
  let cache=policyMaterials.get(engine);if(!cache){cache=new Map();policyMaterials.set(engine,cache);}const key=page.id+':'+page.revision;
  if(!cache.has(key))cache.set(key,renderedHash({...preparedRender(store,page.config),title:page.title}));return cache.get(key);
 }
 function candidatePolicy(candidate,run,{mode=run?.manualTarget||run?.donorPinned?'manual':'automatic',engine=donorExclusions?.snapshot(),sourceIdentity}={}){
  if(!engine?.hasRestrictions)return {candidate,decision:null};
  const accounts=[{username:candidate.username,password:candidate.password},...(candidate.alternateCredentials?[candidate.alternateCredentials]:[])];
  const decision=engine.evaluate({runId:run?.id,origin:candidate.baseUrl,origins:run?.canonicalLogin?donorOrigins(run,candidate.baseUrl):[],sourceIdentity:sourceIdentity===undefined?run?.candidateSourceIdentity||policySource():sourceIdentity,credentials:accounts,materialHash:policyMaterial(run,engine),mode});
  if(decision.blocked)return {candidate:null,decision};const [first,second]=decision.allowedCredentials;
  if(!first)return {candidate:null,decision};const {alternateCredentials,...base}=candidate;
  return {candidate:{...base,username:first.username,password:first.password??first.applicationPassword,...(second?{alternateCredentials:{username:second.username,password:second.password??second.applicationPassword}}:{})},decision};
 }
 function selectedPolicyGuard(run){
  if(!donorExclusions||!run?.candidate)return;
  const alternate=run.candidateCredentialIndex===1,encrypted=alternate?run.alternateCredential:run.candidateCredential,credentials=encrypted?box.decrypt(run.id+(alternate?':alternate':''),encrypted):null;if(!credentials)return;
  const {decision,candidate}=candidatePolicy({...run.candidate,username:credentials.username,password:credentials.applicationPassword},run);
  if(!candidate){const type=decision?.reasons?.[0]?.type;fail(type==='manual'?'DONOR_MANUALLY_BLOCKED':'DONOR_POLICY_BLOCKED');}
 }
 const liveReservationRun=run=>!run.deletedAt&&run.state!=='deleted';
 function manualOriginReserved(id,base){
  const root=donorDomainKey(base);
  return allRuns().some(other=>{
   const target=other.candidate?.baseUrl||other.manualTarget?.baseUrl;
   return other.id!==id&&liveReservationRun(other)&&target&&other.state!=='completed'&&donorOrigins(other,target).some(origin=>donorDomainKey(origin)===root);
  });
 }
 function sourceOptions(criteria,excludeId,{includeRejected=true}={}){
  const projects=store.listProjects(),archived=new Set(projects.filter(p=>p.archived).map(p=>p.id)),all=allRuns().filter(liveReservationRun);
  const runs=all.filter(r=>r.id!==excludeId&&(r.candidate||r.manualTarget?.baseUrl&&r.state!=='completed')&&!(archived.has(r.projectId)&&unusedDonorReservation(r,store,clock())));
  const engine=includeRejected?donorExclusions?.snapshot():null,rejected=includeRejected?all.flatMap(r=>(r.donorSkips||[]).filter(skip=>{if(r.id===excludeId)return true;if(skip.policyId)return false;try{return !engine||engine.evaluate({runId:excludeId,origin:skip.baseUrl,origins:donorOrigins(skip,skip.baseUrl),sourceIdentity:policySource(),mode:'automatic'}).blocked;}catch{return true;}})):[],publishedIds=new Set(typeof store.listPublishedSiteIds==='function'?store.listPublishedSiteIds():projects.flatMap(p=>store.listPages(p.id)).filter(page=>page.wpId).map(page=>page.siteId)),publishedSites=store.listAllSites().filter(s=>publishedIds.has(s.id));
  const unavailability={reservedOrigins:runs.flatMap(r=>donorOrigins(r,r.candidate?.baseUrl||r.manualTarget.baseUrl)),reservedRowIds:runs.flatMap(r=>r.candidate?[r.candidate.id]:[]),publishedOrigins:publishedSites.map(s=>new URL(s.baseUrl).origin),excludedOrigins:rejected.flatMap(s=>donorOrigins(s,s.baseUrl)),excludedRowIds:rejected.map(s=>s.id)};
  return {criteria:normalizeSiteCriteria(criteria),usedOrigins:[...new Set([...unavailability.reservedOrigins,...unavailability.publishedOrigins,...unavailability.excludedOrigins])],usedRowIds:[...unavailability.reservedRowIds,...unavailability.excludedRowIds],unavailability};
 }
 let selectionTask=null,selectionCache=null,selectionEpoch=0,catalogReadTask=null;const donorChoices=new Map();
 const invalidateSelection=()=>{selectionEpoch++;selectionCache=null;donorChoices.clear();};
 const awaitingSelection=run=>run&&!run.deletedAt&&run.queueItemId&&run.reviewBeforePublish&&!run.publicationApproval&&run.state==='awaiting_review'&&run.stage==='selecting'&&run.pageId&&!run.candidate&&!run.jobId&&(!run.leaseToken||Date.parse(run.leaseUntil)<=clock())&&!store.getProject(run.projectId)?.archived&&!store.getRecord('queue-control:'+run.projectId)?.paused;
 function matchesRequestedDonor(candidate,run){
  return !run?.requestedDonor||validatePublicUrl(candidate.baseUrl).href.replace(/\/+$/,'')===run.requestedDonor.replace(/\/+$/,'');
 }
 function matchesSelection(candidate,criteria){const metrics=candidate.metrics||{},geo=criteria.geo?criteria.geo.split(','):[];return (criteria.minDr===null||Number.isFinite(metrics.dr)&&metrics.dr>=criteria.minDr)&&(criteria.minTraffic===null||Number.isFinite(metrics.traffic)&&metrics.traffic>=criteria.minTraffic)&&(!geo.length||geo.some(code=>metrics.geo?.includes(code)));}
 const donorConnection=()=>({config:sourceConfig,account:googleAuth?.status().email||'',epoch:selectionEpoch});
 const sameDonorConnection=value=>!sourceSignal?.aborted&&sourceConfigured()&&value.config===sourceConfig&&value.account===(googleAuth?.status().email||'')&&value.epoch===selectionEpoch&&!(sourceConfig?.authMode==='user'&&googleAuth?.status().phase==='waiting');
 const candidateSourceIdentities=new WeakMap();
 async function policyPick(run,config,options){
  const connection=donorConnection(),ids=new Set(options.usedRowIds),origins=new Set(options.usedOrigins);
  const cached=selectionCache;
  if(run.donorSkips?.length&&cached?.config===config&&cached.account===connection.account&&cached.expires>clock()&&sameDonorConnection(connection)){
   const identity=policySource(cached.sourceIdentity),engine=donorExclusions?.snapshot();
   for(const candidate of cached.candidates){
    if(!matchesRequestedDonor(candidate,run)||ids.has(candidate.id)||[...origins].some(value=>donorDomainKey(value)===donorDomainKey(candidate.baseUrl))||!matchesSelection(candidate,options.criteria))continue;
    const permitted=candidatePolicy(candidate,run,{engine,sourceIdentity:identity}).candidate;
    if(permitted){candidateSourceIdentities.set(permitted,identity);return permitted;}
   }
  }
  // Compatibility with single-row sources; reject noncooperative repetition
  // without pretending that a bounded scan proves the source is empty.
  for(let scanned=0;scanned<10000;scanned++){
   let descriptor;const candidate=await readSource('pickUnused',config,{...options,usedRowIds:[...ids],usedOrigins:[...origins],onSourceIdentity:value=>{descriptor=value;}});
   if(!sameDonorConnection(connection))fail('CONFLICT');if(!candidate)return null;
   const origin=validatePublicUrl(candidate.baseUrl).origin;if(options.usedRowIds.includes(candidate.id)||options.usedOrigins.some(value=>donorDomainKey(value)===donorDomainKey(origin)))fail('SOURCE_RESERVED');if(ids.has(candidate.id)||origins.has(origin))fail('SOURCE_POLICY_SCAN_LIMIT');
   const identity=policySource(descriptor),permitted=matchesRequestedDonor(candidate,run)&&matchesSelection(candidate,options.criteria)?candidatePolicy(candidate,run,{sourceIdentity:identity}).candidate:null;
   if(permitted){candidateSourceIdentities.set(permitted,identity);return permitted;}ids.add(candidate.id);
  }
  fail('SOURCE_POLICY_SCAN_LIMIT');
 }
 async function donorPool(){
  if(!sourceConfigured())fail('SOURCE_NOT_CONFIGURED');
  if(sourceConfig.authMode==='user'&&googleAuth?.status().phase==='waiting')fail('GOOGLE_AUTH_REQUIRED');
  const connection=donorConnection();
  if(selectionCache?.config===connection.config&&selectionCache.account===connection.account&&selectionCache.expires>clock())return {connection,candidates:selectionCache.candidates};
  if(catalogReadTask?.connection.config===connection.config&&catalogReadTask.connection.account===connection.account&&catalogReadTask.connection.epoch===connection.epoch)return catalogReadTask.promise;
  const task={connection,promise:null};task.promise=(async()=>{
   const result=await readSource('readCandidates',connection.config,{criteria:normalizeSiteCriteria(),usedOrigins:[],usedRowIds:[],preserveOrigins:true});
   if(!sameDonorConnection(connection))fail('CONFLICT');if(!Array.isArray(result.candidates))fail('source_response_invalid');
   selectionCache={config:connection.config,account:connection.account,expires:clock()+60000,candidates:result.candidates,inputDiagnostics:result.inputDiagnostics||result.diagnostics?.input,sourceIdentity:result.sourceIdentity};return {connection,candidates:result.candidates};
  })();catalogReadTask=task;
  try{return await task.promise;}finally{if(catalogReadTask===task)catalogReadTask=null;}
 }
 function destinationStatus(id){const run=store.getRecord(id);if(!run||run.kind!==KIND||run.deletedAt)return {canSetDestination:false,destinationBlockedReason:'Сторінка недоступна для зміни донора.',destinationRevision:run?.destinationRevision||0,donorPinned:false};const reason=destinationBlockedReason(run,store)||(hasActivePage(run.pageId)?'Дочекайтеся завершення поточної дії зі сторінкою.':'');return {canSetDestination:!reason,destinationBlockedReason:reason,destinationRevision:run.destinationRevision||0,donorPinned:run.donorPinned===true};}
 const cleanDonorMetrics=candidate=>{const metrics=candidate.metrics||{};return {dr:Number.isFinite(metrics.dr)&&metrics.dr>=0&&metrics.dr<=100?metrics.dr:null,traffic:Number.isSafeInteger(metrics.traffic)&&metrics.traffic>=0?metrics.traffic:null,geo:Array.isArray(metrics.geo)?metrics.geo.filter(code=>typeof code==='string'&&/^[A-Z]{2}$/.test(code)).slice(0,250):[]};};
 function catalogueReservations(criteria,id){
  const used=sourceOptions(criteria,id,{includeRejected:false});
  return {roots:new Set(used.usedOrigins.map(donorDomainKey)),ids:new Set(used.usedRowIds)};
 }
 function donorReservation(run,candidate){const used=catalogueReservations(run.siteSelection,run.id);return used.ids.has(candidate.id)||used.roots.has(donorDomainKey(candidate.baseUrl));}
 async function listDonors(id,request){
  const run=get(id);
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>!['search','offset','limit','all'].includes(key)))fail('VALIDATION');
  const search=(params.get('search')||'').trim().toLowerCase(),offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||30),showAll=params.get('all')==='1';
  if(search.length>200||/[\u0000-\u001f]/.test(search)||!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100||params.has('all')&&!['0','1'].includes(params.get('all')))fail('VALIDATION');
  const blocked=value=>{const status=destinationStatus(value.id);return status.canSetDestination?null:{run:{...publicRun(value,store),...status},token:null,destinationRevision:value.destinationRevision||0,criteria:normalizeSiteCriteria(value.siteSelection),total:0,offset,limit,candidates:[]};};
  const stopped=blocked(run);if(stopped)return stopped;
  const revision=run.destinationRevision||0,pageRevision=store.getPage(run.pageId)?.revision,criteria=normalizeSiteCriteria(run.siteSelection),{connection,candidates}=await donorPool();
  const current=get(id),newlyStopped=blocked(current);if(newlyStopped)return newlyStopped;if(!sameDonorConnection(connection)||(current.destinationRevision||0)!==revision||store.getPage(current.pageId)?.revision!==pageRevision||JSON.stringify(normalizeSiteCriteria(current.siteSelection))!==JSON.stringify(criteria))fail('CONFLICT');
  const reserved=catalogueReservations(criteria,id),rejected=new Set(allRuns().flatMap(r=>(r.donorSkips||[]).flatMap(skip=>donorOrigins(skip,skip.baseUrl)))),engine=donorExclusions?.snapshot();
  const seen=new Set(),seenIds=new Set(),pool=[];
  for(const candidate of candidates){
   let url;try{url=validatePublicUrl(candidate.baseUrl);}catch{continue;}
   if(typeof candidate.id!=='string'||candidate.id.length>500||typeof candidate.username!=='string'||typeof candidate.password!=='string'||!candidate.username||!candidate.password||!showAll&&!matchesSelection(candidate,criteria)||search&&!url.href.toLowerCase().includes(search)||seen.has(url.origin)||seenIds.has(candidate.id))continue;
   seen.add(url.origin);seenIds.add(candidate.id);pool.push(candidate);
  }
  const describe=candidate=>{
   const {candidate:permitted,decision}=candidatePolicy(candidate,current,{mode:'manual',engine}),policyReason=decision?.reasons?.[0],origin=new URL(candidate.baseUrl).origin,available=!!permitted&&!reserved.roots.has(donorDomainKey(candidate.baseUrl))&&!reserved.ids.has(candidate.id),matchesCriteria=matchesSelection(candidate,criteria),warnings=[];
   if(!matchesCriteria)warnings.push('Поза вимогами GEO, DR або трафіку цієї сторінки. Сайт можна обрати вручну.');if(rejected.has(origin))warnings.push('Попередня спроба на цьому донорі не завершилася; його можна обрати вручну.');
   return {id:candidate.id,baseUrl:candidate.baseUrl,...cleanDonorMetrics(candidate),available,reason:available?'':!permitted?policyReason?.reason||messages.DONOR_POLICY_BLOCKED:'Донор уже використовується або закріплений за іншою сторінкою.',...(policyReason?{exclusion:{type:policyReason.type,reason:policyReason.reason,expiresAt:policyReason.expiresAt,canRelease:!!policyReason.id&&!policyReason.currentRun}}:{}),current:candidate.id===current.candidate?.id&&candidate.baseUrl===current.candidate?.baseUrl,matchesCriteria,warning:warnings.join(' ')};
  };
  const token=randomUUID(),byId=new Map(pool.map(candidate=>[candidate.id,candidate]));
  const visible=showAll?
   rankDonorRecommendations(pool.map(candidate=>({...describe(candidate),rowNumber:candidate.rowNumber})),criteria,current.candidate?.baseUrl||current.manualTarget?.baseUrl)
    .slice(offset,offset+limit).map(({rowNumber,...row})=>row):
   pool.slice(offset,offset+limit).map(describe);
  const choices=new Map(visible.map(({id})=>[id,byId.get(id)]));
  for(const [key,value]of donorChoices)if(value.expires<=clock())donorChoices.delete(key);while(donorChoices.size>=64)donorChoices.delete(donorChoices.keys().next().value);
  donorChoices.set(token,{id,revision,pageRevision,criteria:JSON.stringify(criteria),showAll,connection,choices,expires:clock()+300000});
  return {run:publicRun(current,store),token,destinationRevision:revision,criteria,total:pool.length,offset,limit,candidates:visible};
 }
 async function chooseDonor(id,body){
  fields(body,['token','candidateId','expectedRevision']);if(!box)fail('KEY_REQUIRED');
  if(!uuid.test(body.token||'')||typeof body.candidateId!=='string'||!body.candidateId||body.candidateId.length>500||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail('VALIDATION');
  const choice=donorChoices.get(body.token);let candidate=choice?.choices.get(body.candidateId);
  if(!choice||choice.id!==id||choice.expires<=clock()||!sameDonorConnection(choice.connection)||!candidate)fail('DONOR_SELECTION_EXPIRED');
  let revision;
  store.atomic(()=>{
   const run=get(id),page=store.getPage(run.pageId);
   if(!canSetDestination(run,store)||hasActivePage(run.pageId)||(run.destinationRevision||0)!==body.expectedRevision||body.expectedRevision!==choice.revision||page?.revision!==choice.pageRevision||JSON.stringify(normalizeSiteCriteria(run.siteSelection))!==choice.criteria||!sameDonorConnection(choice.connection)||choice.expires<=clock())fail('CONFLICT');
   if(!choice.showAll&&!matchesSelection(candidate,normalizeSiteCriteria(run.siteSelection)))fail('CONFLICT');if(donorReservation(run,candidate))fail('SOURCE_RESERVED');
   candidate=candidatePolicy(candidate,run,{mode:'manual'}).candidate;if(!candidate)fail('DONOR_POLICY_BLOCKED');
   const baseUrl=validatePublicUrl(candidate.baseUrl).href,previousTarget=run.candidate?.baseUrl||run.manualTarget?.baseUrl;
   if(page.siteId)store.updatePage(page.id,{siteId:null,lifecycleState:'draft'},page.revision);
   const destinationHistory=[...(run.destinationHistory||[]),...(previousTarget?[{baseUrl:previousTarget,siteId:run.siteId||null,jobId:run.jobId||null,stage:run.stage,...(run.nativePublication?{nativePublication:run.nativePublication,nativeSnapshot:run.nativeSnapshot||null,nativePublishedRevision:run.nativePublishedRevision??null}:{}),changedAt:new Date(clock()).toISOString()}]:[])];revision=(run.destinationRevision||0)+1;
   update(id,{candidate:{id:candidate.id,baseUrl,rowNumber:candidate.rowNumber??null,metrics:cleanDonorMetrics(candidate)},candidateSourceIdentity:policySource(),candidateCredential:box.encrypt(id,{username:candidate.username,applicationPassword:candidate.password}),alternateCredential:candidate.alternateCredentials?box.encrypt(id+':alternate',{username:candidate.alternateCredentials.username,applicationPassword:candidate.alternateCredentials.password}):null,manualTarget:null,manualCredential:null,donorPinned:true,destinationRevision:revision,destinationHistory,publicationAttempt:(run.publicationAttempt||0)+1,candidateCredentialIndex:0,candidateCredentialFailures:[],canonicalLogin:null,apiCredential:null,bootstrapStage:null,nativeCapacityReserved:false,nativePublication:null,nativeCreationNotStarted:false,nativeSnapshot:null,nativePublishedRevision:null,publicationMode:null,siteId:null,jobId:null,checkJobId:null,browserWindow:false,browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString(),reviewBeforePublish:true,publicationApproval:null,stage:'installing',state:'awaiting_review',selectionDiagnostics:null,error:null});
   donorChoices.delete(body.token);
  });
  try{await visibleBrowser?.reset?.(id);}finally{const current=store.getRecord(id);if(current&&!current.deletedAt&&current.destinationRevision===revision)update(id,{browserPreparing:false,browserPreparingUntil:null});}
  return publicRun(get(id),store);
 }
 function reserveForReview(original,candidate,selectionDiagnostics){
  return store.atomic(()=>{const run=store.getRecord(original.id);if(!selectionUnchanged(run,original)||hasActivePage(run.pageId))return;
   if(candidate)candidate=matchesRequestedDonor(candidate,run)?candidatePolicy(candidate,run,{sourceIdentity:policySource()}).candidate:null;
   if(!candidate){update(run.id,{state:'needs_attention',error:safeError({code:run.requestedDonor?'IMPORT_DONOR_UNAVAILABLE':'SOURCE_EMPTY'}),selectionDiagnostics:selectionDiagnostics||null});return;}
   const baseUrl=validatePublicUrl(candidate.baseUrl).href,used=sourceOptions(run.siteSelection,run.id);if(used.usedOrigins.some(value=>donorDomainKey(value)===donorDomainKey(baseUrl))||used.usedRowIds.includes(candidate.id)){update(run.id,{state:'needs_attention',error:safeError({code:'SOURCE_RESERVED'})});return;}
   const raw=candidate.metrics||{},metrics={dr:Number.isFinite(raw.dr)?raw.dr:null,traffic:Number.isSafeInteger(raw.traffic)?raw.traffic:null,geo:Array.isArray(raw.geo)?raw.geo.filter(code=>typeof code==='string'&&/^[A-Z]{2}$/.test(code)):[]};
   update(run.id,{candidate:{id:candidate.id,baseUrl,rowNumber:candidate.rowNumber??null,metrics},candidateSourceIdentity:policySource(),candidateCredential:box.encrypt(run.id,{username:candidate.username,applicationPassword:candidate.password}),manualCredential:null,alternateCredential:candidate.alternateCredentials?box.encrypt(run.id+':alternate',{username:candidate.alternateCredentials.username,applicationPassword:candidate.alternateCredentials.password}):null,donorPinned:!!run.requestedDonor,candidateCredentialIndex:0,candidateCredentialFailures:[],leaseToken:null,leaseOwner:null,leaseUntil:null,state:'awaiting_review',stage:'installing',error:null,selectionDiagnostics:null});
  });
 }
 function selectionUnchanged(run,original){return awaitingSelection(run)&&run.pageId===original.pageId&&(run.destinationRevision||0)===(original.destinationRevision||0)&&store.getPage(run.pageId)?.revision===original.selectionPageRevision&&JSON.stringify(normalizeSiteCriteria(run.siteSelection))===original.selectionCriteria;}
 function policyDiagnostics(candidates,run,{criteria=run?.siteSelection,inputDiagnostics,engine=donorExclusions?.snapshot(),sourceIdentity=policySource(),contexts=[run]}={}){
  return describeSiteSelection(candidates,{...sourceOptions(criteria,run?.id,{includeRejected:false}),inputDiagnostics,...(engine?.hasRestrictions?{candidatePolicy:candidate=>{const decisions=contexts.map(context=>candidatePolicy(candidate,context,{engine,sourceIdentity}).decision);return decisions.some(decision=>!decision?.blocked)?null:decisions[0];}}:{})});
 }
 function selectPending(){
  if(selectionTask)return selectionTask;
  const task=(async()=>{
   const pending=allRuns().filter(awaitingSelection).map(run=>({...run,selectionPageRevision:store.getPage(run.pageId)?.revision,selectionCriteria:JSON.stringify(normalizeSiteCriteria(run.siteSelection))}));if(!pending.length)return;
   // This span includes the shared catalog read and preceding batch selections;
   // no transport/queue duration is inferred from that wall of work.
   const timings=new Map(visibleBrowser?.nativeEditor===true?pending.map(run=>[run.id,createNativeTelemetry({clock})]):[]);
   const recordSelection=(original,code)=>{try{const timing=timings.get(original.id);if(!timing)return;store.atomic(()=>{const current=get(original.id);if(current.deletedAt||current.pageId!==original.pageId||(current.destinationRevision||0)!==(original.destinationRevision||0)||hasActivePage(current.pageId)||store.getProject(current.projectId)?.archived)return;update(current.id,{publicationDiagnostics:safePublicationDiagnostics([...(current.publicationDiagnostics||[]),{...timing.finish(),phase:'selection',budgetMs:180000,code}])});});}catch{}};
   const config=sourceConfig,account=googleAuth?.status().email||'',epoch=selectionEpoch,canRead=sourceConfigured()&&!(config?.authMode==='user'&&googleAuth?.status().phase==='waiting');let candidates;
   const sameConnection=()=>!sourceSignal?.aborted&&selectionEpoch===epoch&&sourceConfig===config&&sourceConfigured()&&(googleAuth?.status().email||'')===account&&!(config?.authMode==='user'&&googleAuth?.status().phase==='waiting');
   try{
    if(pending.some(run=>!run.manualTarget)&&canRead&&source.readCandidates){
     if(!selectionCache||selectionCache.config!==config||selectionCache.account!==account||selectionCache.expires<=clock()){
      const result=await readSource('readCandidates',config,{criteria:normalizeSiteCriteria(),usedOrigins:[],usedRowIds:[],preserveOrigins:true});if(!Array.isArray(result.candidates))fail('source_response_invalid');
      if(!sameConnection())return;
      selectionCache={config,account,expires:clock()+60000,candidates:result.candidates,inputDiagnostics:result.inputDiagnostics||result.diagnostics?.input,sourceIdentity:result.sourceIdentity};
     }candidates=selectionCache.candidates;
    }
    // Plan the whole current batch before reserving it: a flexible row must not
    // consume the sole suitable origin of another row. Manual choices stay fixed.
    // These are proposals only; each admission below rechecks live ownership.
    const policySnapshot=donorExclusions?.snapshot(),policyRuns=new Map(pending.map(run=>[run.id,run]));
    const allocation=candidates?new Map(allocateDonors(pending.filter(original=>{
     const run=store.getRecord(original.id);return !run?.manualTarget&&selectionUnchanged(run,original)&&!hasActivePage(run.pageId);
    }).map(original=>{const run=store.getRecord(original.id),options=sourceOptions(run.siteSelection,run.id);return {id:run.id,...options};}),candidates,{candidateFor:(request,candidate)=>matchesRequestedDonor(candidate,policyRuns.get(request.id))?candidatePolicy(candidate,policyRuns.get(request.id),{engine:policySnapshot,sourceIdentity:policySource()}).candidate:null}).assignments.map(value=>[value.id,value.candidate])):null;
    const missing=[];
    for(const original of pending){
     const run=store.getRecord(original.id);if(!selectionUnchanged(run,original))continue;
     let candidate,diagnostics;
     if(run.manualTarget){const login=box.decrypt(run.id+':manual',run.manualCredential);candidate={id:'manual:'+run.id,baseUrl:run.manualTarget.baseUrl,username:login.username,password:login.applicationPassword};}
     else{if(!canRead||!sameConnection())continue;const options=sourceOptions(run.siteSelection,run.id);
      const usedIds=new Set(options.usedRowIds),usedOrigins=new Set(options.usedOrigins);
      candidate=allocation?allocation.get(run.id):await policyPick(run,config,options);
      if(candidate&&(usedIds.has(candidate.id)||[...usedOrigins].some(value=>donorDomainKey(value)===donorDomainKey(candidate.baseUrl))||!matchesSelection(candidate,options.criteria)))candidate=null;
      if(!sameConnection())return;
      if(!candidate&&candidates){missing.push(original);continue;}
     }reserveForReview(original,candidate,diagnostics);recordSelection(original,candidate?'OK':'UNKNOWN');
    }
    // Explain shortages using admitted reservations, after all winners have
    // been processed. A proposal rejected by a live guard is never counted.
    for(const original of missing){
     const run=store.getRecord(original.id);if(!sameConnection()||!selectionUnchanged(run,original)||hasActivePage(run.pageId))continue;
     reserveForReview(original,null,policyDiagnostics(candidates,run,{inputDiagnostics:selectionCache?.inputDiagnostics}));recordSelection(original,'UNKNOWN');
    }
   }catch(error){selectionCache=null;for(const original of pending){const run=store.getRecord(original.id);if(sameConnection()&&selectionUnchanged(run,original)){update(run.id,{state:'needs_attention',error:safeError(error)});recordSelection(original,error.code);}}}
  })();selectionTask=task;task.finally(()=>{if(selectionTask===task)selectionTask=null;}).catch(()=>{});return task;
 }
 function reviewToken(id){const run=get(id);return preparedSnapshot(run,store).reviewToken;}
 function retrySelection(id){const run=get(id);if(!run.queueItemId||!run.reviewBeforePublish||run.publicationApproval||run.stage!=='selecting'||run.candidate||!run.pageId||!['failed','needs_attention','waiting_source','paused'].includes(run.state))return null;if(store.getProject(run.projectId)?.archived||run.leaseToken&&Date.parse(run.leaseUntil)>clock())fail('CONFLICT');selectionCache=null;return publicRun(update(id,{state:'awaiting_review',error:null}),store);}
 async function checkSource(body,{signal}={}){
  fields(body,['projectId']);if(!sourceConfigured())fail('SOURCE_NOT_CONFIGURED');let criteria=normalizeSiteCriteria();
  if(body.projectId!==undefined){if(typeof body.projectId!=='string')fail('VALIDATION');const project=store.getProject(body.projectId);if(!project||project.archived)fail('NOT_FOUND');criteria=project.siteSelection;}
  const options=sourceOptions(criteria),result=await readSource('readCandidates',sourceConfig,{...options,signal,includeSelectionPool:true}),pool=result.selectionPool||result.candidates,groups=new Map();
  if(body.projectId){
   const imported=store.listRecords(body.projectId,'project_queue_item'),bound=new Set(imported.map(i=>i.runId)),rows=[...imported.filter(i=>!store.getRecord(i.runId)?.deletedAt).map(i=>({criteria:i.input.siteSelection,run:store.getRecord(i.runId)})),...store.listRecords(body.projectId,KIND).filter(r=>!r.deletedAt&&!bound.has(r.id)).map(run=>({criteria:run.siteSelection,run}))];
   for(const row of rows){const normalized=normalizeSiteCriteria(row.criteria),key=JSON.stringify(normalized);if(!groups.has(key))groups.set(key,{criteria:normalized,pages:0,selected:0,contexts:[]});const group=groups.get(key);group.pages++;group.contexts.push(row.run);if(row.run?.candidate)group.selected++;}
  }
  const inputDiagnostics=result.inputDiagnostics||result.diagnostics?.input;
  const engine=donorExclusions?.snapshot(),identity=policySource(result.sourceIdentity),contexts=[...groups.values()].flatMap(group=>group.contexts),diagnostics=policyDiagnostics(pool,undefined,{criteria,inputDiagnostics,engine,sourceIdentity:identity,contexts:contexts.length?contexts:[undefined]}),allowed=result.candidates.filter(candidate=>(contexts.length?contexts:[undefined]).some(run=>candidatePolicy(candidate,run,{engine,sourceIdentity:identity}).candidate));
  return {candidateCount:allowed.length,issueCount:result.issueCount??result.issues.length,diagnostics,groups:[...groups.values()].map(({contexts,...group})=>({...group,...policyDiagnostics(pool,undefined,{criteria:group.criteria,inputDiagnostics,engine,sourceIdentity:identity,contexts})})),sample:allowed.slice(0,5).map(c=>({domain:new URL(c.baseUrl).hostname,dr:c.metrics?.dr??null,traffic:c.metrics?.traffic??null,geo:c.metrics?.geo||[]}))};
 }
 async function resume(id){let replacementRequestId;let r=get(id);if(store.getProject(r.projectId)?.archived)fail('CONFLICT');if(r.leaseToken&&Date.parse(r.leaseUntil)>clock()||r.browserPreparing&&!(Date.parse(r.browserPreparingUntil)<=clock()))fail('CONFLICT');if(r.reviewBeforePublish&&r.pageId){try{verifyPublicationApproval(r,store);}catch(error){if(error.code==='REVIEW_REQUIRED'&&!r.jobId)update(id,{state:r.nativePublication&&r.nativePublication.phase!=='draft'?'uncertain':'awaiting_review',error:safeError(error)});throw error;}}if(!['failed','needs_attention','waiting_source','uncertain','paused'].includes(r.state))fail('CONFLICT');if(r.stage==='generating'){const receipt=ai.budget?.getRequest?.(r.requestId);if(receipt?.state==='completed'){}else if(receipt?.state==='rejected'&&receipt.retryable){if(receipt.model&&receipt.model!==(ai.env?.OPENAI_MODEL||'gpt-5.4-mini'))replacementRequestId=randomUUID()+'-page';else ai.budget.authorizeRetry(r.requestId);}else if(r.state==='uncertain'||receipt&&receipt.state!=='completed')fail('AI_RESULT_UNCERTAIN');}
 if(visibleBrowser?.nativeEditor===true){if(replacementRequestId)update(id,{requestId:replacementRequestId});return resumeNative(get(id));}
 if(r.stage==='installing'&&r.state==='uncertain'&&!r.apiCredential)fail(r.error?.code||'CONFLICT');if(r.siteId){const site=store.getSite(r.siteId),credentials=store.getSiteCredentials(r.siteId);const checked=await client.checkSite({baseUrl:site.baseUrl,...credentials});if(checked.state!=='ok'||!checked.apiRoot)fail('SITE_NOT_READY');const integrity=await bridge.checkStatus({site:{baseUrl:site.baseUrl,...credentials},apiRoot:checked.apiRoot});if(!integrity.ready||!integrity.integrityVerified)fail('SITE_NOT_READY');if(!site.enabled)store.updateSite(site.id,{enabled:true},site.revision);}
 if(r.jobId){let job=store.getJob(r.jobId);if(job?.state==='failed')job=store.reconsiderFailedWrite(job.id,job.revision);if(job?.state==='uncertain'){if(!workflow)fail('CONFLICT');await workflow.handle(new Request('http://localhost/api/lifecycle/jobs/'+job.id+'/retry',{method:'POST'}),'/jobs/'+job.id+'/retry',async()=>({}));job=store.getJob(job.id);if(!['queued','completed'].includes(job.state))fail('CONFLICT');}if(job?.state==='paused')store.resumeJob(job.id);}
 if(visibleBrowser&&r.browserWindow)await visibleBrowser.reset(id);
 r=get(id);
 if(r.stage==='checking'&&r.pageId){const page=store.getPage(r.pageId);const job=store.enqueueJob({projectId:r.projectId,pageId:page.id,siteId:page.siteId,type:'page_check',payload:{},idempotencyKey:'autopilot-check:'+randomUUID()});update(id,{checkJobId:job.id});}return publicRun(update(id,{...(replacementRequestId?{requestId:replacementRequestId}:{}),state:r.stage==='checking'?'checking':r.stage==='publishing'?'publishing':'queued',error:null}),store);}
 function beforePublish(page){if(store.listRecords(page.projectId,KIND).some(run=>run.pageId===page.id))fail('REVIEW_REQUIRED');}
 async function resumeNative(run){
  if(run.browserPreparing&&!(Date.parse(run.browserPreparingUntil)<=clock()))fail('CONFLICT');
  // An old remote job has its own identity and may already have dispatched.
  // Never turn it into a fresh native-editor publication.
  if(run.jobId||store.listJobs(run.projectId).some(job=>job.pageId===run.pageId&&job.effect==='write'))fail('NATIVE_LEGACY_PUBLICATION');
  if(run.stage==='publishing'&&run.publicationMode!=='native')fail('NATIVE_LEGACY_PUBLICATION');
  if(publicationTurn.isParking(run.id))fail('CONFLICT');
  if(run.publicationParked){
   if(store.getRecord('queue-control:'+run.projectId)?.paused)fail('CONFLICT');
   if(run.nativePublication?.phase==='creating'&&!run.nativePublication.postId)fail('NATIVE_RESULT_UNCERTAIN');
   if(!publicationTurn.claim(run))fail('BROWSER_BUSY');
   update(run.id,{publicationParked:false});
  }
  const showBrowser=run.browserMode==='hidden'&&['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(run.error?.code);
  if(showBrowser){
   const owner=publicationTurn.owner();if(owner&&owner.id!==run.id)fail('BROWSER_BUSY');
   const preparing=update(run.id,{browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString()});
   let unchanged;
   try{await visibleBrowser.reset(run.id);unchanged=get(run.id).revision===preparing.revision;}
   finally{const current=store.getRecord(run.id);if(!current?.deletedAt&&current?.browserPreparingUntil===preparing.browserPreparingUntil)update(run.id,{browserPreparing:false,browserPreparingUntil:null});}
   if(!unchanged||store.getProject(run.projectId)?.archived)fail('CONFLICT');
  }
  if(run.stage==='installing')update(run.id,{publicationMode:'native',apiCredential:null,bootstrapStage:null});
  if(run.siteId){const site=store.getSite(run.siteId);if(site&&!site.enabled)store.updateSite(site.id,{enabled:true},site.revision);}
  if(!showBrowser&&run.browserWindow&&(!publicationTurn.owner()||publicationTurn.owner().id===run.id)&&!await visibleBrowser.resume?.(run.id))await visibleBrowser.reset(run.id);
  if(run.stage==='checking'&&run.pageId&&!run.nativeCleanup){const page=store.getPage(run.pageId),check=store.enqueueJob({projectId:run.projectId,pageId:page.id,siteId:page.siteId,type:'page_check',payload:{},idempotencyKey:'autopilot-check:'+randomUUID()});update(run.id,{checkJobId:check.id});}
  const resumed=update(run.id,{...(run.publicationParked?{publicationParked:false}:{}),state:run.stage==='checking'?'checking':run.stage==='publishing'?'publishing':'queued',error:null,...(showBrowser?{browserMode:'visible',browserWindow:false}:{})});finishManualWait(run.id,run.nativeManualWait);return publicRun(get(resumed.id),store);
 }
 function nativeGuard(id,snapshot,allowPaused=false,{requireBrowser=true}={}){
  const current=get(id);
  const owner=publicationTurn.owner();if(owner&&owner.id!==id)fail('BROWSER_BUSY');
  const lease=activeLeases.get(id);if(!lease||current.leaseToken!==lease.token||Date.parse(current.leaseUntil)<=clock())fail('LEASE_CONFLICT');
  if(store.getProject(current.projectId)?.archived||hasActivePage(current.pageId))fail('CONFLICT');
  if(!allowPaused&&store.getRecord('queue-control:'+current.projectId)?.paused)fail('PROJECT_PAUSED');
  const owned=store.getPage(current.pageId),samePublished=current.publicationMode==='native'&&current.nativePublication?.phase==='published'&&owned?.wpId===current.nativePublication.postId&&owned?.siteId===current.siteId&&owned?.fullUrl===current.nativePublication.url&&owned?.revision===current.nativePublishedRevision;
  // Local bans cannot obstruct reconciliation of an existing remote identity.
  if(!samePublished&&!current.nativePublication&&!current.nativeSnapshot&&!current.siteId&&!current.jobId)selectedPolicyGuard(current);
  if(!samePublished&&current.candidate&&!current.manualTarget&&sourceOptions(current.siteSelection,current.id,{includeRejected:!current.donorPinned}).usedOrigins.some(value=>donorDomainKey(value)===donorDomainKey(current.candidate.baseUrl)))fail('SOURCE_RESERVED');
  if(!samePublished&&current.manualTarget&&manualOriginReserved(current.id,current.candidate?.baseUrl||current.manualTarget.baseUrl))fail('SOURCE_RESERVED');
  if(requireBrowser)visibleBrowser.assertOpen(id);
  const latest=preparedSnapshot(current,store);verifyPublicationApproval(current,store,latest);verifyCustomerOutput(current,latest.rendered,latest.page);
  if(snapshot&&(latest.page.revision!==snapshot.page.revision||latest.materialHash!==snapshot.materialHash))fail('REVIEW_REQUIRED');
  return latest;
 }
 const capabilityScope=run=>({runId:run.id,destinationRevision:run.destinationRevision||0,publicationAttempt:run.publicationAttempt||0});
 function observeAccountTrial(run,index,observedAt){
  const identity=run.candidateSourceIdentity||policySource(),alternate=index===1,encrypted=alternate?run.alternateCredential:run.candidateCredential;
  if(!identity||!encrypted)return;
  donorExclusions?.observe({runId:run.id,origin:run.candidate.baseUrl,origins:donorOrigins(run,run.candidate.baseUrl),sourceIdentity:identity,code:'bootstrap_auth_failed',credentials:box.decrypt(run.id+(alternate?':alternate':''),encrypted),proof:{loginRejectedBeforeWrites:true},retired:false,observedAt:observedAt??null});
 }
 function capabilityView(run){return capabilityHistory&&run.candidate?.baseUrl?capabilityHistory.view({projectId:run.projectId,baseUrl:run.candidate.baseUrl,accountRef:run.capabilityAccountRef,scope:capabilityScope(run)}):{rows:[],truncated:false};}
 function observeCapability(id,{phase,facts,credentials,accountIndex,postId}={}){
  // Historical facts never authorize an operation. Observing them must not
  // replace the outcome of a guarded WordPress action if diagnostics fail.
  try{
   if(!capabilityHistory)return;nativeGuard(id,undefined,true,{requireBrowser:false});const run=get(id);
   const login=credentials||(run.candidateCredential?box.decrypt(id,run.candidateCredential):null);
   const index=accountIndex??run.publicationCapabilities?.accountIndex??run.candidateCredentialIndex??0;
   const identity=capabilityHistory.observe({projectId:run.projectId,baseUrl:run.candidate.baseUrl,credentials:login,accountIndex:index,scope:capabilityScope(run),phase,facts,postId});
   if(!identity)return;const history=capabilityHistory.view({projectId:run.projectId,baseUrl:run.candidate.baseUrl,accountRef:identity.accountRef,scope:capabilityScope(run)});
   const priorCaps=run.capabilityAccountRef===identity.accountRef?run.publicationCapabilities:{};
   update(id,{capabilityHistoryId:identity.historyId,capabilityAccountRef:identity.accountRef,publicationCapabilities:{...priorCaps,accountIndex:index,...facts,history}});
  }catch{/* Optional observations never change native publication safety. */}
 }
 async function publicationPhase(id,phase,action,{method=null,requestClass=null,retries=0}={}){
  nativeGuard(id,undefined,false,{requireBrowser:false});
  const telemetry=createNativeTelemetry({clock}),startedAt=new Date(clock()).toISOString();let error;
  const entry={phase,startedAt,endedAt:null,elapsedMs:null,budgetMs:phase==='reconcile'?120000:180000,code:'UNKNOWN',method,requestClass,safeReadRetries:retries,checkpoint:get(id).nativePublication?.phase};
  try{update(id,{publicationDiagnostics:safePublicationDiagnostics([...(get(id).publicationDiagnostics||[]),entry])});}catch{}
  try{return await action(telemetry.observe);}catch(caught){error=caught;throw caught;}finally{try{
   // The lease and approved material must still own this diagnostic entry.
   nativeGuard(id,undefined,true,{requireBrowser:false});const current=get(id);
   const diagnostics=[...(current.publicationDiagnostics||[])],index=diagnostics.findLastIndex(value=>value.phase===phase&&value.startedAt===startedAt&&value.endedAt===null);
   const code=error?(error.code||(['dispatching','published'].includes(current.nativePublication?.phase)?'NATIVE_RESULT_UNCERTAIN':error.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_ACTION_FAILED')):'OK';
   const {phases,...timing}=telemetry.finish();
   const completed={...entry,...timing,code,httpStatus:timing.httpStatus??error?.httpStatus??null,checkpoint:current.nativePublication?.phase};
   if(index>=0)diagnostics[index]=completed;else diagnostics.push(completed);
   update(id,{publicationDiagnostics:safePublicationDiagnostics([...diagnostics,...phases.map(row=>({...row,budgetMs:entry.budgetMs,safeReadRetries:retries}))])});
  }catch{/* Diagnostics must never replace the native result or a write error. */}}
 }
 const recoveryScope=(run,snapshot,operation='reconcile')=>[operation,run.destinationRevision||0,run.nativePublication?.postId||0,snapshot.materialHash,run.nativeCleanup?.phase||run.nativePublication?.phase||'none'].join(':');
 async function inspectNative(run,browser,snapshot,{explicit=false,signal}={}){
  const scope=recoveryScope(run,snapshot),guard=()=>{if(signal?.aborted)fail('PROJECT_PAUSED');nativeGuard(run.id,snapshot);const current=get(run.id);if(current.destinationRevision!==run.destinationRevision||current.nativePublication?.postId!==run.nativePublication?.postId)fail('CONFLICT');};
  try{return await recoverSafeRead(()=>publicationPhase(run.id,'reconcile',observe=>browser.inspectPublished({saved:run.nativePublication,title:snapshot.page.title,html:snapshot.rendered.html,...(run.slug?{slug:run.slug}:{}),observe}),{method:'GET',requestClass:'editor_read',retries:Math.max(0,(get(run.id).publicationRecovery?.attempt||1)-1)}),{scope,previous:explicit?null:get(run.id).publicationRecovery,guard,clock,signal,persist:value=>update(run.id,{publicationRecovery:value})});}
  catch(error){if(error.code==='NATIVE_NOT_PUBLISHED')update(run.id,{publicationEvidence:{observation:'draft',postId:run.nativePublication.postId,destinationRevision:run.destinationRevision||0,at:new Date(clock()).toISOString()}});if(!['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED','PROJECT_PAUSED','REVIEW_REQUIRED','CONFLICT','LEASE_CONFLICT'].includes(error.code)&&['dispatching','published'].includes(run.nativePublication?.phase)){error.uncertain=true;error.state='uncertain';}throw error;}
 }
 function commitNativePublication(run,snapshot,result){
  const {page,rendered}=snapshot;
  if(result?.status!=='publish'||result.title!==page.title||result.content!==rendered.html||!Number.isSafeInteger(result.postId)||result.postId<1||result.postId!==get(run.id).nativePublication?.postId)fail('NATIVE_CONTENT_CHANGED');
  let url;try{url=validatePublicUrl(result.url);}catch{fail('BROWSER_PUBLICATION_UNCERTAIN');}
  if(url.origin!==new URL(run.candidate.baseUrl).origin)fail('BROWSER_ORIGIN_BLOCKED');
  if(run.slug&&url.pathname.split('/').filter(Boolean).at(-1)!==run.slug)throw Object.assign(Error('NATIVE_SLUG_MISMATCH'),{code:'NATIVE_SLUG_MISMATCH',uncertain:true});
  observeCapability(run.id,{phase:'editor',facts:{editor:'available'}});
  observeCapability(run.id,{phase:'markup',facts:{markup:true},postId:result.postId});
  store.atomic(()=>{nativeGuard(run.id,snapshot,true);const current=get(run.id);
   // These are ordinary WordPress login credentials, encrypted by the existing
   // site vault. Browser-only mode must never send them to REST or Bridge.
   const site=store.getSite(run.siteId),login=current.candidateCredential&&box.decrypt(run.id,current.candidateCredential);
   if(login&&site?.bootstrap?.mode==='browser'){const existing=store.getBrowserCredentials(site.id);if(existing?.username!==login.username||existing?.applicationPassword!==login.applicationPassword)store.updateSite(site.id,{username:login.username,applicationPassword:login.applicationPassword},site.revision);}
   const published=page.wpId===result.postId&&page.fullUrl===url.href?page:store.updatePage(page.id,{siteId:run.siteId,wpId:result.postId,wpType:'page',fullUrl:url.href,lifecycleState:'published',remoteSnapshot:{mode:'browser',postId:result.postId,postType:'page',title:page.title,url:url.href,config:page.config,status:'publish',content:rendered.html,contentHash:createHash('sha256').update(JSON.stringify(['page',page.title,rendered.html,'publish'])).digest('hex')}},page.revision);
   const check=manualPublishedReview?null:store.enqueueJob({projectId:run.projectId,pageId:page.id,siteId:run.siteId,type:'page_check',payload:{},idempotencyKey:'native-verify:'+run.id+':'+(run.publicationAttempt||0)+':'+(run.destinationRevision||0)});
   update(run.id,{nativePublication:{postId:result.postId,phase:'published',url:url.href},nativePublishedRevision:published.revision,publicationEvidence:{observation:'published',at:new Date(clock()).toISOString()},publicationCapabilities:{...current.publicationCapabilities,editor:'available',markup:true},...(check?{candidateCredential:current.nativePluginFallback?current.candidateCredential:null,state:'checking',stage:'checking',error:null,checkJobId:check.id}:publicationComplete)});
  });return url;
 }
 function recordNativeCheck(run,check,code){
  if(run.publicationMode!=='native'||run.publicationCheckedJob===check?.id||!['completed','failed','uncertain','paused'].includes(check?.state))return;
  const page=store.getPage(run.pageId);if(check.type!=='page_check'||check.pageId!==run.pageId||check.siteId!==run.siteId||page?.siteId!==run.siteId||page?.wpId!==run.nativePublication?.postId||page?.fullUrl!==run.nativePublication?.url)return;
  try{nativeGuard(run.id,undefined,true,{requireBrowser:false});const current=get(run.id),start=Date.parse(check.createdAt),end=Date.parse(check.updatedAt),timing=check.result?.timing,worker=timing?.timingScope==='worker_operation'&&Number.isSafeInteger(timing.workerElapsedMs)&&timing.workerElapsedMs>=0;update(run.id,{publicationCheckedJob:check.id,publicationDiagnostics:safePublicationDiagnostics([...(current.publicationDiagnostics||[]),{phase:'check',startedAt:worker?timing.workerStartedAt:check.createdAt,endedAt:worker?timing.workerEndedAt:check.updatedAt,elapsedMs:worker?timing.workerElapsedMs:null,workerQueueWaitMs:timing?.queueWaitMs,workerQueueWaitScope:timing?.queueWaitScope,jobLifetimeMs:Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null,timingScope:worker?'worker_operation':'job_lifetime',budgetMs:60000,code:code||check.error?.code||(check.state==='completed'?'OK':'UNKNOWN'),method:'GET',requestClass:'public_check',safeReadRetries:Math.max(0,(current.publicationRecovery?.attempt||1)-1),checkpoint:'published'}])});}catch{}
 }
 function crawlBlocked(run,page){
  if(run?.publicationMode!=='native'||run.nativePublication?.phase!=='published'||run.nativeCleanup||!page||page.wpId!==run.nativePublication.postId||page.fullUrl!==run.nativePublication.url||page.siteId!==run.siteId||page.verification?.state!=='problem')return false;
  const job=run.checkJobId&&store.getJob(run.checkJobId),verification=job?.result?.verification,checks=job?.result?.checks;
  if(job?.type!=='page_check'||job.state!=='completed'||job.pageId!==page.id||job.siteId!==page.siteId||verification?.state!=='problem'||verification.checkedRevision!==page.revision||verification.checkedAt!==page.verification.checkedAt||verification.contentHash!==page.remoteSnapshot?.contentHash||!Array.isArray(checks))return false;
  return ['public','content','noindex','links','live_browser'].every(kind=>checks.some(check=>check.kind===kind&&check.state==='ok'))&&
   checks.filter(check=>check.state==='problem'||check.state==='unknown').length===1&&checks.some(check=>check.kind==='robots'&&check.state==='problem'&&check.code==='crawl_disallowed');
 }
 function canContinueCrawlBlocked(run,page){
  return run?.state==='needs_attention'&&run.stage==='checking'&&run.error?.code==='CHECK_FAILED'&&publicationTurn.owner()?.id===run.id&&
   !activeLeases.has(run.id)&&!(run.leaseToken&&Date.parse(run.leaseUntil)>clock())&&!run.browserPreparing&&!store.getProject(run.projectId)?.archived&&
   !store.getRecord('queue-control:'+run.projectId)?.paused&&crawlBlocked(run,page);
 }
 async function continueCrawlBlocked(id,expectedRevision){
  store.atomic(()=>{const run=get(id);if(run.revision!==expectedRevision||!canContinueCrawlBlocked(run,store.getPage(run.pageId)))throw Object.assign(Error('Результат перевірки або стан черги змінився. Оновіть список.'),{code:'CONFLICT'});
   update(id,{state:'completed',stage:'completed',error:null,candidateCredential:null});
  });
  if(visibleBrowser)await visibleBrowser.done(id).catch(()=>{});
  publicationTurn.complete(id);
 }
 function canRecheckPublished(run,page){
  if(run?.publicationMode!=='native'||run.nativePublication?.phase!=='published'||run.stage!=='checking'||!['needs_attention','failed','uncertain'].includes(run.state)||run.nativeCleanup||run.jobId||!page)return false;
  const check=run.checkJobId&&store.getJob(run.checkJobId),project=store.getProject(run.projectId);
  return !!(project&&!project.archived&&!project.trashed&&!store.getRecord('queue-control:'+run.projectId)?.paused&&
   publicationTurn.owner()?.id===run.id&&!hasActivePage(page.id)&&!activeLeases.has(run.id)&&!(run.leaseToken&&Date.parse(run.leaseUntil)>clock())&&!run.browserPreparing&&
   page.id===run.pageId&&page.revision===run.nativePublishedRevision&&page.wpId===run.nativePublication.postId&&page.fullUrl===run.nativePublication.url&&page.siteId===run.siteId&&page.remoteSnapshot?.status==='publish'&&
   check?.type==='page_check'&&check.pageId===page.id&&check.siteId===page.siteId&&['completed','failed','uncertain','paused'].includes(check.state));
 }
 function recheckPublished(id,expectedRevision){
  return store.atomic(()=>{
   const run=get(id),page=store.getPage(run.pageId);
   if(run.revision!==expectedRevision||!canRecheckPublished(run,page))fail('CONFLICT');
   const job=store.enqueueJob({projectId:run.projectId,pageId:page.id,siteId:page.siteId,type:'page_check',payload:{publicRecheck:run.revision},idempotencyKey:'public-recheck:'+id+':'+run.revision});
   return publicRun(update(id,{checkJobId:job.id,publicationRecovery:null,state:'checking',error:null}),store);
  });
 }
 function recoverNativeCheck(run,check,page){
  if(run.publicationMode!=='native'||run.nativePublication?.phase!=='published'||!check||check.type!=='page_check'||check.pageId!==page.id||check.siteId!==run.siteId||page.wpId!==run.nativePublication.postId||page.fullUrl!==run.nativePublication.url)return false;
  const transient=new Set(['network_timeout','network_failed','dns_failed','public_read_timeout','public_assets_timeout','browser_timeout','published_assets_incomplete']);
  const checks=check.result?.checks||[],code=check.error?.code||checks.find(value=>value.state==='unknown'&&transient.has(value.code||value.evidence?.code))?.code||checks.find(value=>value.state==='unknown'&&transient.has(value.evidence?.code))?.evidence.code;
  if(!transient.has(code)||checks.some(value=>value.state==='problem')||!['completed','failed','uncertain'].includes(check.state))return false;
  const snapshot=nativeGuard(run.id,undefined,false,{requireBrowser:false}),scope=recoveryScope(run,snapshot,check.payload?.publicRecheck===undefined?'check':'check:'+check.payload.publicRecheck);
  const previous=run.publicationRecovery?.scope===scope?run.publicationRecovery:null,attempt=previous?.attempt||1;
  recordNativeCheck(run,check,code);
  if(attempt>=3){update(run.id,{publicationRecovery:{scope,state:'exhausted',attempt,limit:3,retryAt:null}});return false;}
  if(previous?.state!=='waiting'){update(run.id,{publicationRecovery:{scope,state:'waiting',attempt,limit:3,retryAt:new Date(clock()+100*2**(attempt-1)).toISOString()},state:'checking',error:null});return true;}
  if(Date.parse(previous.retryAt)>clock())return true;
  const next=attempt+1,job=store.enqueueJob({projectId:run.projectId,pageId:page.id,siteId:run.siteId,type:'page_check',payload:check.payload||{},idempotencyKey:'native-read-recovery:'+run.id+':'+scope+':'+next});
  update(run.id,{checkJobId:job.id,state:'checking',error:null,publicationRecovery:{scope,state:'reading',attempt:next,limit:3,retryAt:null}});return true;
 }
 async function installNative(run){
  selectedPolicyGuard(get(run.id));
  if(run.jobId||store.listJobs(run.projectId).some(job=>job.pageId===run.pageId&&job.effect==='write'))fail('NATIVE_LEGACY_PUBLICATION');
  const login=run.candidateCredentialIndex===1?box.decrypt(run.id+':alternate',run.alternateCredential):box.decrypt(run.id,run.candidateCredential);
  let browser;
  try{
   browser=await publicationPhase(run.id,'browser',observe=>visibleBrowser.open(run.id,run.candidate.baseUrl,{headless:run.browserMode==='hidden',observe}),{requestClass:'browser'});
   update(run.id,{publicationMode:'native',browserWindow:true,apiCredential:null,bootstrapStage:null});
   await browser.status('PagePoster · Входимо у WordPress і перевіряємо Clean Links');await publicationPhase(run.id,'login',observe=>browser.login(login,{observe}),{method:'POST',requestClass:'authentication'});update(run.id,{publicationCapabilities:{...get(run.id).publicationCapabilities,accountIndex:run.candidateCredentialIndex||0,login:true}});
  }catch(error){
   if(!error.code&&error.name==='TimeoutError')error=Object.assign(error,{code:'BROWSER_TIMEOUT',state:error.state||'needs_attention'});
   if(error.code==='bootstrap_auth_failed'&&error.loginRejectedBeforeWrites===true)observeCapability(run.id,{phase:'login',facts:{login:false},credentials:login,accountIndex:run.candidateCredentialIndex||0});
   if(await recoverNativeAccess(run.id,error,{beforePageCreation:true}))return;
   throw error;
  }
  run=adoptCanonicalLogin(run.id,browser);
  nativeGuard(run.id);
  observeCapability(run.id,{phase:'login',facts:{login:true},credentials:login,accountIndex:run.candidateCredentialIndex||0});
  let pluginFallback=null;
  try{const installed=await publicationPhase(run.id,'plugin',observe=>browser.ensureCleanLinks({observe,...(run.ampMode?{ampMode:true}:{})}),{requestClass:'plugin'});if(run.ampMode&&installed?.ampSupport!==true)fail('AMP_PLUGIN_REQUIRED');}catch(error){
   if(!error.code&&error.name==='TimeoutError')error=Object.assign(Error(),{code:'BROWSER_TIMEOUT',uncertain:error.uncertain,state:error.state});
   else if(['ENOENT','EACCES','EPERM'].includes(error.code))error=Object.assign(Error(),{code:'CLEAN_LINKS_PACKAGE_INVALID'});
   if(!error.uncertain&&error.state!=='uncertain'&&error.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&error.beforePageCreation===true)observeCapability(run.id,{phase:'plugin',facts:{pluginAccess:false,plugin:'unavailable'},credentials:login,accountIndex:run.candidateCredentialIndex||0});
   // Prefer the supplied second account for a definite capability denial.
   const current=get(run.id);if(error.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&error.beforePageCreation===true&&!error.uncertain&&error.state!=='uncertain'&&!current.candidateCredentialIndex&&current.alternateCredential){update(run.id,{nativePluginPrimaryAvailable:true});if(await recoverNativeAccess(run.id,error))return;}
   const optionalCodes=['CLEAN_LINKS_NOT_ACTIVE','CLEAN_LINKS_NOT_INSTALLED','CLEAN_LINKS_UPDATE_REQUIRED','CLEAN_LINKS_PACKAGE_INVALID','CLEAN_LINKS_FILESYSTEM_REQUIRED','CLEAN_LINKS_INSTALL_FORBIDDEN','BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE','BROWSER_ACTION_FAILED','network_failed','network_timeout'];
   if(run.ampMode&&optionalCodes.includes(error.code))throw Object.assign(Error('AMP requires head support'),{code:'AMP_PLUGIN_REQUIRED',state:'needs_attention'});
   if(error.uncertain||error.state==='uncertain'||!optionalCodes.includes(error.code))throw error;
   nativeGuard(run.id);pluginFallback={code:error.code,detectedAt:new Date(clock()).toISOString()};
  }
  observeCapability(run.id,{phase:'plugin',facts:{plugin:pluginFallback?'unavailable':'active'},credentials:login,accountIndex:run.candidateCredentialIndex||0});
  store.atomic(()=>{nativeGuard(run.id);const current=get(run.id);for(const attempt of current.candidateCredentialFailures||[])if(attempt.code==='bootstrap_auth_failed')observeAccountTrial(current,attempt.index,attempt.at);
   const identity=current.candidateSourceIdentity||policySource();if(identity&&['CLEAN_LINKS_INSTALL_FORBIDDEN','CLEAN_LINKS_FILESYSTEM_REQUIRED'].includes(pluginFallback?.code))donorExclusions?.observe({runId:run.id,origin:current.candidate.baseUrl,origins:donorOrigins(current,current.candidate.baseUrl),sourceIdentity:identity,code:pluginFallback.code,credentials:login,proof:{cleanLinksRestricted:true}});
   let site=store.listAllSites().find(s=>s.baseUrl===run.candidate.baseUrl&&s.bootstrap?.mode==='browser');
   if(site)store.attachSite(run.projectId,site.id);else site=store.createSite(run.projectId,{name:new URL(run.candidate.baseUrl).hostname,baseUrl:run.candidate.baseUrl});
   store.updateSite(site.id,{enabled:true,status:'ok',capabilities:{browserEditor:true},plugins:{cleanLinks:pluginFallback?{state:'unavailable',code:pluginFallback.code}:{state:'active'}},bootstrap:{state:'ready',mode:'browser'},lastCheckedAt:new Date(clock()).toISOString()},site.revision);
   update(run.id,{nativePluginFallback:pluginFallback,nativePluginPrimaryAvailable:false,publicationCapabilities:{...get(run.id).publicationCapabilities,plugin:pluginFallback?'unavailable':'active'},siteId:site.id,candidateCredential:box.encrypt(run.id,login),candidateCredentialIndex:0,candidateCredentialFailures:[],alternateCredential:null,state:'publishing',stage:'publishing'});
  });
 }
 function adoptCanonicalLogin(id,browser){
  return store.atomic(()=>{
   const current=get(id);if(!browser.baseUrl||browser.baseUrl===current.candidate.baseUrl)return current;
   const proof=browser.canonicalLogin,canonical=validatePublicUrl(browser.baseUrl).href;
   if(!proof||proof.baseUrl!==canonical||canonicalLoginProofBase(current.candidate.baseUrl,proof)!==canonical)fail('BROWSER_ORIGIN_BLOCKED');
   if(current.stage!=='installing'||current.nativePublication||current.nativeSnapshot||current.siteId||current.jobId)fail('NATIVE_RESULT_UNCERTAIN');
   nativeGuard(id);if(current.manualTarget?manualOriginReserved(id,canonical):sourceOptions(current.siteSelection,id,{includeRejected:!current.donorPinned}).usedOrigins.some(value=>donorDomainKey(value)===donorDomainKey(canonical)))fail('SOURCE_RESERVED');
   update(id,{candidate:{...current.candidate,baseUrl:canonical},...(current.manualTarget?{manualTarget:{...current.manualTarget,baseUrl:canonical}}:{}),canonicalLogin:{...proof,requestedBaseUrl:current.candidate.baseUrl,baseUrl:canonical},destinationRevision:(current.destinationRevision||0)+1});
   rebindApprovedDestination(id,current.publicationApproval,'canonical-login');return get(id);
  });
 }
 async function recoverNativeAccess(id,error,{beforePageCreation=false,duringCreation=false}={}){
  if(error.uncertain||error.state==='uncertain')return false;
  const rejected=error.code==='bootstrap_auth_failed'&&error.loginRejectedBeforeWrites===true;
  const permission=error.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&error.beforePageCreation===true;
  const unsentCreation=duringCreation&&error.writeNotAttempted===true&&isPreCreationDonorFailure(error.code);
  const unavailable=unsentCreation||beforePageCreation&&['BROWSER_PAGE_UNAVAILABLE','BROWSER_TIMEOUT','BROWSER_LOGIN_UNCONFIRMED','BROWSER_ORIGIN_BLOCKED','dns_failed','network_failed','network_timeout','unsafe_address','unsafe_url','invalid_redirect','cross_origin_redirect','too_many_redirects'].includes(error.code);
  if(!rejected&&!permission&&!unavailable)return false;
  const handled=store.atomic(()=>{
   const current=get(id),page=store.getPage(current.pageId);
   const eligibleStage=unsentCreation?current.stage==='publishing':current.stage==='installing'&&!current.nativeSnapshot&&!current.siteId;
   if(!eligibleStage||current.nativePublication||current.nativeCleanup||current.jobId||current.checkJobId||page.wpId||page.fullUrl||store.listJobs(current.projectId).some(job=>job.pageId===page.id&&job.effect==='write'))return false;
   // A failed initial open can already have disposed its private context. This
   // local donor rejection still checks ownership, lease, approval and content.
   nativeGuard(id,undefined,false,{requireBrowser:!unavailable});
   const attempts=[...(current.candidateCredentialFailures||[]),{index:current.candidateCredentialIndex||0,code:error.code,at:new Date(clock()).toISOString()}];
   if(rejected&&current.candidateCredentialIndex===1&&current.nativePluginPrimaryAvailable){
    observeAccountTrial(current,1,attempts.at(-1).at);
    const action=typeof visibleBrowser.switchAccount==='function'?'switch':'reset';
    update(id,{candidateCredentialIndex:0,alternateCredential:null,nativePluginPrimaryAvailable:false,candidateCredentialFailures:attempts,browserWindow:action!=='reset',state:'queued',error:null});return action;
   }
   if((rejected||permission)&&!current.candidateCredentialIndex&&current.alternateCredential){
    const browserAction=rejected?'retain':typeof visibleBrowser.switchAccount==='function'?'switch':'reset';
    update(id,{candidateCredentialIndex:1,candidateCredentialFailures:attempts,browserWindow:browserAction!=='reset',state:'queued',error:null});return browserAction;
   }
   if(permission||current.manualTarget||current.donorPinned)return false;
   let policyRecord;const context={runId:id,origin:current.candidate.baseUrl,origins:donorOrigins(current,current.candidate.baseUrl),sourceIdentity:current.candidateSourceIdentity||policySource()};
   for(const attempt of attempts){if(attempt.code!=='bootstrap_auth_failed')continue;const alternate=attempt.index===1,encrypted=alternate?current.alternateCredential:current.candidateCredential;if(!encrypted)continue;const observation=donorExclusions?.observe({...context,code:'bootstrap_auth_failed',credentials:box.decrypt(id+(alternate?':alternate':''),encrypted),proof:{loginRejectedBeforeWrites:true},observedAt:attempt.at??null});if(attempt.index===(current.candidateCredentialIndex||0)&&rejected)policyRecord=observation;}
   if(!policyRecord)policyRecord=donorExclusions?.observe({...context,code:error.code,proof:{prePage:unavailable},credentials:box.decrypt(id+(current.candidateCredentialIndex===1?':alternate':''),current.candidateCredentialIndex===1?current.alternateCredential:current.candidateCredential)});
   const skipped=publicDonorSkip({baseUrl:current.candidate.baseUrl,code:error.code,httpStatus:error.httpStatus});
   const donorSkips=[...(current.donorSkips||[]),{id:current.candidate.id,...skipped,...(current.canonicalLogin?.baseUrl===current.candidate.baseUrl?{canonicalLogin:current.canonicalLogin}:{}),attempts,at:new Date(clock()).toISOString(),...(policyRecord?{policyId:policyRecord.id}:{})}];
   const clearedPreparation=unsentCreation?{siteId:null,nativeSnapshot:null,nativeCreationNotStarted:false,nativePluginFallback:null,canonicalLogin:null,publicationMode:null,proxyBinding:null,publicationAttempt:(current.publicationAttempt||0)+1}:{};
   update(id,{...clearedPreparation,donorSkips,candidate:null,candidateCredential:null,alternateCredential:null,candidateCredentialIndex:0,candidateCredentialFailures:[],browserWindow:false,destinationRevision:(current.destinationRevision||0)+1,state:donorSkips.length>=10?'needs_attention':'queued',stage:'selecting',error:donorSkips.length>=10?safeError({code:'SOURCE_REPLACEMENTS_EXHAUSTED'}):null});
   rebindApprovedDestination(id,current.publicationApproval);return 'reset';
  });
  // Rejected credentials keep their form; authenticated account changes must
  // isolate cookies, while replacing the donor always starts a fresh session.
  if(handled==='switch')await visibleBrowser.switchAccount(id);else if(handled==='reset')await visibleBrowser.reset(id);return !!handled;
 }
 function rebindApprovedDestination(id,approval,policy='donor-access'){
  if(!approval)return;const snapshot=preparedSnapshot(get(id),store);
  update(id,{publicationApproval:{...approval,initialMaterialHash:approval.initialMaterialHash||approval.materialHash,reviewToken:snapshot.reviewToken,pageRevision:snapshot.page.revision,materialHash:snapshot.materialHash,replacementPolicy:policy}});
 }
 async function publishNative(run){
  if(run.publicationMode!=='native'||run.jobId)fail('NATIVE_LEGACY_PUBLICATION');
  if(!run.nativePublication||run.nativePublication.phase==='draft')selectedPolicyGuard(get(run.id));
  if(!run.nativeCapacityReserved)store.atomic(()=>{store.assertPublicationCapacity(run.projectId,run.pageId,maxPages);update(run.id,{nativeCapacityReserved:true});});
  const browser=await publicationPhase(run.id,'browser',observe=>visibleBrowser.open(run.id,run.candidate.baseUrl,{headless:run.browserMode==='hidden',observe}),{requestClass:'browser'});
  if(!run.candidateCredential)fail('BROWSER_LOGIN_REQUIRED');await publicationPhase(run.id,'login',observe=>browser.login(box.decrypt(run.id,run.candidateCredential),{observe}),{method:'POST',requestClass:'authentication'});
  if(browser.baseUrl&&browser.baseUrl!==run.candidate.baseUrl)fail('BROWSER_ORIGIN_BLOCKED');
  const snapshot=nativeGuard(run.id),{page,rendered}=snapshot;
  const previous=run.nativeSnapshot;
  if(previous&&(previous.pageRevision!==page.revision||previous.materialHash!==snapshot.materialHash))fail('REVIEW_REQUIRED');
  if(!previous)update(run.id,{nativeSnapshot:{pageRevision:page.revision,materialHash:snapshot.materialHash}});
  const notStarted=run.nativeDispatchNotStarted;
  if(run.nativePublication?.phase==='dispatching'&&notStarted?.postId===run.nativePublication.postId&&notStarted.materialHash===snapshot.materialHash&&notStarted.pageRevision===page.revision&&notStarted.destinationRevision===(run.destinationRevision||0)&&notStarted.publicationAttempt===(run.publicationAttempt||0)){
   nativeGuard(run.id,snapshot);update(run.id,{nativePublication:{postId:notStarted.postId,phase:'draft'},nativeDispatchNotStarted:null,publicationRecovery:null});run=get(run.id);
  }
  let creationCheckpoint=false;
  const checkpoint=async saved=>{
   if(saved?.phase==='creating'&&saved.postId===null){const prior=get(run.id).nativePublication;if(prior)fail('BROWSER_PUBLICATION_UNCERTAIN');nativeGuard(run.id,snapshot);selectedPolicyGuard(get(run.id));update(run.id,{nativePublication:{postId:null,phase:'creating'},nativeCreationNotStarted:false});creationCheckpoint=true;return;}
   if(saved?.phase==='not_started'&&saved.postId===null&&saved.requestNotStarted===true){const prior=get(run.id).nativePublication;if(!creationCheckpoint||prior?.phase!=='creating'||prior.postId!==null)fail('BROWSER_PUBLICATION_UNCERTAIN');nativeGuard(run.id,snapshot);update(run.id,{nativePublication:null,nativeCreationNotStarted:true});creationCheckpoint=false;return;}
   if(!Number.isSafeInteger(saved?.postId)||saved.postId<1||!['draft','dispatching','published'].includes(saved.phase))fail('BROWSER_PUBLICATION_UNCERTAIN');
   const current=get(run.id),prior=current.nativePublication;
   if(prior&&prior.phase!=='creating'&&prior.postId!==saved.postId||prior?.phase==='creating'&&saved.phase!=='draft'||prior?.phase==='published'&&saved.phase!=='published')fail('BROWSER_PUBLICATION_UNCERTAIN');
   // The dispatch marker must be durable before the browser can submit.
   if(saved.phase==='dispatching'){nativeGuard(run.id,snapshot);store.assertPublicationCapacity(run.projectId,run.pageId,maxPages);}
   update(run.id,{nativePublication:{postId:saved.postId,phase:saved.phase,...(saved.url?{url:saved.url}:{})}});
  };
  let result;
  if(run.nativePublication&&!['draft','creating'].includes(run.nativePublication.phase)){
   result=await inspectNative(run,browser,snapshot);
  }
  const beforeSend=()=>{try{nativeGuard(run.id,snapshot);selectedPolicyGuard(get(run.id));store.assertPublicationCapacity(run.projectId,run.pageId,maxPages);}
   catch(error){if(['PROJECT_PAUSED','DONOR_MANUALLY_BLOCKED','DONOR_POLICY_BLOCKED'].includes(error.code)){nativeGuard(run.id,snapshot,true);const current=get(run.id);if(current.nativePublication?.phase==='dispatching')update(run.id,{nativeDispatchNotStarted:{postId:current.nativePublication.postId,materialHash:snapshot.materialHash,pageRevision:page.revision,destinationRevision:current.destinationRevision||0,publicationAttempt:current.publicationAttempt||0,at:new Date(clock()).toISOString()}});}throw error;}
  };
  if(!result){try{result=await publicationPhase(run.id,'publish',observe=>browser.publishPage({title:page.title,html:rendered.html,...(run.slug?{slug:run.slug}:{}),saved:get(run.id).nativePublication||null,checkpoint,beforeSend,observe}),{method:'POST',requestClass:'publication'});}
   catch(error){const current=get(run.id);if(Number.isSafeInteger(current.nativePublication?.postId)&&['dispatching','published'].includes(current.nativePublication.phase)&&(safeReadRecoverable(error)||!error.code)){result=await inspectNative(current,browser,snapshot);}else if(await recoverNativeAccess(run.id,error,{duringCreation:true}))return;else throw error;}}
  const url=commitNativePublication(get(run.id),snapshot,result);
  if(run.ampMode){
   const contentHash=store.getPage(page.id)?.remoteSnapshot?.contentHash;
   const ampStatus=await checkAmpPair({url:url.href,html:rendered.ampOriginalHtml,title:page.title,language:run.language||'en',transport:browser.networkTransport});
   try{if(contentHash)update(run.id,{ampStatus:{...ampStatus,contentHash,checkedAt:new Date(clock()).toISOString()}});}catch{}
  }
  if(!manualPublishedReview)await visibleBrowser.result(run.id,url.href).catch(()=>{});
 }

 // Cleanup authority is tied to the exact completed verification, never a later
 // aggregate monitoring result or the mere absence of a public URL.
 function fallbackVisual(check){
  const visual=check?.result?.checks?.find(c=>c.kind==='visual_layout');
  const views=visual?.evidence?.viewports;
  if(!visual||!Array.isArray(views)||views.length!==1||views[0].name!=='desktop'||views.some(v=>!['ok','problem'].includes(v.state)))return 'unknown';
  if(visual.state==='problem'&&views.some(v=>v.state==='problem'))return 'problem';
  return visual.state==='ok'&&views.every(v=>v.state==='ok')?'ok':'unknown';
 }
 function cleanupGuard(id,{allowPaused=false,requireBrowser=false}={}){
  const current=get(id),owner=publicationTurn.owner(),lease=activeLeases.get(id);
  if(owner?.id!==id)fail('BROWSER_BUSY');
  if(!lease||current.leaseToken!==lease.token||Date.parse(current.leaseUntil)<=clock())fail('LEASE_CONFLICT');
  if(store.getProject(current.projectId)?.archived||hasActivePage(current.pageId))fail('CONFLICT');
  if(!allowPaused&&store.getRecord('queue-control:'+current.projectId)?.paused)fail('PROJECT_PAUSED');
  if(requireBrowser)visibleBrowser.assertOpen(id);
  const snapshot=preparedSnapshot(current,store);verifyPublicationApproval(current,store,snapshot);verifyCustomerOutput(current,snapshot.rendered,snapshot.page);
  const page=snapshot.page,publication=current.nativePublication,check=store.getJob(current.checkJobId),cleanup=current.nativeCleanup;
  const contentHash=createHash('sha256').update(JSON.stringify(['page',page.title,snapshot.rendered.html,'publish'])).digest('hex');
  if(!current.nativePluginFallback||current.publicationMode!=='native'||current.jobId||current.stage!=='checking'||publication?.phase!=='published'||page.wpType!=='page'||page.wpId!==publication.postId||page.siteId!==current.siteId||page.fullUrl!==publication.url||page.revision!==current.nativePublishedRevision||page.remoteSnapshot?.mode!=='browser'||page.remoteSnapshot.status!=='publish'||page.remoteSnapshot.content!==snapshot.rendered.html||page.remoteSnapshot.contentHash!==contentHash||current.nativeSnapshot?.materialHash!==snapshot.materialHash||new URL(page.fullUrl).origin!==new URL(current.candidate.baseUrl).origin)fail('NATIVE_TRASH_UNCERTAIN');
  if(check?.state!=='completed'||check.type!=='page_check'||check.pageId!==page.id||check.siteId!==page.siteId||check.result?.verification?.checkedRevision!==page.revision||check.result.verification.contentHash!==contentHash||fallbackVisual(check)!=='problem')fail('NATIVE_VISUAL_UNCONFIRMED');
  if(cleanup&&(cleanup.pageId!==page.id||cleanup.pageRevision!==page.revision||cleanup.siteId!==page.siteId||cleanup.postId!==page.wpId||cleanup.url!==page.fullUrl||cleanup.checkJobId!==check.id||cleanup.contentHash!==contentHash||cleanup.materialHash!==snapshot.materialHash))fail('NATIVE_TRASH_UNCERTAIN');
  return {...snapshot,current,check,contentHash};
 }
 async function cleanupBrokenNative(id){
  let snapshot=cleanupGuard(id),run=snapshot.current;
  if(!run.nativeCleanup){update(id,{nativeCleanup:{phase:'prepared',postId:snapshot.page.wpId,pageId:snapshot.page.id,pageRevision:snapshot.page.revision,siteId:run.siteId,url:snapshot.page.fullUrl,checkJobId:run.checkJobId,contentHash:snapshot.contentHash,materialHash:snapshot.materialHash}});run=get(id);}
  const browser=await publicationPhase(id,'browser',observe=>visibleBrowser.open(id,run.candidate.baseUrl,{headless:run.browserMode==='hidden',observe}),{requestClass:'browser'});
  if(!run.candidateCredential)fail('BROWSER_LOGIN_REQUIRED');await publicationPhase(id,'login',observe=>browser.login(box.decrypt(id,run.candidateCredential),{observe}),{method:'POST',requestClass:'authentication'});
  if(browser.baseUrl&&browser.baseUrl!==run.candidate.baseUrl)fail('BROWSER_ORIGIN_BLOCKED');
  cleanupGuard(id,{requireBrowser:true});
  let result;try{result=await publicationPhase(id,'cleanup',observe=>browser.trashPublished({saved:run.nativePublication,title:snapshot.page.title,html:snapshot.rendered.html,cleanup:run.nativeCleanup,observe,
   checkpoint:async saved=>{cleanupGuard(id,{allowPaused:saved?.phase==='trashed',requireBrowser:true});const current=get(id),prior=current.nativeCleanup;if(saved?.postId!==prior.postId||!['dispatching','trashed'].includes(saved.phase)||prior.phase==='trashed'&&saved.phase!=='trashed')fail('NATIVE_TRASH_UNCERTAIN');update(id,{nativeCleanup:{...prior,phase:saved.phase,...(saved.phase==='trashed'?{confirmedAt:new Date(clock()).toISOString()}:{})}});},
   beforeSend:()=>cleanupGuard(id,{requireBrowser:true})}),{method:'GET',requestClass:'publication'});}
  catch(error){if(get(id).nativeCleanup?.phase!=='dispatching'||!safeReadRecoverable(error)||typeof browser.inspectOwnedTrash!=='function')throw error;try{result=await inspectNativeTrash(id,browser,snapshot);}catch(readError){if(!['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED','PROJECT_PAUSED','REVIEW_REQUIRED','CONFLICT','LEASE_CONFLICT'].includes(readError.code)){readError.uncertain=true;readError.state='uncertain';}throw readError;}}
  if(result?.status!=='trash'||result.postId!==run.nativePublication.postId)fail('NATIVE_TRASH_UNCERTAIN');
  store.atomic(()=>{
   const {current,page}=cleanupGuard(id,{allowPaused:true});if(current.nativeCleanup.phase!=='trashed')fail('NATIVE_TRASH_UNCERTAIN');
   const at=new Date(clock()).toISOString(),history={baseUrl:current.candidate.baseUrl,siteId:current.siteId,nativePublication:current.nativePublication,nativeSnapshot:current.nativeSnapshot,nativePublishedRevision:current.nativePublishedRevision,checkJobId:current.checkJobId,nativeCleanup:current.nativeCleanup,changedAt:at};
   const policyRecord=donorExclusions?.observe({runId:id,origin:current.candidate.baseUrl,origins:donorOrigins(current,current.candidate.baseUrl),code:'NATIVE_VISUAL_REJECTED',materialHash:renderedHash({...snapshot.rendered,title:page.title}),proof:{ownedTrashConfirmed:true}});
   const donorSkips=[...(current.donorSkips||[]),{id:current.candidate.id,baseUrl:current.candidate.baseUrl,...(current.canonicalLogin?{canonicalLogin:current.canonicalLogin}:{}),code:'NATIVE_VISUAL_REJECTED',at,...(policyRecord?{policyId:policyRecord.id}:{})}];
   store.updatePage(page.id,{siteId:null,wpId:null,fullUrl:'',remoteSnapshot:null,lifecycleState:'draft'},page.revision);
   const pinned=!!current.manualTarget||current.donorPinned===true;
   update(id,{destinationHistory:[...(current.destinationHistory||[]),history],donorSkips,manualTarget:pinned?current.manualTarget:null,manualCredential:pinned?current.manualCredential:null,donorPinned:pinned&&current.donorPinned===true,candidate:pinned?current.candidate:null,candidateCredential:pinned?current.candidateCredential:null,alternateCredential:pinned?current.alternateCredential:null,candidateCredentialIndex:pinned?current.candidateCredentialIndex:0,candidateCredentialFailures:pinned?current.candidateCredentialFailures:[],canonicalLogin:null,apiCredential:null,bootstrapStage:null,nativePluginFallback:null,nativePluginPrimaryAvailable:false,nativeCleanup:null,nativePublication:null,nativeCreationNotStarted:false,nativeSnapshot:null,nativePublishedRevision:null,nativeCapacityReserved:true,publicationMode:null,siteId:null,jobId:null,checkJobId:null,browserWindow:false,proxyBinding:null,destinationRevision:(current.destinationRevision||0)+1,publicationAttempt:(current.publicationAttempt||0)+1,...(pinned?{publicationApproval:null,stage:'installing',state:'needs_attention',error:safeError({code:'NATIVE_VISUAL_REJECTED'})}:{stage:'selecting',state:donorSkips.length>=10?'needs_attention':'queued',error:donorSkips.length>=10?safeError({code:'SOURCE_REPLACEMENTS_EXHAUSTED'}):null})});
   // A pin authorizes this destination only. Confirmed cleanup never grants
   // permission to publish on a different donor or reuse the old approval.
   if(!pinned)rebindApprovedDestination(id,current.publicationApproval,'visual-fallback');
  });
  await visibleBrowser.reset(id);
 }
 async function inspectNativeTrash(id,browser,snapshot,{explicit=false,signal}={}){
  const run=get(id),scope=recoveryScope(run,snapshot,'owned_trash_read');
  if(typeof browser.inspectOwnedTrash!=='function')fail('NATIVE_TRASH_UNCERTAIN');
  const proof=await recoverSafeRead(()=>publicationPhase(id,'reconcile',async observe=>{const result=await browser.inspectOwnedTrash({saved:run.nativePublication,title:snapshot.page.title,html:snapshot.rendered.html,observe});if(result?.postId!==run.nativePublication.postId||result.status!=='trash')fail('NATIVE_TRASH_UNCERTAIN');return result;},{method:'GET',requestClass:'owned_trash_read',retries:Math.max(0,(get(id).publicationRecovery?.attempt||1)-1)}),{scope,previous:explicit?null:run.publicationRecovery,guard:()=>{if(signal?.aborted)fail('PROJECT_PAUSED');cleanupGuard(id,{requireBrowser:true});},clock,signal,persist:value=>update(id,{publicationRecovery:value})});
  cleanupGuard(id,{requireBrowser:true});update(id,{nativeCleanup:{...get(id).nativeCleanup,phase:'trashed',confirmedAt:new Date(clock()).toISOString()},publicationEvidence:{observation:'trashed',postId:run.nativePublication.postId,destinationRevision:run.destinationRevision||0,at:new Date(clock()).toISOString()}});return proof;
 }

 function recoverUnattemptedConflict(run,job){
  if(job?.type!=='publish'||job.effect!=='write'||job.state!=='failed'||job.error?.code!=='CONFLICT'||job.result?.writeNotAttempted!==true||job.attempt!==1)return false;
  const page=store.getPage(run.pageId);if(!page||page.wpId||job.pageId!==page.id||job.siteId!==page.siteId||page.revision===job.payload.expectedRevision)return false;
  // Retain the failed immutable job and receipt; the next approval gets a new write identity.
  update(run.id,{reviewBeforePublish:true,publicationApproval:null,jobId:null,publicationAttempt:(run.publicationAttempt||0)+1,state:'awaiting_review',error:safeError({code:'REVIEW_REQUIRED'})});return true;
 }
 async function perform(run){
 if(run.stage==='preparing'){
  const rendered=renderPage(prepareConfig(run.customerConfig));verifyCustomerOutput(run,rendered);
  store.atomic(()=>{const current=get(run.id);if(current.pageId)return;const page=store.createPage(run.projectId,{title:rendered.title,keyword:'',config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing'});update(run.id,{pageId:page.id,title:rendered.title,customerConfig:null,state:current.reviewBeforePublish?'awaiting_review':'queued',stage:'selecting',error:null});});return;
 }
 if(run.stage==='generating'){
  const variation=Number.isSafeInteger(run.editorialVariant)?'editorial-v2:'+run.editorialVariant+':'+run.id:run.id;
  const generated=await planner.generate({requestId:run.requestId,links:run.links,variation,...(run.editorial?{editorial:run.editorial}:{})});const rendered=renderPage(prepareConfig({...generated.config,chromeMode:run.chromeMode||'custom'}));if(generated.quality?.state!=='passed')fail('CONTENT_FACT_REVIEW_REQUIRED');
  store.atomic(()=>{const current=get(run.id);if(current.pageId)return;const page=store.createPage(run.projectId,{title:rendered.title,keyword:generated.topic||'',config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing'});store.commitGeneration('autopilot-text:'+run.id,{pageId:page.id,sourceRevision:page.revision,quality:generated.quality,patch:{config:rendered.config,title:rendered.title,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing'}});update(run.id,{pageId:page.id,title:rendered.title,state:current.reviewBeforePublish?'awaiting_review':'queued',stage:'selecting',error:null});});return;
 }
 if(run.stage==='selecting'){
  verifyPublicationApproval(get(run.id),store);
  if(!run.manualTarget&&!sourceConfigured()){update(run.id,{state:'waiting_source',error:safeError({code:'SOURCE_NOT_CONFIGURED'})});return;}
  if(!box)fail('KEY_REQUIRED');
  let candidate;
  const connection=donorConnection(),choose=()=>{if(run.manualTarget){const credentials=box.decrypt(run.id+':manual',run.manualCredential);return {id:'manual:'+run.id,baseUrl:run.manualTarget.baseUrl,rowNumber:null,username:credentials.username,password:credentials.applicationPassword};}return policyPick(run,sourceConfig,sourceOptions(run.siteSelection,run.id));};
  candidate=visibleBrowser?.nativeEditor===true?await publicationPhase(run.id,'selection',choose):await choose();
  if(!candidate)fail('SOURCE_EMPTY');
  store.atomic(()=>{const current=get(run.id);verifyPublicationApproval(current,store);if(!current.manualTarget&&!sameDonorConnection(connection))fail('CONFLICT');const identity=candidateSourceIdentities.get(candidate)||policySource(),used=sourceOptions(current.siteSelection,current.id);if(!current.manualTarget&&(used.usedOrigins.some(value=>donorDomainKey(value)===donorDomainKey(candidate.baseUrl))||used.usedRowIds.includes(candidate.id))||current.manualTarget&&manualOriginReserved(current.id,candidate.baseUrl))fail('SOURCE_RESERVED');candidate=candidatePolicy(candidate,current,{sourceIdentity:identity}).candidate;if(!candidate)fail('DONOR_POLICY_BLOCKED');update(run.id,{candidate:{id:candidate.id,baseUrl:candidate.baseUrl,rowNumber:candidate.rowNumber??null,...(candidate.metrics?{metrics:candidate.metrics}:{})},candidateSourceIdentity:identity,candidateCredential:box.encrypt(run.id,{username:candidate.username,applicationPassword:candidate.password}),manualCredential:null,alternateCredential:candidate.alternateCredentials?box.encrypt(run.id+':alternate',{username:candidate.alternateCredentials.username,applicationPassword:candidate.alternateCredentials.password}):null,donorPinned:false,candidateCredentialIndex:0,candidateCredentialFailures:[],state:'queued',stage:'installing'});if(current.donorSkips?.length)rebindApprovedDestination(run.id,current.publicationApproval);});return;
 }
 if(run.stage==='installing'){
  verifyPublicationApproval(get(run.id),store);
  if(visibleBrowser?.nativeEditor===true){if(!box)fail('KEY_REQUIRED');await installNative(run);return;}
  if(!box)fail('KEY_REQUIRED');const login=run.candidateCredentialIndex===1?box.decrypt(run.id+':alternate',run.alternateCredential):box.decrypt(run.id,run.candidateCredential),savedCredential=run.apiCredential?box.decrypt(run.id+':api',run.apiCredential):undefined;
  const browser=visibleBrowser?await visibleBrowser.open(run.id,run.candidate.baseUrl,{headless:run.browserMode==='hidden'}):null;
  if(browser){update(run.id,{browserWindow:true});await browser.status('PagePoster · Входимо у WordPress і перевіряємо плагіни');if(savedCredential)await browser.login(login);}
  const bootstrap=bootstrapFactory({...(browser?{transport:browser.transport}:{}),checkpoint:async checkpoint=>{const patch={bootstrapStage:checkpoint.stage};if(checkpoint.credential)patch.apiCredential=box.encrypt(run.id+':api',{username:checkpoint.credential.username,applicationPassword:checkpoint.credential.applicationPassword});update(run.id,patch);if(browser)await browser.status(checkpoint.stage==='ready'?'PagePoster · Доступ і плагіни перевірено':checkpoint.stage==='installing_plugins'?'PagePoster · Установлюємо й активуємо плагіни':'PagePoster · Налаштовуємо WordPress');}});
  let access;try{access=await bootstrap.ensureReady({baseUrl:run.candidate.baseUrl,username:login.username,password:login.applicationPassword,operationId:run.id,savedCredential,checkpointState:{stage:run.bootstrapStage||''}});}catch(error){
   const current=get(run.id);
   if(current.manualTarget&&error.code==='bootstrap_auth_failed'&&error.loginRejectedBeforeWrites===true&&!error.uncertain&&error.state!=='uncertain'&&!current.apiCredential&&!current.bootstrapStage){update(run.id,{candidate:null,candidateCredential:null,manualCredential:box.encrypt(run.id+':manual',login),stage:'selecting',state:'awaiting_review',publicationApproval:null,error:safeError(error)});return;}
   if(error.code==='bootstrap_auth_failed'&&error.loginRejectedBeforeWrites===true&&!error.uncertain&&error.state!=='uncertain'&&!current.apiCredential&&!current.bootstrapStage&&!current.candidateCredentialIndex&&current.alternateCredential){update(run.id,{candidateCredentialIndex:1,state:'queued',error:null});return;}
   throw error;
  }if(access?.state!=='ready')fail('SITE_NOT_READY');if(browser)browser.markAuthenticated();
  // Verify the same REST capabilities and package hashes used by publication.
  const ready=await client.checkSite({baseUrl:run.candidate.baseUrl,username:access.username,applicationPassword:access.applicationPassword});if(ready.state!=='ok'||!ready.apiRoot)fail('SITE_NOT_READY');
  const integrity=await bridge.checkStatus({site:{baseUrl:run.candidate.baseUrl,username:access.username,applicationPassword:access.applicationPassword},apiRoot:ready.apiRoot});if(!integrity.ready||!integrity.integrityVerified)fail('SITE_NOT_READY');
  store.atomic(()=>{verifyPublicationApproval(get(run.id),store);let site=store.listAllSites().find(s=>s.baseUrl===run.candidate.baseUrl);if(site){store.attachSite(run.projectId,site.id);site=store.updateSite(site.id,{username:access.username,applicationPassword:access.applicationPassword},site.revision);}else site=store.createSite(run.projectId,{name:new URL(run.candidate.baseUrl).hostname,baseUrl:run.candidate.baseUrl,username:access.username,applicationPassword:access.applicationPassword});const plugins=Object.fromEntries(Object.entries(ready.plugins||{}).map(([key,value])=>[key,{...value,integrityVerified:integrity.integrity?.[key]===true,compatible:integrity.integrity?.[key]===true}]));site=store.updateSite(site.id,{enabled:true,status:'ok',capabilities:ready.capabilities||{},plugins,bootstrap:{state:'ready'},lastCheckedAt:new Date(clock()).toISOString()},site.revision);update(run.id,{siteId:site.id,candidateCredential:browser?box.encrypt(run.id,login):null,alternateCredential:null,apiCredential:null,state:'queued',stage:'publishing'});});return;
 }
 if(run.stage==='publishing'){
  if(visibleBrowser?.nativeEditor===true){await publishNative(run);return;}
  if(visibleBrowser&&run.browserWindow&&(!run.jobId||['queued','running','paused','uncertain'].includes(store.getJob(run.jobId)?.state))){const browser=await visibleBrowser.open(run.id,run.candidate.baseUrl,{headless:run.browserMode==='hidden'});if(!run.candidateCredential)fail('BROWSER_LOGIN_REQUIRED');await browser.login(box.decrypt(run.id,run.candidateCredential));await browser.publication();}
  let current=get(run.id);if(!current.jobId){store.atomic(()=>{current=get(run.id);if(current.jobId)return;const snapshot=preparedSnapshot(current,store),{page,rendered}=snapshot;verifyPublicationApproval(current,store,snapshot);verifyCustomerOutput(current,rendered,page);const attempt=current.publicationAttempt?':'+current.publicationAttempt:'';const receipt=store.commitGeneration('autopilot-publish:'+current.id+attempt,{pageId:page.id,sourceRevision:page.revision,patch:{siteId:current.siteId,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing',lifecycleState:'queued'},publication:{idempotencyKey:current.id+attempt,mode:'publish',html:rendered.html,maxPages}});update(current.id,{jobId:receipt.jobId,state:'publishing'});});return;}
  const job=store.getJob(current.jobId);if(recoverUnattemptedConflict(current,job))return;if(job.state==='completed'){if(manualPublishedReview){update(run.id,publicationComplete);return;}const page=store.getPage(current.pageId);const check=store.listJobs(current.projectId).find(j=>j.pageId===page.id&&j.type==='page_check'&&j.idempotencyKey==='verify:'+job.id)||store.enqueueJob({projectId:current.projectId,pageId:page.id,siteId:page.siteId,type:'page_check',payload:{},idempotencyKey:'verify:'+job.id});update(run.id,{state:'checking',stage:'checking',checkJobId:check.id,candidateCredential:null});if(visibleBrowser&&run.browserWindow)await visibleBrowser.result(run.id,page.fullUrl).catch(()=>{});}else if(['failed','uncertain','paused'].includes(job.state))update(run.id,{state:job.state==='uncertain'?'uncertain':'needs_attention',error:safeError(job.error||{code:'PUBLICATION_FAILED'})});else update(run.id,{state:'publishing'});return;
 }
 if(run.stage==='checking'){if(run.nativeCleanup){await cleanupBrokenNative(run.id);return;}const check=store.getJob(run.checkJobId),page=store.getPage(run.pageId);if(recoverNativeCheck(run,check,page))return;recordNativeCheck(get(run.id),check,check?.result?.checks?.some(value=>value.state==='problem')?'CHECK_FAILED':null);if(check?.state==='completed'){
   if(run.nativePluginFallback){const visual=fallbackVisual(check);if(visual==='problem'&&check.payload?.publicRecheck===undefined){await cleanupBrokenNative(run.id);return;}if(visual!=='ok'){update(run.id,{state:'needs_attention',error:safeError({code:visual==='problem'?'CHECK_FAILED':'NATIVE_VISUAL_UNCONFIRMED'})});return;}}
   const evidence=check.result?.verification,exactCheck=run.nativePluginFallback||check.payload?.publicRecheck!==undefined;
   if(exactCheck&&(check.type!=='page_check'||check.pageId!==page.id||check.siteId!==run.siteId||page.siteId!==run.siteId||page.wpId!==run.nativePublication?.postId||page.fullUrl!==run.nativePublication?.url||evidence?.checkedRevision!==page.revision||page.revision!==run.nativePublishedRevision||evidence.contentHash!==page.remoteSnapshot?.contentHash)){update(run.id,{state:'needs_attention',error:safeError({code:run.nativePluginFallback?'NATIVE_VISUAL_UNCONFIRMED':'CHECK_FAILED'})});return;}
   const ok=(exactCheck?evidence:page.verification)?.state==='ok';update(run.id,{state:ok?'completed':'needs_attention',stage:ok?'completed':'checking',...(ok?{candidateCredential:null,...(run.publicationRecovery?.scope?.startsWith('check:')?{publicationRecovery:{...run.publicationRecovery,state:'confirmed',retryAt:null}}:{})}:{}),error:ok?null:safeError({code:'CHECK_FAILED'})});}else if(['failed','uncertain','paused'].includes(check?.state))update(run.id,{state:'needs_attention',error:safeError(check.error||{code:'CHECK_FAILED'})});else update(run.id,{state:'checking'});}
 }
 async function tick({lane='all',slot=0}={}){
  const laneKey=lane==='generation'?'generation:'+slot:lane;
  if(!['all','generation','publication'].includes(lane)||busyLanes.has(laneKey)||busyLanes.has('all')||lane==='all'&&busyLanes.size)return null;
  if(lane==='generation'&&(!Number.isSafeInteger(slot)||slot<0||slot>1))return null;
  busyLanes.add(laneKey);let heartbeat,claimed;
  try{
   if(lane!=='generation'){
    if(manualPublishedReview){finishConfirmedLegacyPublications();const owner=publicationTurn.owner();if(owner?.kind===KIND&&owner.state==='completed'&&!activeLeases.has(owner.id))await closeCompletedPublication(owner);}
    await publicationTurn.retireInactive();
   }
   const run=store.atomic(()=>{
    const controls=new Map(store.listProjects().map(p=>[p.id,store.getRecord('queue-control:'+p.id)]));
    const owner=publicationTurn.owner();
    const eligible=allRuns().filter(r=>!r.publicationParked&&['queued','running','publishing','checking'].includes(r.state)&&(!r.browserPreparing||Date.parse(r.browserPreparingUntil)<=clock())&&(!controls.get(r.projectId)?.paused||r.stage==='checking'||store.getProject(r.projectId)?.archived&&r.stage==='publishing'&&!!r.jobId)&&(!store.getProject(r.projectId)?.archived||(visibleBrowser?.nativeEditor!==true||owner?.id===r.id)&&(r.stage==='publishing'&&!!r.jobId||r.stage==='checking'&&!!r.checkJobId))&&(!r.leaseToken||Date.parse(r.leaseUntil)<=clock())&&(lane==='all'||(lane==='generation')===['preparing','generating'].includes(r.stage))&&(!owner||r.id===owner.id||['preparing','generating'].includes(r.stage)));
    eligible.sort((a,b)=>(controls.get(b.projectId)?.priority||0)-(controls.get(a.projectId)?.priority||0)||Number(a.projectId===lastProjects.get(lane))-Number(b.projectId===lastProjects.get(lane))||a.updatedAt.localeCompare(b.updatedAt));
    const current=lane==='publication'&&eligible.find(r=>r.id===publicationCurrent);
    const next=current||eligible[0];if(!next)return null;
    if(!['preparing','generating'].includes(next.stage)&&!publicationTurn.claim(next))return null;
    if(lane==='publication')publicationCurrent=next.id;lastProjects.set(lane,next.projectId);
    const token=randomUUID();claimed={id:next.id,token};activeLeases.set(next.id,claimed);
    return store.updateRecord(next.id,{browserPreparing:false,browserPreparingUntil:null,leaseToken:token,leaseOwner:workerId,leaseUntil:new Date(clock()+180000).toISOString(),...(['preparing','generating','selecting','installing'].includes(next.stage)?{state:'running'}:{})},next.revision);
   });
   if(!run)return null;
   heartbeat=setInterval(()=>{try{update(run.id,{leaseUntil:new Date(clock()+180000).toISOString()});}catch{}},10000);heartbeat.unref?.();
   try{
    if(run.queueItemId&&lane==='publication'&&run.stage==='selecting'&&!run.browserWindow&&visibleBrowser?.prepare&&!visibleBrowser.nativeEditor){await visibleBrowser.prepare(run.id,{headless:run.browserMode==='hidden'});update(run.id,{browserWindow:true});}
    await perform(run);if(get(run.id).error&&visibleBrowser)await visibleBrowser.error(run.id,get(run.id).error.code);else if(get(run.id).state==='completed')await closeCompletedPublication(get(run.id)).catch(()=>{});
   }catch(e){if(visibleBrowser?.nativeEditor&&['installing','publishing'].includes(run.stage)&&!e?.code){const phase=get(run.id).nativePublication?.phase,uncertain=e?.uncertain||e?.state==='uncertain'||phase==='dispatching'||phase==='published';e={code:uncertain?'NATIVE_RESULT_UNCERTAIN':e?.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_ACTION_FAILED',uncertain:!!uncertain,state:uncertain?'uncertain':'needs_attention'};}e={...e,code:e?.code,stage:run.stage};if(e.code==='PROJECT_PAUSED'&&!e.uncertain)update(run.id,{state:run.stage==='checking'?'paused':run.stage==='publishing'?'publishing':'queued',error:null});else if(e.code!=='LEASE_CONFLICT'){const state=e.code==='REVIEW_REQUIRED'&&!get(run.id).jobId?(get(run.id).nativePublication&&get(run.id).nativePublication.phase!=='draft'?'uncertain':'awaiting_review'):e.uncertain||e.state==='uncertain'||['AI_RESULT_UNCERTAIN','AI_TIMEOUT'].includes(e.code)?'uncertain':e.state==='needs_attention'?'needs_attention':'failed';update(run.id,{state,error:safeError(e)});if(visibleBrowser)await visibleBrowser.error(run.id,e.code).catch(()=>{});}}
   return publicRun(get(run.id),store);
  }finally{clearInterval(heartbeat);if(claimed){activeLeases.delete(claimed.id);store.atomic(()=>{const r=get(claimed.id);if(r.leaseToken===claimed.token)store.updateRecord(r.id,{leaseToken:null,leaseOwner:null,leaseUntil:null},r.revision);});}busyLanes.delete(laneKey);}
 }
 async function reconcileNative(id,body,signal){
  fields(body,['expectedRevision']);if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail('VALIDATION');
  let run=get(id);if(run.revision!==body.expectedRevision||activeLeases.has(id)||run.leaseToken&&Date.parse(run.leaseUntil)>clock()||run.browserPreparing)fail('CONFLICT');
  if(visibleBrowser?.nativeEditor!==true||run.publicationMode!=='native'||run.jobId)fail('CONFLICT');
  if(manualPublishedReview&&run.stage==='completed')fail('CONFLICT');
  if(run.nativePublication?.phase==='published'&&run.stage==='checking'&&!run.nativeCleanup){
   const current=recheckPublished(id,body.expectedRevision);
   return {run:current,publication:current.publication,observation:'published'};
  }
  if(!publicationTurn.claim(run))fail('CONFLICT');
  const token=randomUUID();store.atomic(()=>{const current=get(id);if(current.revision!==body.expectedRevision||current.leaseToken&&Date.parse(current.leaseUntil)>clock())fail('CONFLICT');store.updateRecord(id,{leaseToken:token,leaseOwner:workerId,leaseUntil:new Date(clock()+180000).toISOString()},current.revision);activeLeases.set(id,{id,token});});
  let observation='unknown';
  try{
   const snapshot=nativeGuard(id,undefined,false,{requireBrowser:false});run=get(id);
   if(!Number.isSafeInteger(run.nativePublication?.postId)||run.nativePublication.postId<1)observation='missing_identity';
   else{
    const browser=await publicationPhase(id,'browser',observe=>visibleBrowser.open(id,run.candidate.baseUrl,{headless:run.browserMode==='hidden',observe}),{requestClass:'browser'});nativeGuard(id,snapshot,false,{requireBrowser:false});
    if(browser.baseUrl&&browser.baseUrl!==run.candidate.baseUrl)fail('BROWSER_ORIGIN_BLOCKED');
    update(id,{browserWindow:true});
    if(run.candidateCredential){await publicationPhase(id,'login',observe=>browser.login(box.decrypt(id,run.candidateCredential),{observe}),{method:'POST',requestClass:'authentication'});nativeGuard(id,snapshot);}
    if(run.nativeCleanup){
     cleanupGuard(id,{requireBrowser:true});const proof=await inspectNativeTrash(id,browser,snapshot,{explicit:true,signal});if(proof?.status==='trash')observation='trashed';
    }else{
     try{const result=await inspectNative(run,browser,snapshot,{explicit:true,signal});nativeGuard(id,snapshot);commitNativePublication(run,snapshot,result);observation='published';}
     catch(error){if(error.code==='NATIVE_NOT_PUBLISHED')observation='draft';else throw error;}
    }
   }
   update(id,{publicationEvidence:{observation,postId:run.nativePublication?.postId||null,destinationRevision:run.destinationRevision||0,at:new Date(clock()).toISOString()},...(observation==='draft'?{state:'uncertain',error:safeError({code:'NATIVE_NOT_PUBLISHED',stage:'publishing'})}:observation==='trashed'?{error:null}:{})});
  }catch(error){if(['CONFLICT','LEASE_CONFLICT','REVIEW_REQUIRED','PROJECT_PAUSED'].includes(error.code))throw error;nativeGuard(id,undefined,false,{requireBrowser:false});update(id,{publicationEvidence:{observation:'unknown',at:new Date(clock()).toISOString()},error:safeError(error),state:['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code)?'needs_attention':'uncertain'});}
  finally{activeLeases.delete(id);store.atomic(()=>{const current=get(id);if(current.leaseToken===token)store.updateRecord(id,{leaseToken:null,leaseOwner:null,leaseUntil:null},current.revision);});}
  const current=publicRun(get(id),store);return {run:current,publication:current.publication,observation};
 }
 function preparedExport(id,variant='prepared',includeOriginal=true){
  const originalFor=run=>{if(run.source!=='html')return null;const item=run.queueItemId&&store.getRecord(run.queueItemId);if(item?.kind==='project_queue_item'&&item.runId===run.id&&item.projectId===run.projectId&&item.input?.source==='html')return item.input.html;
   const original=store.getRecord('original-html:'+run.id);return original?.kind==='customer_original'&&original.runId===run.id&&original.projectId===run.projectId&&typeof original.html==='string'&&createHash('sha256').update(original.html,'utf8').digest('hex')===original.sourceHash?original.html:null;
  };
  const run=get(id),snapshot=readPreparedSnapshot(run,store),page=snapshot.page,originalHtml=includeOriginal?originalFor(run):null;
  return createManualExport({runId:run.id,pageId:page.id,pageRevision:page.revision,title:page.title,originalHtml:typeof originalHtml==='string'?originalHtml:null,preparedHtml:snapshot.rendered.html,variant});
 }
 async function handle(request,route,read){
  const manualExportRoute=/^\/autopilot\/([a-zA-Z0-9-]+)\/manual-export$/.exec(route);
  if(route==='/autopilot/manual-export'&&request.method==='POST'||manualExportRoute&&request.method==='GET'){
   try{
    if(!manualExportRoute){const body=fields(await read(request),['source','html','baseUrl','brand','brandUrl','chromeMode','reviewToken','variant']),{reviewToken,variant='prepared',...values}=body,input=sourceInput(values,true),preview=customerPreview(input);if(typeof reviewToken!=='string'||reviewToken!==preview.reviewToken)fail('HTML_REVIEW_REQUIRED');return json(createManualExport({title:preview.title,originalHtml:input.html,preparedHtml:preview.html,variant}));}
    const params=new URL(request.url).searchParams;if([...params.keys()].some(key=>key!=='variant')||params.getAll('variant').length>1)fail('VALIDATION');
    return json(preparedExport(manualExportRoute[1],params.get('variant')||'prepared'));
   }catch(error){const code=['VALIDATION','HTML_REVIEW_REQUIRED','MANUAL_ORIGINAL_UNAVAILABLE','NOT_FOUND','NATIVE_SNAPSHOT_UNAVAILABLE'].includes(error?.code)?error.code:'MANUAL_EXPORT_FAILED',message=code==='MANUAL_ORIGINAL_UNAVAILABLE'?'Оригінальний HTML для цієї сторінки не збережений. Можна скопіювати підготовлений варіант.':code==='HTML_REVIEW_REQUIRED'?'HTML змінився після перегляду. Оновіть перегляд перед експортом.':code==='NOT_FOUND'?'Готову сторінку не знайдено.':code==='VALIDATION'?'Оберіть доступний варіант HTML для експорту.':'Не вдалося підтвердити матеріал для експорту. Оновіть сторінку та спробуйте ще раз.';return json({code,error:message},code==='NOT_FOUND'?404:code==='VALIDATION'?400:409);}
  }
  const capabilitiesRoute=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/capabilities$/);
  if(capabilitiesRoute&&request.method==='GET'){const run=get(capabilitiesRoute[1]);return json({capabilities:capabilityView(run)});}
  const reconciliation=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/(reconciliation|reconcile)$/);
  if(reconciliation){if(reconciliation[2]==='reconciliation'&&request.method==='GET'){const run=publicRun(get(reconciliation[1]),store);return json({run,publication:run.publication});}if(reconciliation[2]==='reconcile'&&request.method==='POST'){try{return json(await reconcileNative(reconciliation[1],await read(request),request.signal));}catch(error){if(['CONFLICT','LEASE_CONFLICT','REVIEW_REQUIRED','PROJECT_PAUSED','BROWSER_BUSY'].includes(error.code))return json({code:error.code,error:safeError(error).message},409);throw error;}}}
  const ampProject=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/amp-mode$/);
  if(ampProject&&request.method==='POST'){
   const body=fields(await read(request),['enabled']);if(typeof body.enabled!=='boolean')fail('VALIDATION');
   if(body.enabled){if(!visibleBrowser?.nativeEditor)fail('AMP_PLUGIN_REQUIRED');await ampValidatorInit();}
   const projectId=ampProject[1];
   if(ampModeChanges.has(projectId))fail('CONFLICT');ampModeChanges.add(projectId);
   const fenced=new Map();
   const eligibleRuns=()=>{
    const project=store.getProject(projectId);
    if(!project||project.archived)fail('NOT_FOUND');
    const runs=store.listRecords(projectId,KIND).filter(run=>!run.deletedAt);
    const pending=[];
    const writtenPages=new Set(store.listJobs(projectId).filter(job=>job.effect==='write').map(job=>job.pageId));
    for(const run of runs){
     const page=run.pageId&&store.getPage(run.pageId);
     if(run.state==='completed'&&page?.wpId&&page.fullUrl)continue;
     const ownBrowserFence=fenced.has(run.id)&&run.browserPreparingUntil===fenced.get(run.id);
     if(run.nativePublication||run.nativeCleanup||run.jobId||run.checkJobId||run.leaseToken||page?.wpId||page?.fullUrl||writtenPages.has(run.pageId))fail('CONFLICT');
     if(run.browserPreparing&&!ownBrowserFence)fail('CONFLICT');
     if(!['queued','awaiting_review','failed','needs_attention'].includes(run.state)||run.state==='queued'&&run.publicationApproval)fail('CONFLICT');
     pending.push(run);
    }
    return pending;
   };
   try{
    const closing=store.atomic(()=>{
     const runs=eligibleRuns().filter(run=>run.browserWindow);
     for(const run of runs){
      const until=new Date(clock()+180000).toISOString();
      fenced.set(run.id,until);
      update(run.id,{browserPreparing:true,browserPreparingUntil:until});
     }
     return runs.map(run=>run.id);
    });
    for(const id of closing)await visibleBrowser?.reset?.(id);
    return json(store.atomic(()=>{
     for(const run of eligibleRuns()){
      if(run.pageId&&body.enabled)preparedSnapshot({...run,ampMode:true},store);
      update(run.id,{
       ampMode:body.enabled,ampStatus:null,publicationApproval:null,nativeSnapshot:null,
       browserWindow:false,browserPreparing:false,browserPreparingUntil:null,
       ...(run.pageId?{state:'awaiting_review',stage:run.candidate?'installing':'selecting',error:null}:{})
      });
     }
     const modeId='amp-mode:'+projectId,mode={enabled:body.enabled},old=store.getRecord(modeId);
     if(old)store.updateRecord(modeId,mode,old.revision);
     else store.createRecord(projectId,'amp_project_mode',mode,modeId);
     return mode;
    }));
   }finally{
    try{for(const [id,until] of fenced){if(get(id).browserPreparingUntil===until)update(id,{browserPreparing:false,browserPreparingUntil:null});}}
    finally{ampModeChanges.delete(projectId);}
   }
  }
  if(route==='/autopilot/browser-settings'&&request.method==='POST'){
   const body=fields(await read(request),['mode']);if(!['visible','hidden'].includes(body.mode))fail('VALIDATION');
   await mkdir(dataDir,{recursive:true});const temporary=browserSettingsFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify({mode:body.mode}),{mode:0o600,flag:'wx'});await rename(temporary,browserSettingsFile);browserMode=body.mode;return json({browserMode});
  }
  if(route==='/autopilot/preview'&&request.method==='POST'){const input=sourceInput(await read(request),true);const preview=customerPreview(input);return json({html:preview.html,title:preview.title,warnings:preview.warnings,reviewToken:preview.reviewToken});}
  if(route==='/autopilot/status'&&request.method==='GET')return json({source:sourceStatus(),visibleBrowser:!!visibleBrowser,browserMode,aiConfigured:!!ai.env?.OPENAI_API_KEY,aiModel:ai.env?.OPENAI_MODEL||'gpt-5.4-mini'});
  if(route==='/autopilot/source/check'&&request.method==='POST')return json(await checkSource(await read(request),{signal:request.signal}));
  if(route==='/autopilot/source'&&['POST','PATCH'].includes(request.method))return json({source:await saveSource(await read(request))});
  if(route==='/autopilot/donor-exclusions'&&request.method==='GET'){
   if(!donorExclusions)fail('KEY_REQUIRED');const query=Object.fromEntries(new URL(request.url).searchParams);fields(query,['search','offset','limit','state']);if(query.state!==undefined&&!['active','all'].includes(query.state))fail('VALIDATION');return json(donorExclusions.listPublic(query));
  }
  if(['/autopilot/donor-exclusions/ban','/autopilot/donor-exclusions/release'].includes(route)&&request.method==='POST'){
   if(!donorExclusions)fail('KEY_REQUIRED');const body=fields(await read(request),route.endsWith('/ban')?['origin','expectedRevision']:['id','expectedRevision']);let item;
   if(route.endsWith('/ban')){if(typeof body.origin!=='string'||!body.origin.trim())fail('VALIDATION');const value=body.origin.trim(),url=validatePublicUrl(/^[a-z][a-z0-9+.-]*:/i.test(value)?value:'https://'+value);item=donorExclusions.setManualBan({origin:url.origin,expectedRevision:body.expectedRevision});}
   else item=donorExclusions.release(body);
   invalidateSelection();return json({item});
  }
  const donorChoice=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/(donors|donor)$/);if(donorChoice&&(donorChoice[2]==='donors'&&request.method==='GET'||donorChoice[2]==='donor'&&request.method==='POST')){
   try{return json(donorChoice[2]==='donors'?await listDonors(donorChoice[1],request):{run:await chooseDonor(donorChoice[1],await read(request))});}
   catch(error){const code=Object.hasOwn(messages,error?.code)||['NOT_FOUND','DONOR_SELECTION_EXPIRED','GOOGLE_AUTH_REQUIRED'].includes(error?.code)?error.code:'AUTOPILOT_FAILED',friendly=code==='DONOR_SELECTION_EXPIRED'?'Список донорів застарів. Оновіть його й оберіть сайт ще раз.':code==='CONFLICT'?destinationBlockedReason(get(donorChoice[1]),store)||'Сторінка або джерело змінилися. Оновіть список донорів.':safeError({code}).message;return json({code,error:friendly},code==='NOT_FOUND'?404:['CONFLICT','DONOR_SELECTION_EXPIRED','SOURCE_RESERVED','DONOR_POLICY_BLOCKED','DONOR_MANUALLY_BLOCKED'].includes(code)?409:400);}
  }
  const destination=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/destination$/);if(destination&&request.method==='POST'){try{const run=setDestination(destination[1],await read(request));try{await visibleBrowser?.reset(run.id);}finally{const current=store.getRecord(run.id);if(current&&!current.deletedAt)update(run.id,{browserPreparing:false,browserPreparingUntil:null});}return json({run:publicRun(get(run.id),store)});}catch(error){if(error.code==='CONFLICT')return json({code:'DESTINATION_UNAVAILABLE',error:destinationBlockedReason(get(destination[1]),store)||'Сайт уже змінено в іншій вкладці. Оновіть список.'},409);if(error.code==='SOURCE_RESERVED')return json({code:error.code,error:messages.SOURCE_RESERVED},409);if(error.code==='MANUAL_SITE_INVALID')return json({code:error.code,error:'Укажіть домен WordPress (example.com) або HTTPS-адресу без параметрів, логін і пароль адміністратора.'},400);throw error;}}
  const browserFocus=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/browser$/);if(browserFocus&&request.method==='POST'){fields(await read(request),[]);const run=get(browserFocus[1]);if(!visibleBrowser||!run.browserWindow||run.browserMode==='hidden')fail('BROWSER_NOT_OPEN');await visibleBrowser.focus(run.id);return json({opened:true});}
  const deletion=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/delete$/);if(deletion&&request.method==='POST'){fields(await read(request),[]);try{return json(await removeWithBrowser(deletion[1]));}catch(error){if(error.code==='CONFLICT')return json({code:'DELETE_UNAVAILABLE',error:'Запуск уже виконується або пов’язаний із публікацією. Оновіть список і дочекайтеся завершення роботи.'},409);throw error;}}
  const launchRoute=route.match(/^\/projects\/([a-zA-Z0-9-]+)\/autopilot$/);if(launchRoute){if(!store.getProject(launchRoute[1]))fail('NOT_FOUND');if(request.method==='GET')return json({runs:store.listRecords(launchRoute[1],KIND).filter(r=>!r.deletedAt).map(r=>publicRun(r,store))});if(request.method==='POST')return json({run:launch(launchRoute[1],await read(request))},202);}
  const action=route.match(/^\/autopilot\/([a-zA-Z0-9-]+)\/(resume|approve|preview|html)$/);if(action){const run=get(action[1]);if(action[2]==='approve'&&request.method==='POST'){const body=await read(request),alreadyApproved=!!get(run.id).publicationApproval;let approved=approve(run.id,body);if(!alreadyApproved&&visibleBrowser?.prepare&&(!visibleBrowser.nativeEditor||run.candidate||run.manualTarget)&&!store.getRecord('queue-control:'+run.projectId)?.paused&&publicationTurn.claim(get(run.id))){update(run.id,{browserPreparing:true,browserPreparingUntil:new Date(clock()+180000).toISOString()});try{await visibleBrowser.prepare(run.id,{headless:approved.browserMode==='hidden',...(visibleBrowser.nativeEditor?{baseUrl:run.candidate?.baseUrl||run.manualTarget?.baseUrl}:{})});approved=publicRun(update(run.id,{browserWindow:true,browserPreparing:false,browserPreparingUntil:null}),store);}catch(error){approved=publicRun(update(run.id,{browserPreparing:false,browserPreparingUntil:null,state:'needs_attention',error:safeError(error)}),store);}}return json({run:approved},202);}if(action[2]==='resume'&&request.method==='POST'){fields(await read(request),[]);return json({run:await resume(run.id)},202);}if(request.method==='GET'&&['preview','html'].includes(action[2])){if(!run.pageId)fail('NOT_FOUND');const snapshot=readPreparedSnapshot(run,store),rendered=snapshot.rendered;if(action[2]==='html')return json({html:rendered.html,...(run.reviewBeforePublish?{reviewToken:snapshot.reviewToken}:{})});return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+rendered.html+previewNavigation+'</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src https: data:; script-src 'unsafe-inline'"}});}}
  return null;
 }
 function beforeRemoteWrite(job){const owner=store.listRecords(job.projectId,KIND).find(r=>r.pageId===job.pageId),run=owner?.jobId===job.id?owner:null;try{if(owner&&visibleBrowser?.nativeEditor===true)fail('NATIVE_LEGACY_PUBLICATION');if(owner&&!run&&(job.type==='publish'||owner.destinationHistory?.some(target=>target.jobId===job.id)))fail('CONFLICT');if(run?.browserWindow){if(!visibleBrowser)fail('BROWSER_UNAVAILABLE');visibleBrowser.assertOpen(run.id);}}catch(error){error.writeNotAttempted=job.attempt===1;throw error;}}
 function browserSubmit(job){const run=store.listRecords(job.projectId,KIND).find(r=>r.jobId===job.id);return run?.browserWindow&&visibleBrowser?.publish?input=>visibleBrowser.publish(run.id,input):null;}
 return {handle,tick,launch,approve,resume,crawlBlocked,canContinueCrawlBlocked,continueCrawlBlocked,canRecheckPublished,saveSource,selectPending,reviewToken,retrySelection,invalidateSelection,destinationStatus,beforePublish,beforeRemoteWrite,browserSubmit,publicationTurn,publicationStatus:publicationTurn.status,status:sourceStatus,googleAccount:()=>['user','browser'].includes(sourceConfig?.authMode)?null:sourceConfig?.serviceAccount||null,googleAccessToken,preparedExport,previewHtml:input=>customerPreview({source:'html',...input}),list:projectId=>store.listRecords(projectId,KIND).filter(r=>!r.deletedAt).map(r=>publicRun(r,store))};
}
