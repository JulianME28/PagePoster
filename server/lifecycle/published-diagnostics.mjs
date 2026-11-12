// Public diagnostics contain local explanations, known check identities and
// bounded counters only. Never copy snapshots, URLs, headers, exceptions or HTML.
const messages={
 unsupported_page_scripts:'На сторінці є непідтримувані скрипти, обробники або вбудовані документи. Автоматична перевірка неповна; перевірте сторінку вручну.',
 published_assets_incomplete:'Не вдалося перевірити всі зображення, стилі або шрифти сторінки. Перевірте доступність ресурсів.',
 published_expectations_incomplete:'Частину посилань або ресурсів не вдалося перевірити. Перегляньте результати для комп’ютера.',
 published_browser_problem:'Перевірка опублікованої сторінки в браузері виявила проблему.',
 published_verified:'Вміст, оформлення та посилання опублікованої сторінки перевірено.',
 content_mismatch:'Публічна сторінка відрізняється від збереженого HTML. Перевірте кеш сайту та вміст сторінки.',
 expected_content_missing:'Немає збереженого HTML для порівняння з публічною сторінкою.',
 isolated_browser_unavailable:'Немає збереженого HTML для безпечної перевірки опублікованої сторінки.',
 browser_unavailable:'Браузер для перевірки недоступний. Перевірте встановлення Chrome або Edge.',
 public_read_timeout:'Час отримання опублікованої сторінки вичерпано. Сайт не повернув сторінку за відведений час.',
 public_assets_timeout:'Час підготовки ресурсів сторінки вичерпано. Перевірка вигляду в Chromium ще не завершена.',
 browser_timeout:'Час перевірки браузером вичерпано. Повторіть перевірку пізніше.',
 browser_check_failed:'Не вдалося завершити перевірку браузером. Повторіть перевірку сторінки.',
 browser_validation:'Збережений HTML або параметри перевірки непридатні для перевірки браузером.',
 navigation_interception_unavailable:'Браузер не підтримує безпечну перевірку переходів. Оновіть браузер.',
 unsafe_url:'Адреса сторінки непридатна для безпечної публічної перевірки.',
 unsafe_address:'Адреса сторінки веде до непублічної мережі. Публічну перевірку зупинено.',
 cross_origin_redirect:'Сторінка або ресурс переспрямовує на інший сайт. Публічну перевірку зупинено.',
 public_http_error:'Сайт повернув помилку замість опублікованої сторінки.',
 invalid_response:'Сайт повернув непридатну відповідь для перевірки сторінки.',
 network_timeout:'Сайт не відповів за відведений час. Повторіть перевірку пізніше.',
 network_failed:'Не вдалося отримати сторінку для перевірки. Перевірте доступність сайту.',
 dns_failed:'Не вдалося визначити публічну адресу сайту. Повторіть перевірку пізніше.',
 unsupported_encoding:'Формат відповіді сайту не підтримується перевіркою.',
 response_too_large:'Відповідь сайту перевищує межу безпечної перевірки.',
 invalid_redirect:'Сайт повернув непридатну адресу переспрямування.',
 too_many_redirects:'Сайт повернув забагато переспрямувань.'
};
const checkLabels={marker:'Обгортка сторінки',links:'Точні адреси посилань',cta_targets:'Кнопки та підписи',navigation:'Навігація розділами',overflow:'Ширина сторінки',required_content:'Видимість вмісту',runtime:'Скрипт PagePoster',clean_links_runtime:'Скрипт Clean Links',assets:'Зображення',mobile_menu:'Мобільне меню',clicks:'Переходи кнопок'};
const progressStages={public_read:'Отримання сторінки',public_assets:'Завантаження ресурсів',baseline_assets:'Підготовка еталонного HTML',browser_launch:'Запуск браузера',public_render:'Відображення сторінки на ПК',visual_compare:'Порівняння вигляду на ПК',screenshot:'Збереження знімка',interactions:'Перевірка кнопок',cleanup:'Завершення перевірки'};
const states=new Set(['ok','problem','unknown','not_applicable']);
const knownDetails=new Set([
 'Arbitrary site scripts, handlers or embedded documents require an externally isolated browser runner.',
 'Fresh public content, desktop/mobile layout, exact controls and intercepted navigation verified.',
 'Fresh public content, desktop layout, exact controls and intercepted navigation verified.',
 'A required published-page browser check failed.',
 'Some expected destinations or public assets could not be verified.',
 'The constrained public browser check could not finish.',
 'No horizontal overflow detected at this viewport.','Content exceeds the viewport width.',
 'One visible page wrapper.','Missing, duplicate or invisible page wrapper.',
 'No expected destination list was supplied.','Exact destinations match the required native link groups.','Missing, extra, duplicate or unsafe native destinations.',
 'Destination attributes and accessible labels were inspected; remote destinations were not opened.',
 'An in-page navigation target is missing.','In-page navigation destinations exist.',
 'A required published heading is hidden by page or theme styles.','Required published headings are visible.',
 'A required published section is hidden by page or theme styles.','Required published sections are visible.','Required structural coverage exceeded the bounded scan.',
 'Required structural coverage could not be confirmed.','Required published sections match the prepared desktop visibility.',
 'The exact published PagePoster runtime mounted.','The public policy or document prevented the required runtime from mounting.','No PagePoster runtime is required.',
 'The exact Clean Links runtime removes outside dynamic destinations and preserves local and PagePoster links.','The public policy or document prevented required Clean Links behavior.',
 'Visible images decoded in the browser.','A visible image did not decode; public asset rendering is incomplete.',
 'The mobile menu opens, each item reaches its visible target, and the menu closes.','The mobile menu could not open, reach each visible target, or close after selection.','No mobile menu is required at this viewport.'
]);
const safeDetail=(value,fallback)=>typeof value==='string'&&(knownDetails.has(value)||/^Activated \d{1,4} controls; destinations were intercepted without partner navigation\. \d{1,4} failed\.$/.test(value))?value:fallback;
const bounded=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000;
const limitations=Object.freeze(['Виконуються лише точні упаковані скрипти PagePoster та Clean Links для цього сайту; інші скрипти залишаються неперевіреними.','Знімок обмежує мережу CSP і маршрутизацією браузера; це не мережева ізоляція операційної системи. Сайти призначення не відвідуються.']);
export function safePublishedEvidence(live={},screenshots=live.screenshots){
 const previous=live.evidence&&typeof live.evidence==='object'&&!Array.isArray(live.evidence)?live.evidence:{};
 const code=Object.hasOwn(messages,live.code||previous.code)?live.code||previous.code:'browser_check_failed';
 const source=live.viewports||previous.viewports,networkSource=live.network||previous.network||{};
 const inputProgress=live.progress||previous.progress;const progress=inputProgress&&Object.hasOwn(progressStages,inputProgress.stage)&&Number.isSafeInteger(inputProgress.elapsedMs)&&inputProgress.elapsedMs>=0&&inputProgress.elapsedMs<=60000&&Number.isSafeInteger(inputProgress.budgetMs)&&inputProgress.budgetMs>=1000&&inputProgress.budgetMs<=60000?{stage:inputProgress.stage,elapsedMs:inputProgress.elapsedMs,budgetMs:inputProgress.budgetMs}:null;
 const network={};for(const name of ['fetchedAssets','blockedAssets','failedAssets','untrustedScripts','removedHandlers','unsupportedDocuments','deniedBrowserRequests'])if(bounded(networkSource[name]))network[name]=networkSource[name];
 const linkInput=live.linkSummary||previous.linkSummary,linkFields=['expectedUrls','ourUrls','nativeHrefs','repeatedControls','outsideUrls','unexpectedOurUrls'];
 const linkSummary=linkInput&&linkFields.every(k=>bounded(linkInput[k]))?Object.fromEntries(linkFields.map(k=>[k,linkInput[k]])):null;
 const viewports=[],names=new Set();for(const view of Array.isArray(source)?source.slice(0,4):[]){
  if(!view||!['desktop','mobile'].includes(view.name)||names.has(view.name))continue;names.add(view.name);
  const checks=[];for(const check of Array.isArray(view.checks)?view.checks.slice(0,16):[]){if(!check||!Object.hasOwn(checkLabels,check.kind)||!states.has(check.state))continue;checks.push({kind:check.kind,state:check.state,detail:safeDetail(check.evidence||check.detail,checkLabels[check.kind]+': '+({ok:'перевірено',problem:'виявлено проблему',unknown:'не підтверджено',not_applicable:'не потрібна'})[check.state])});}
  viewports.push({name:view.name,...(bounded(view.width)&&view.width<=4096?{width:view.width}:{}),...(bounded(view.height)&&view.height<=8192?{height:view.height}:{}),checks});
 }
 return {code,detail:safeDetail(live.detail||previous.detail||live.evidence,messages[code]),scope:'public-snapshot',viewports,network,...(linkSummary?{linkSummary}:{}),...(progress?{progress}:{}),limitations:[...limitations],screenshots:(Array.isArray(screenshots)?screenshots:[]).slice(0,2).filter(s=>s&&['desktop','mobile'].includes(s.name)&&typeof s.url==='string'&&/^\/api\/lifecycle\/pages\/[a-f0-9-]{36}\/screenshots\/pageposter-[a-f0-9-]{36}-(?:desktop|mobile)\.png$/.test(s.url)).map(s=>({name:s.name,url:s.url}))};
}
export function publishedDiagnosticMessage(value){
 let message=messages[value?.code]||messages.browser_check_failed;
 if(value?.code==='published_browser_problem'){
  const failed=(value.viewports||[]).flatMap(view=>(view.checks||[]).filter(check=>check.state==='problem'&&Object.hasOwn(checkLabels,check.kind)).map(check=>(view.name==='mobile'?'Телефон':'Комп’ютер')+': '+checkLabels[check.kind].toLowerCase())).slice(0,4);
  if(failed.length)message+=' '+failed.join('; ')+'.';
 }
 if(value?.progress&&Object.hasOwn(progressStages,value.progress.stage))message+=' Етап: '+progressStages[value.progress.stage].toLowerCase()+'.';
 return message;
}
export function failedPublishedDiagnostics(checks){const check=checks.find(c=>c.kind==='live_browser'&&['problem','unknown'].includes(c.state));return check?{state:check.state,...safePublishedEvidence(check.evidence||{})}:null;}
export function publishedCheckError(error,verification){return error?.code==='CHECK_FAILED'&&verification?.diagnostics?{code:'CHECK_FAILED',message:'Сторінку опубліковано. '+publishedDiagnosticMessage(verification.diagnostics)}:error||null;}
