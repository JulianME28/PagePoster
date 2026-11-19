(function(){
'use strict';
const $=id=>document.getElementById(id),api='/api/lifecycle',activeStates=new Set(['queued','running','publishing','checking']);
const state={stage:null,dialogStage:null,stageSerial:0,stageMobile:false,dialogMobile:false,autoPreviewRun:null,suppressAutoPreview:false,stageLoading:null,publishBusy:false,projects:[],selected:null,pages:[],runs:[],overview:new Map(),status:null,load:0,busy:false,html:'',replacement:null,replacementSerial:0,poll:null,refreshPending:false,restartRequired:false,pendingReadErrors:new Set(),sourceBusy:false,settingsSerial:0,selectionSession:null,checkJobs:new Set(),checkProjects:new Set(),drafts:new Map(),pending:new Map(),storageError:false,savedSelection:undefined,focusReturn:new Map(),mode:'ai',review:null,previewBusy:false,previewSerial:0,fileSerial:0};
const labels={paused:'Призупинено',awaiting_review:'Готова до перегляду',queued:'У черзі',running:'Створюємо сторінку',waiting_source:'Потрібна база сайтів',failed:'Не вдалося завершити',uncertain:'Потрібно перевірити результат',publishing:'Публікуємо',checking:'Перевіряємо сторінку',completed:'Готово',needs_attention:'Потрібна увага'};
state.fileBusy=false;
const steps=[['generating','Тексти й дизайн'],['selecting','Підбір сайту'],['installing','Плагін'],['publishing','Публікація'],['checking','Перевірка']];
const draftStorageKey='pageposter-autopilot-drafts:v1';
 const htmlLimit=500000,htmlLimitMessage='HTML має бути не більшим за 500 000 байт у UTF-8.';
const escapeText=value=>String(value??'');
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=escapeText(text);return node;}
function button(text,fn,cls='ap-button ap-secondary'){const node=el('button',cls,text);node.type='button';node.addEventListener('click',fn);return node;}
function append(parent,...children){children.filter(Boolean).forEach(child=>parent.appendChild(child));return parent;}
function clear(node){node.replaceChildren();}
function showMessage(text,bad=false,target=$('ap-notice')){target.textContent=text;target.classList.toggle('error',bad);target.hidden=!text;}
function errorText(error){const map={AI_OUTPUT_INVALID:'ШІ повернув сторінку в непридатному форматі. Сторінку не підготовлено; посилання й анкори збережено.',REVIEW_REQUIRED:'Сторінка змінилася. Відкрийте її актуальний перегляд перед публікацією.',HTML_REVIEW_REQUIRED:'HTML змінився або перегляд застарів. Перегляньте поточний варіант ще раз.',AI_AUTH_FAILED:'Ключ OpenAI не прийнято. Перевірте підключення.',AI_ACCESS_DENIED:'OpenAI відмовив у доступі (403). Перевірте права API-ключа й доступ проєкту до вибраної моделі. Після виправлення продовжте збережений запуск вручну.',AI_MODEL_UNAVAILABLE:'Вибрана модель OpenAI недоступна. Перевірте підключення й налаштування моделі.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Готові кроки збережено.',AI_RESULT_UNCERTAIN:'Запит міг виконатися. Спочатку потрібно перевірити його результат.',AI_BUDGET_EXCEEDED:'Досягнуто ліміту витрат OpenAI.',CONFLICT:'Сторінка змінилася. Оновіть дані й підготуйте заміну знову.',SOURCE_NOT_CONFIGURED:'Для підключення бази увійдіть у робочий акаунт Google або підключіть сервісний акаунт із доступом на читання.',not_configured:'Спочатку збережіть ключ OpenAI у налаштуваннях.',VALIDATION:'Перевірте заповнені поля.',PRECHECK_FAILED:'Перед заміною потрібна успішна свіжа перевірка сторінки.'};return ((error?.diagnostics||error?.issues?.length)&&error?.message)||map[error?.code]||error?.message||'Не вдалося отримати відповідь сервера. Спробуйте ще раз.';}
async function request(route,body,method){if(state.restartRequired)throw Error('Копію відновлено. Перезапустіть PagePoster перед продовженням роботи.');const response=await fetch(route.startsWith('/api/')?route:api+route,{method:method||(body===undefined?'GET':'POST'),credentials:'same-origin',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});let data;try{data=await response.json();}catch{throw Error('Сервер PagePoster недоступний. Відкрийте локальну версію програми.');}if(!response.ok){const err=Error(typeof data.error==='string'?data.error:data.message||'Не вдалося виконати запит.');err.code=data.code;err.diagnostics=data.diagnostics;err.status=response.status;throw err;}return data;}
function safeUrl(value){try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password&&!/\s/.test(value)?value:null;}catch{return null;}}
function link(text,url,cls='ap-exact-url'){const safe=safeUrl(url);if(!safe)return el('span',cls,text);const a=el('a',cls,text);a.href=safe;a.target='_blank';a.rel='noopener noreferrer';return a;}
function date(value){if(!value)return 'ще не перевіряли';const d=new Date(value);return Number.isNaN(d.valueOf())?'дата невідома':d.toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function key(){return crypto.randomUUID();}
function openDialog(id){const active=document.activeElement;state.focusReturn.set(id,active&&active!==document.body&&active!==document.querySelector('.ap-skip')?active:null);$(id).showModal();}
function closeDialog(id){if(id==='ap-replacement')invalidateReplacement();if(id==='ap-html-code')$('ap-ready-html').value='';$(id).close();}
function field(parent,label,name,value='',type='text'){const wrap=el('label','ap-field',label),input=el('input');input.name=name;input.type=type;input.value=value;wrap.appendChild(input);parent.appendChild(wrap);return input;}
function working(control,task){if(control.disabled||state.restartRequired)return;control.disabled=true;return Promise.resolve().then(task).catch(error=>{const dialog=control.closest('dialog');let note=dialog?.querySelector('.ap-operation-error');if(dialog?.open&&!note){note=el('div','ap-notice error ap-operation-error');note.setAttribute('role','alert');dialog.querySelector('.ap-dialog-heading').after(note);}showMessage(errorText(error),true,note||$('ap-notice'));}).finally(()=>{control.disabled=state.restartRequired;});}
function pendingKey(){return 'pageposter-autopilot-launch:'+state.selected+':'+state.mode;}
 function draftStatus(){
  const note=$('ap-draft-state');if(!note)return;
  note.textContent=state.storageError?'Чернетку не збережено в браузері: сховище недоступне або заповнене. Не оновлюйте вкладку.':'Чернетку збережено в цій вкладці до її закриття.';
  note.classList.toggle('error',state.storageError);
 }
 function portableDraft(project){
  const result={mode:project.mode==='html'?'html':'ai'},mode=value=>value==='overlay-only'?'overlay-only':'custom',value=input=>typeof input==='string'?input:'';
  if(project.ai&&Array.isArray(project.ai.links))result.ai={links:project.ai.links.filter(pair=>pair&&typeof pair==='object').map(pair=>({url:value(pair.url),anchor:value(pair.anchor)})),chromeMode:mode(project.ai.chromeMode),editorial:cleanEditorial(project.ai.editorial)};
  if(project.html&&typeof project.html==='object')result.html={source:'html',html:value(project.html.html),baseUrl:value(project.html.baseUrl),brand:value(project.html.brand),brandUrl:value(project.html.brandUrl),chromeMode:mode(project.html.chromeMode)};
  return result;
 }
 function readWorkspace(){
  try{
   const saved=JSON.parse(sessionStorage.getItem(draftStorageKey)||'null');
   if(saved&&Array.isArray(saved.drafts)){
    state.drafts=new Map(saved.drafts.filter(pair=>Array.isArray(pair)&&typeof pair[0]==='string'&&pair[1]&&typeof pair[1]==='object').map(([id,project])=>[id,portableDraft(project)]));
    if(saved.selected===null||typeof saved.selected==='string')state.savedSelection=saved.selected;
   }
  }catch{state.storageError=true;}
 }
 function persistWorkspace(){
  try{sessionStorage.setItem(draftStorageKey,JSON.stringify({selected:state.selected,drafts:[...state.drafts].map(([id,project])=>[id,portableDraft(project)])}));}
  catch{state.storageError=true;}
  draftStatus();
 }
 function getPending(){
  const id=pendingKey();if(state.pending.has(id))return state.pending.get(id);
  try{const raw=sessionStorage.getItem(id)||(state.mode==='ai'?sessionStorage.getItem('pageposter-autopilot-launch:'+state.selected):null),pending=JSON.parse(raw||'null');state.pendingReadErrors.delete(id);state.pending.set(id,pending);return pending;}
  catch{state.pendingReadErrors.add(id);state.storageError=true;draftStatus();return null;}
 }
 function savePending(value){
  state.pending.set(pendingKey(),value);
  try{if(value)sessionStorage.setItem(pendingKey(),JSON.stringify(value));else sessionStorage.removeItem(pendingKey());}
  catch{state.storageError=true;draftStatus();return false;}
  // The current key is durable even if cleanup of an old-format key fails.
  try{if(state.mode==='ai')sessionStorage.removeItem('pageposter-autopilot-launch:'+state.selected);}catch{state.storageError=true;draftStatus();}
  return true;
 }
const editorialFormats={article:'Пояснення теми, приклади та висновки.',guide:'Послідовні кроки: що робити, навіщо та на конкретному прикладі.',comparison:'Зіставлення підходів за спільними критеріями, таблиця й відмінності.',discussion:'Різні позиції, аргументи й висновок. Без вигаданих учасників.',blog_post:'Один цікавий ракурс, короткі розділи й головний висновок.',faq:'Спочатку прямі відповіді на запитання, потім докладні пояснення.'};
function cleanEditorial(value){return {format:Object.hasOwn(editorialFormats,value?.format)?value.format:'article',topic:['casino','sports_betting','gambling','slots','poker','live_casino','custom'].includes(value?.topic)?value.topic:'casino',customTopic:typeof value?.customTopic==='string'?value.customTopic.slice(0,500):'',language:['en','es','pl','de','fr'].includes(value?.language)?value.language:'en'};}
function editorialValues(){return {language:$('ap-editorial-language').value,format:$('ap-editorial-format').value,topic:$('ap-editorial-topic').value,customTopic:$('ap-editorial-topic').value==='custom'?$('ap-editorial-custom').value.trim():''};}
function updateEditorial(){const custom=$('ap-editorial-topic').value==='custom';$('ap-custom-topic-wrap').hidden=!custom;$('ap-editorial-custom').disabled=!custom;$('ap-editorial-custom').required=custom;$('ap-format-help').textContent=editorialFormats[$('ap-editorial-format').value];}
function restoreEditorial(value){const data=cleanEditorial(value);$('ap-editorial-format').value=data.format;$('ap-editorial-language').value=data.language;$('ap-editorial-topic').value=data.topic;$('ap-editorial-custom').value=data.customTopic;updateEditorial();}
function chromeMode(){return document.querySelector('[name=chromeMode]:checked')?.value||'custom';}
function htmlValues(){const form=$('ap-launch-form');return {source:'html',html:form.elements.customerHtml.value,baseUrl:form.elements.htmlBaseUrl.value.trim(),brand:form.elements.htmlBrand.value,brandUrl:form.elements.htmlBrandUrl.value.trim(),chromeMode:chromeMode()};}
function htmlError(data=htmlValues()){if(!data.html.trim())return 'Вставте HTML або виберіть файл.';if(new TextEncoder().encode(data.html).byteLength>htmlLimit)return htmlLimitMessage;if(data.baseUrl&&!safeUrl(data.baseUrl))return 'Укажіть повну адресу вихідної сторінки з http або https.';if(data.brandUrl&&!safeUrl(data.brandUrl))return 'Укажіть повне посилання бренду з http або https.';return '';}
function currentReview(){return state.review?.fingerprint===JSON.stringify(htmlValues())?state.review:null;}
function saveDraft(){if(!state.selected)return;const project=state.drafts.get(state.selected)||{};project.mode=state.mode;project[state.mode]=state.mode==='ai'?{links:Array.from($('ap-link-rows').children).map(row=>({url:row.querySelector('[name=linkUrl]').value,anchor:row.querySelector('[name=linkAnchor]').value})),chromeMode:chromeMode(),editorial:editorialValues()}:{...htmlValues(),review:state.review};state.drafts.set(state.selected,project);persistWorkspace();}
function restoreDraft(){
 const project=state.drafts.get(state.selected)||{},draft=project[state.mode]||{},pending=getPending(),form=$('ap-launch-form');state.review=null;state.previewSerial++;state.fileSerial++;state.previewBusy=false;state.fileBusy=false;
 document.querySelectorAll('[name=contentSource]').forEach(input=>input.checked=input.value===state.mode);
 const data=pending||draft,mode=data.chromeMode||'custom';document.querySelectorAll('[name=chromeMode]').forEach(input=>input.checked=input.value===mode);
 if(state.mode==='ai'){restoreEditorial(data.editorial);clear($('ap-link-rows'));(data.links?.length?data.links:[{url:'',anchor:''}]).forEach(pair=>addLink(pair.url,pair.anchor));}
 else{form.elements.customerHtml.value=data.html||'';form.elements.htmlBaseUrl.value=data.baseUrl||'';form.elements.htmlBrand.value=data.brand||'';form.elements.htmlBrandUrl.value=data.brandUrl||'';$('ap-html-file').value='';state.review=pending?null:draft.review||null;if(!currentReview()&&pending?.reviewToken){const saved={source:'html',html:pending.html,baseUrl:pending.baseUrl||'',brand:pending.brand||'',brandUrl:pending.brandUrl||'',chromeMode:pending.chromeMode||'custom'};if(JSON.stringify(saved)===JSON.stringify(htmlValues()))state.review={fingerprint:JSON.stringify(saved),token:pending.reviewToken,warnings:[],accepted:true,viewed:true};}}
 $('ap-ai-inputs').hidden=state.mode!=='ai';$('ap-html-inputs').hidden=state.mode!=='html';$('ap-add-link').hidden=state.mode!=='ai';$('ap-html-preview').hidden=true;
 $('ap-launch').textContent='Підготувати й переглянути';$('ap-first-step').textContent='1. Матеріал';
 $('ap-compose-description').textContent=state.mode==='html'?'Вставте HTML. Ми підготуємо його для WordPress і покажемо результат праворуч.':'Виберіть тему й формат, додайте посилання. Спочатку перевірте текст та оформлення в перегляді.';
 showMessage('',false,$('ap-html-note'));renderHtmlReview();updateStatus();
 if(pending)showMessage('Попередній запит очікує підтвердження сервера. Повторне надсилання продовжить той самий запуск.');
}
function switchMode(mode){const fixed=state.projects.find(project=>project.id===state.selected)?.workflowType;if(state.busy||(fixed&&fixed!==mode))return;saveDraft();clearStage();state.suppressAutoPreview=true;state.mode=mode;showMessage('');restoreDraft();saveDraft();}
function renderHtmlReview(){const root=$('ap-html-review');clear(root);const review=currentReview();root.hidden=state.mode!=='html'||!review;if(root.hidden)return;
 root.appendChild(el('p','',review.warnings.length?'Під час підготовки HTML виявлено зміни:':'Перегляд готовий. Перевірте оформлення перед публікацією.'));
 if(review.warnings.length){const list=el('ul');review.warnings.forEach(warning=>list.appendChild(el('li','',warning)));root.appendChild(list);const label=el('label','ap-check-label'),check=el('input');check.type='checkbox';check.name='acceptHtmlChanges';check.checked=!!review.accepted;check.addEventListener('change',()=>{review.accepted=check.checked;saveDraft();updateStatus();});append(label,check,el('span','','Я переглянув зміни й дозволяю публікацію цього HTML'));root.appendChild(label);}
}
function htmlChanged(invalidateFile=true){if(invalidateFile){state.fileSerial++;state.fileBusy=false;$('ap-html-file').value='';}clearStage('Матеріал змінився','Підготуйте новий перегляд, щоб побачити актуальний HTML.');state.suppressAutoPreview=true;state.review=null;state.previewSerial++;state.previewBusy=false;renderHtmlReview();showMessage('',false,$('ap-html-note'));saveDraft();updateStatus();}
function updateStatus(){
 state.busy=state.busy||state.restartRequired;
 const connected=state.status?.source?.configured,ai=state.status?.aiConfigured,isHtml=state.mode==='html',review=isHtml?currentReview():null,invalid=isHtml?htmlError():'';
 $('ap-connection-dot').classList.toggle('ready',!!connected&&(!!ai||isHtml));
 const sourcePrompt=state.status?.source?.spreadsheetId?'Підключіть акаунт Google':'Потрібна база сайтів';
 $('ap-connection-copy').textContent=isHtml?(connected?'Базу сайтів підключено':sourcePrompt):ai?(connected?'Усе підключено':sourcePrompt):'Підключіть OpenAI';
 $('ap-runtime').textContent=window.pageposterDesktop?'PagePoster Desktop':'Локальний сервер';
 const fixed=state.projects.find(project=>project.id===state.selected)?.workflowType;document.querySelector('.ap-source-choice').hidden=!!fixed;
 $('ap-ai-inputs').disabled=state.busy||isHtml;$('ap-html-inputs').disabled=state.busy||!isHtml;document.querySelectorAll('[name=contentSource],[name=chromeMode]').forEach(input=>input.disabled=state.busy||(input.name==='contentSource'&&!!fixed));
 $('ap-launch').disabled=state.busy||state.fileBusy||state.previewBusy||state.publishBusy||!!getPending()||(isHtml?!!invalid:!ai);
 $('ap-html-preview').disabled=state.busy||state.fileBusy||state.previewBusy||!!invalid;updateStageActions();
 const retry=$('ap-retry-launch');if(retry){retry.hidden=!state.selected||!getPending();retry.disabled=state.busy;}
 $('ap-html-size').textContent=new TextEncoder().encode($('ap-launch-form').elements.customerHtml.value).byteLength.toLocaleString('uk-UA')+' / 500 000 байт';
 $('ap-launch-note').textContent=isHtml?(state.fileBusy?'Читаємо HTML і включаємо зображення та шрифти…':invalid||(state.previewBusy?'Готуємо попередній перегляд…':'Підготовка безкоштовна й не запускає публікацію.')):!ai?'Для ШІ потрібен ключ OpenAI. Готовий HTML можна переглянути без ключа.':'Створення використовує OpenAI. Публікація — після перегляду й вашого натискання.';
 $('ap-ai-state').textContent=ai?'Модель: '+(state.status?.aiModel||'із налаштувань')+'. Ключ збережено; доступ і баланс перевіряються окремо.':'Для текстів, структури й оформлення сторінок.';
 renderSetup();
 $('ap-source-state').textContent=connected?'Налаштування таблиці збережено. Перевірте доступ і підбір перед публікацією.':state.status?.source?.spreadsheetId?'Параметри таблиці збережено. Підключіть вибраний акаунт Google.':'Сайти підбираються з вашої таблиці автоматично.';
}
async function refreshStatus(){state.status=await request('/autopilot/status');updateStatus();}
window.addEventListener('pageposter:google-account-changed',()=>{if(!state.restartRequired)refreshStatus().catch(()=>{});});
function renderProjects(){
 clear($('ap-project-list'));$('ap-all').setAttribute('aria-current',state.selected===null?'page':'false');
 for(const project of state.projects.filter(p=>!p.archived)){const control=button('',()=>selectProject(project.id),'ap-project-button');control.setAttribute('aria-current',project.id===state.selected?'page':'false');control.setAttribute('aria-label',project.name);append(control,el('span','ap-project-symbol',project.name.slice(0,2).toUpperCase()),el('span','ap-project-name',project.name));$('ap-project-list').appendChild(control);}
 const mobileNew=button('+ Створити проєкт',()=>openDialog('ap-project-dialog'),'ap-project-button ap-mobile-new');mobileNew.style.display='none';$('ap-project-list').appendChild(mobileNew);
}
let managedProjectAction=null;
const projectActions={close:{title:'Закрити проєкт?',label:'Закрити проєкт',details:'Проєкт зникне з основного списку, а його завдання стануть на паузу. Сторінки та історія збережуться. Повернути його можна у розділі «Закриті».',success:'Проєкт закрито. Його можна повернути у розділі «Закриті».'},trash:{title:'Перемістити проєкт у кошик?',label:'До кошика',details:'Проєкт та його завдання буде прибрано з робочого простору. Його можна відновити з кошика. Публікації на сайтах залишаться на місці.',success:'Проєкт переміщено в кошик.'},reopen:{title:'Відкрити проєкт?',label:'Відкрити проєкт',details:'Проєкт повернеться до активних. Завдання залишаться на паузі до вашого ручного продовження у «Чергах проєктів».',success:'Проєкт відкрито. Продовжити завдання можна у «Чергах проєктів».'},restore:{title:'Відновити проєкт?',label:'Відновити проєкт',details:'Проєкт повернеться до активних зі сторінками та історією. Завдання залишаться на паузі до ручного продовження.',success:'Проєкт відновлено. Завдання залишаються на паузі.'}};
function renderManagedProjects(){
 const scope=$('ap-project-scope').value,list=$('ap-managed-projects');clear(list);
 const projects=state.projects.filter(project=>scope==='trash'?project.trashed:scope==='closed'?project.archived&&!project.trashed:!project.archived);
 if(!projects.length){list.appendChild(el('p','ap-muted ap-managed-empty',scope==='trash'?'Кошик порожній.':scope==='closed'?'Закритих проєктів немає.':'Активних проєктів немає.'));return;}
 for(const project of projects){
  const row=el('div','ap-managed-project');row.dataset.projectId=project.id;
  const copy=el('div','ap-managed-copy');append(copy,el('strong','',project.name),el('p','ap-fine',(project.workflowType==='ai'?'Генерація сторінок':project.workflowType==='html'?'Готові HTML':'Проєкт')+' · '+(project.trashed?'У кошику':project.archived?'Закритий':'Активний')));
  const actions=el('div','ap-managed-actions'),choices=project.trashed?[['restore','Відновити']]:project.archived?[['reopen','Відкрити'],['trash','До кошика']]:[['close','Закрити'],['trash','До кошика']];
  for(const [action,label] of choices){const control=button(label,()=>openProjectAction(project,action),'ap-button ap-secondary'+(action==='trash'?' ap-project-trash':''));control.dataset.projectAction=action;actions.appendChild(control);}
  append(row,copy,actions);list.appendChild(row);
 }
}
async function openProjectManager(){
 if(state.busy||state.publishBusy||state.previewBusy)return showMessage('Зачекайте завершення поточного запиту.',true);
 try{const result=await request('/projects');state.projects=result.projects||[];renderProjects();$('ap-project-scope').value='active';showMessage('',false,$('ap-project-manager-note'));renderManagedProjects();openDialog('ap-project-manager');}
 catch(error){showMessage(errorText(error),true);}
}
function openProjectAction(project,action){
 managedProjectAction={project,action};const copy=projectActions[action];
 $('ap-project-action-title').textContent=copy.title;$('ap-project-action-name').textContent=project.name;$('ap-project-action-details').textContent=copy.details;$('ap-project-action-confirm').textContent=copy.label;
 $('ap-project-action').querySelector('.ap-operation-error')?.remove();openDialog('ap-project-action');
}
async function confirmProjectAction(){
 const selection=managedProjectAction;if(!selection)return;
 await working($('ap-project-action-confirm'),async()=>{
  const {project,action}=selection,result=await request('/projects/'+project.id+'/lifecycle',{action,expectedRevision:project.revision});
  if(!result.project?.id)throw Error('Сервер не підтвердив зміну проєкту. Оновіть список.');
  state.projects=state.projects.map(item=>item.id===result.project.id?result.project:item);closeDialog('ap-project-action');managedProjectAction=null;
  if(action==='restore'||action==='reopen')$('ap-project-scope').value='active';
  renderProjects();renderManagedProjects();
  if(state.selected===project.id&&result.project.archived)await selectProject(null);else{renderHeading();await loadResults();}
  showMessage(projectActions[action].success,false,$('ap-project-manager-note'));window.dispatchEvent(new CustomEvent('pageposter:projects-changed'));
 });
}
function renderHeading(){
 const project=state.projects.find(p=>p.id===state.selected);
 $('ap-title').textContent=project?project.name:state.projects.some(p=>!p.archived)?'Усі сторінки':'Почніть із проєкту';
 $('ap-subtitle').textContent=project?'Підготуйте сторінку, перевірте її на комп’ютері — потім публікуйте.':state.projects.length?'Опубліковані сторінки й результати перевірок усіх проєктів.':'Дайте проєкту назву. Далі знадобляться посилання й анкори.';
 $('ap-composer').hidden=!project;$('ap-studio').hidden=!project;$('ap-check-pages').hidden=!state.projects.length;renderSiteSelection(project);
}
function addLink(url='',anchor=''){
 const row=el('div','ap-link-row'),number=el('span','ap-link-number');
 append(row,number);const u=field(row,'Посилання','linkUrl',url,'url');u.placeholder='https://…';u.required=true;u.autocomplete='off';u.spellcheck=false;u.maxLength=10000;
 const a=field(row,'Анкор','linkAnchor',anchor);a.placeholder='Текст вашого посилання';a.required=true;a.maxLength=500;
 const remove=button('×',()=>{if($('ap-link-rows').children.length===1){u.value='';a.value='';u.focus();}else row.remove();renumber();editableChanged();},'ap-icon');remove.setAttribute('aria-label','Видалити посилання');row.appendChild(remove);u.addEventListener('input',editableChanged);a.addEventListener('input',editableChanged);$('ap-link-rows').appendChild(row);renumber();
}
function renumber(){Array.from($('ap-link-rows').children).forEach((row,i)=>{row.querySelector('.ap-link-number').textContent=String(i+1).padStart(2,'0');});}
async function selectProject(id,{composer=false}={}){
 if($('ap-destination')?.open)closeDialog('ap-destination');
 if(state.busy)return showMessage('Дочекайтеся підтвердження запуску сервером.');saveDraft();
 clearStage();state.autoPreviewRun=null;state.suppressAutoPreview=false;state.selected=id;state.mode=state.projects.find(project=>project.id===id)?.workflowType||state.drafts.get(id)?.mode||'ai';state.load++;renderProjects();renderHeading();showMessage('');restoreDraft();persistWorkspace();
 if(composer){state.suppressAutoPreview=true;document.body.dataset.workspaceView='compose';clearStage();$('ap-stage-title').textContent='Нова сторінка';$('ap-stage-caption').textContent='Підготуйте матеріал у формі. Це нова сторінка, окрема від збережених у списку.';}
 window.dispatchEvent(new CustomEvent('pageposter:project-selected',{detail:{projectId:id,composer}}));
 state.pages=[];state.runs=[];state.overview=new Map();$('ap-search').value='';$('ap-filter').value='all';renderOverview();clear($('ap-results'));$('ap-results').setAttribute('aria-busy','true');$('ap-results').appendChild(el('p','ap-results-loading','Завантажуємо сторінки й запуски…'));
 const selectionLoad=state.load+1;await loadResults().catch(error=>{if(state.load===selectionLoad&&state.selected===id)renderResultsError(error);});
}
 function trackJobs(jobs,projectId=state.selected){
  for(const job of jobs||[])if(job?.id&&['queued','running'].includes(job.state)){
   state.checkJobs.add(job.id);if(job.projectId||projectId)state.checkProjects.add(job.projectId||projectId);
  }
 }
 let resultsRefresh=null,resultsRefreshAgain=false;
 function loadResults(){if(resultsRefresh){resultsRefreshAgain=true;return resultsRefresh;}resultsRefresh=(async()=>{let error;do{resultsRefreshAgain=false;try{await readResults();error=null;}catch(failure){error=failure;}}while(resultsRefreshAgain);if(error)throw error;})().finally(()=>{resultsRefresh=null;});return resultsRefresh;}
 async function readResults(){
  if(state.restartRequired)return;
  const stamp=++state.load,selected=state.selected,projects=selected?state.projects.filter(p=>p.id===selected):state.projects.filter(p=>!p.archived);
  const projectIds=new Set([...projects.map(project=>project.id),...state.checkProjects]);state.refreshPending=true;
  try{
   // Discover active work after reload. Read jobs before snapshots so a completed
   // check is not forgotten until its final page state has been read successfully.
   const jobs=await Promise.all([...projectIds].map(async id=>({projectId:id,...await request('/projects/'+id+'/jobs')})));
   if(stamp!==state.load||state.restartRequired)return;
   for(const result of jobs)trackJobs(result.jobs,result.projectId);
   const activeJobs=new Set(jobs.flatMap(result=>(result.jobs||[]).filter(job=>['queued','running'].includes(job.state)).map(job=>job.id)));
   const activeProjects=new Set(jobs.filter(result=>(result.jobs||[]).some(job=>['queued','running'].includes(job.state))).map(result=>result.projectId));
   const results=await Promise.all([...projectIds].map(async id=>{const project=state.projects.find(project=>project.id===id)||{id,name:''};const [pages,runs,overview]=await Promise.all([request('/projects/'+id+'/pages?summary=1'),request('/projects/'+id+'/autopilot'),request('/projects/'+id+'/overview')]);return {project,pages:pages.pages||[],runs:runs.runs||[],overview:overview.pages||[]};}));
   if(stamp!==state.load||state.restartRequired)return;
   const visible=results.filter(result=>projects.some(project=>project.id===result.project.id));
   state.checkJobs=activeJobs;state.checkProjects=activeProjects;state.refreshPending=false;state.pages=visible.flatMap(r=>r.pages.map(p=>({...p,projectName:r.project.name})));state.runs=visible.flatMap(r=>r.runs.map(p=>({...p,projectName:r.project.name})));state.overview=new Map(visible.flatMap(r=>r.overview.map(p=>[p.pageId,p])));renderResults();syncPreparedPreview();scheduleRefresh();
  }catch(error){if(stamp===state.load)scheduleRefresh();throw error;}
 }
function runWorking(run){return activeStates.has(run.state)||publicationStatus(run.publication)?.working===true;}
function scheduleRefresh(){clearTimeout(state.poll);if(!state.restartRequired&&(state.refreshPending||state.checkJobs.size||state.runs.some(runWorking)))state.poll=setTimeout(()=>{loadResults().catch(()=>{showMessage('Не вдалося оновити стан. Запуск збережено; відновлюємо зв’язок.',true);scheduleRefresh();});},3000);}
function section(title,count){const section=el('section','ap-result-block'),heading=el('div','ap-section-heading'),h=el('h2','',title);h.appendChild(el('span','ap-count',count));append(heading,h);section.appendChild(heading);return section;}
function badge(text,type){return el('span','ap-badge '+(type||''),text);}
function publicationStatus(publication,verification){
 if(!publication)return null;
 const recovery=publication.recovery;
 if(['reading','waiting','retrying'].includes(recovery?.state))return {label:recovery.state==='waiting'?'Повторюємо безпечне читання':'Звіряємо створену сторінку',type:'',working:true};
 const published=publication.checkpoint==='published'||publication.lastEvidence?.observation==='published';
 if(verification?.diagnostics?.linkSummary?.outsideUrls>0&&(['published','published_checking'].includes(publication.state)||published))return {label:'Опубліковано · потрібна перевірка',type:'warning',working:publication.state==='published_checking'};
 const lastStep=publication.diagnostics?.at(-1);
 const blockedLabel=recovery?.state==='exhausted'&&recovery.attempt>=recovery.limit?'Потрібна дія · відновлення вичерпано':lastStep?.phase==='login'&&lastStep.code!=='OK'?'Вхід у WordPress не підтверджено':'Потрібна дія';
 const states={not_sent:['Ще не відправлено',''],draft:['Чернетка збережена','warning'],reconciling:['Звіряємо створену сторінку',''],published_checking:['Опубліковано · перевіряємо',''],published:['Опубліковано','good'],crawl_blocked:['Опубліковано · Googlebot заблоковано','warning'],verification_unknown:[published?'Опубліковано · перевірка невизначена':'Результат відправлення невідомий','warning'],manual_action:['Чекаємо ручної дії / CAPTCHA','warning'],cleanup_pending:['Підтверджуємо кошик','warning'],trashed:['Кошик підтверджено','warning'],blocked:[blockedLabel,'error']};
 const value=states[publication.state];return value?{label:value[0],type:value[1],working:['reconciling','published_checking'].includes(publication.state)}:null;
}
function publicationCanContinue(publication){return !publication||['not_sent','draft','manual_action','blocked','trashed'].includes(publication.state)&&!publicationStatus(publication)?.working;}
function capabilityHistoryTable(history){
 if(!Array.isArray(history?.rows)||!history.rows.length)return null;
 const wrapper=el('div','ap-capability-history'),table=el('table'),head=el('thead'),heading=el('tr'),body=el('tbody');
 for(const label of ['Акаунт','Вхід','Плагін','Редактор','HTML'])heading.appendChild(el('th','',label));head.appendChild(heading);table.appendChild(head);
 const validDate=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
 const values={login:{true:'Підтверджено',false:'Відхилено'},pluginAccess:{true:'Встановлення підтверджено',false:'Встановлення недоступне'},plugin:{active:'Активний',unavailable:'Недоступний'},editor:{classic:'Classic',block:'Gutenberg',available:'Підтверджено',unavailable:'Не підтверджено'},markup:{true:'Збережено',false:'Відрізняється'}};
 for(const row of history.rows.slice(0,8)){
  if(!row||![0,1].includes(row.accountIndex))continue;const tr=el('tr');
  tr.appendChild(el('th','',(row.accountIndex?'Запасний':'Основний')+(row.active?' · поточний':'')+(row.stale?' · застарілі спостереження':!row.observedInThisRun?' · історія':'')));
  for(const names of [['login'],['pluginAccess','plugin'],['editor'],['markup']]){
   const cell=el('td');let known=false;
   for(const name of names){const fact=row.facts?.[name],valid=['login','pluginAccess','markup'].includes(name)?typeof fact?.value==='boolean':typeof fact?.value==='string';if(!valid||!Object.hasOwn(values[name],String(fact.value))||!validDate(fact.at))continue;known=true;cell.appendChild(el('div','',values[name][String(fact.value)]));cell.appendChild(el('small','ap-fine',(fact.stale?'Історія (застаріле)':fact.observedInThisRun?'Цей запуск':'Історія')+' · '+date(fact.at)));}
   if(!known)cell.appendChild(el('span','ap-muted','Не перевірено'));tr.appendChild(cell);
  }body.appendChild(tr);
 }
 table.appendChild(body);wrapper.appendChild(el('p','ap-fine','Історія спостережень. Попередні успіхи не гарантують поточні права; збереження HTML підтверджується лише після запису й звірки.'));wrapper.appendChild(table);
 if(history.truncated)wrapper.appendChild(el('p','ap-fine','Показано останні доступи; давніші записи скорочено.'));return wrapper;
}
function publicationDiagnostics(publication){
 const diagnostics=Array.isArray(publication?.diagnostics)?publication.diagnostics.slice(-12):[];if(!diagnostics.length&&!publication?.recovery&&!publication?.capabilities)return null;
 const box=el('details','ap-publication-diagnostics');box.dataset.publicationDiagnostics='';box.appendChild(el('summary','','Діагностика публікації'));const list=el('ul');
 const token=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)?value:null,num=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 for(const entry of diagnostics){if(!entry||typeof entry!=='object')continue;const parts=[];for(const key of ['phase','code','checkpoint','requestClass'])if(token(entry[key]))parts.push(entry[key]);if(['GET','HEAD','POST'].includes(entry.method))parts.push(entry.method);if(Number.isInteger(entry.httpStatus)&&entry.httpStatus>=100&&entry.httpStatus<=599)parts.push('HTTP '+entry.httpStatus);for(const [key,label] of [['elapsedMs',entry.timingScope==='worker_operation'?'Виконання завдання':'Час'],['budgetMs','Бюджет'],['networkMs','Мережа (сума запитів)'],['queueMs','Черга запитів браузера'],['workerQueueWaitMs','Черга завдання (з повторами)'],['jobLifetimeMs','Від створення завдання'],['manualWaitMs','Ручне очікування до продовження (календарний час)']])if(num(entry[key])!==null)parts.push(label+': '+Math.min(entry[key],31536000000)+' мс');if(num(entry.safeReadRetries)!==null)parts.push('Повтори читання: '+Math.min(entry.safeReadRetries,3));if(parts.length)list.appendChild(el('li','',parts.join(' · ')));}
 box.appendChild(list);if(diagnostics.length)box.appendChild(el('p','ap-fine','Відсутні значення не виміряно. Мережеві запити можуть перекриватися; календарне очікування включає паузи й час із закритою програмою.'));const recovery=publication.recovery;if(recovery&&num(recovery.attempt)!==null&&num(recovery.limit)!==null)box.appendChild(el('p','ap-fine','Відновлення: '+Math.min(recovery.attempt,3)+' / '+Math.min(recovery.limit,3)+(recovery.retryAt?' · наступне читання: '+date(recovery.retryAt):'')));
 const caps=publication.capabilities;if(caps){const facts=[];if([0,1].includes(caps.accountIndex))facts.push('Акаунт '+(caps.accountIndex+1));if(typeof caps.login==='boolean')facts.push('Вхід: '+(caps.login?'підтверджено':'не підтверджено'));if(['active','unavailable'].includes(caps.plugin))facts.push('Плагін: '+(caps.plugin==='active'?'активний':'недоступний'));if(['classic','block','available'].includes(caps.editor))facts.push('Редактор: '+caps.editor);if(typeof caps.markup==='boolean')facts.push('HTML: '+(caps.markup?'підтверджено':'не підтверджено'));box.appendChild(el('p','ap-fine',facts.join(' · ')||'Можливості акаунта ще не підтверджено.'));const history=capabilityHistoryTable(caps.history);if(history)box.appendChild(history);}return box;
}
window.PagePosterPublication=Object.freeze({status:publicationStatus,canContinue:publicationCanContinue,diagnostics:publicationDiagnostics});
function linkReportControl(pageId){
 const box=el('details','ap-link-report-action');box.appendChild(el('summary','','Звіти'));const control=button('Звіт посилань',()=>openLinkReport(pageId));control.dataset.action='link-report';box.appendChild(control);return box;
}
function safeLocalReportHref(value){
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f\\]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))return null;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?value:null;}catch{return null;}
}
function initLinkReport(){
 const dialog=el('dialog','ap-dialog ap-link-report');dialog.id='ap-link-report';dialog.setAttribute('aria-labelledby','ap-link-report-title');const heading=el('div','ap-dialog-heading'),title=el('h2','','Локальний звіт посилань');title.id='ap-link-report-title';const close=button('Закрити',()=>dialog.close());close.id='ap-link-report-close';append(heading,title,close);const body=el('div');body.id='ap-link-report-body';body.setAttribute('aria-live','polite');append(dialog,heading,body);document.body.appendChild(dialog);
 dialog.addEventListener('close',()=>{if(dialog.open)return;const session=state.linkReport;state.linkReport=null;clear(body);if(session?.focus&&!session.focus.isConnected){const row=[...document.querySelectorAll('[data-queue-item],[data-run-id]')].find(row=>session.queueItem&&row.dataset.queueItem===session.queueItem||session.runId&&row.dataset.runId===session.runId);state.focusReturn.set(dialog.id,row?.querySelector('[data-action=link-report]'));}});
 window.addEventListener('pageposter:link-report',event=>openLinkReport(event.detail?.pageId));
 window.addEventListener('pageposter:recovery-restored',()=>{state.linkReport=null;clear(body);if(dialog.open)dialog.close();});
 window.addEventListener('pageposter:queue-updated',()=>{if(state.linkReport){state.linkReport=null;dialog.setAttribute('aria-busy','false');clear(body);body.appendChild(el('p','','Дані сторінки могли змінитися. Закрийте та відкрийте звіт знову.'));}});
}
async function openLinkReport(pageId){
 if(state.restartRequired||typeof pageId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(pageId))return;
 const dialog=$('ap-link-report'),body=$('ap-link-report-body');if(dialog.open&&state.linkReport?.pageId===pageId)return;
 const focus=document.activeElement,session={pageId,focus,queueItem:focus?.closest('[data-queue-item]')?.dataset.queueItem,runId:focus?.closest('[data-run-id]')?.dataset.runId};state.linkReport=session;
 if(!dialog.open)openDialog(dialog.id);dialog.setAttribute('aria-busy','true');clear(body);body.appendChild(el('p','','Читаємо збережений локальний звіт…'));
 const current=()=>state.linkReport===session&&dialog.open&&!state.restartRequired;
 try{
  const first=await request('/pages/'+encodeURIComponent(pageId));if(!current())return;const revision=first.page?.revision;if(first.page?.id!==pageId||!Number.isSafeInteger(revision))throw Error('Не вдалося підтвердити версію сторінки.');
  const result=await request('/pages/'+encodeURIComponent(pageId)+'/link-report?expectedRevision='+revision);if(!current())return;const report=result.report;
  if(report?.pageId!==pageId||report.pageRevision!==revision)throw Error('Версія сторінки змінилася. Закрийте та відкрийте звіт знову.');
  const latest=await request('/pages/'+encodeURIComponent(pageId));if(!current())return;if(latest.page?.revision!==revision)throw Error('Версія сторінки змінилася. Закрийте та відкрийте звіт знову.');
  clear(body);append(body,el('p','','Джерело: збережений знімок публічної перевірки. Час: '+(report.capturedAt?date(report.capturedAt):'немає')+'. Версія: '+revision+'.'),el('p','ap-fine','Це попередній знімок, а не поточний стан сайту. Читання звіту не запускає перевірку та не відкриває адреси.'));
  if(report.state!=='available'){body.appendChild(el('p','','Звіт недоступний для цієї версії. Потрібна окрема перевірка стану сторінки, щоб зберегти публічний знімок.'));return;}
  append(body,el('p','','Результат перевірки: '+({ok:'Перевірено',problem:'Є проблеми',unknown:'Невідомо'}[report.verificationState]||'Невідомо')+'. Посилання: '+(report.linksState==='problem'?'є розбіжності':report.linksState==='ok'?'групи збігаються':'не підтверджено')+'.'),el('p','','Показано '+Math.min(report.rows?.length||0,200)+' із '+(Number.isSafeInteger(report.totalRows)?report.totalRows:'?')+' груп.'));
  if(report.truncated)body.appendChild(el('p','ap-notice','Звіт неповний: досягнуто обмеження рядків або розміру.'));if(report.wrapperMismatch)body.appendChild(el('p','ap-notice','Обгортка сторінки відсутня або дублюється; розташування посилань не підтверджено.'));
  const table=el('table'),head=el('thead'),header=el('tr');for(const label of ['Точна адреса','Група','Стан','Нативні href: є / очікується','Повторні кнопки: є / очікується'])header.appendChild(el('th','',label));head.appendChild(header);table.appendChild(head);const rows=el('tbody');
  for(const row of (Array.isArray(report.rows)?report.rows:[]).slice(0,200)){const tr=el('tr'),address=el('td'),literal=typeof row.url==='string'?row.url.slice(0,8192):'',href=!row.truncated&&safeLocalReportHref(literal);if(href){const a=el('a','',literal);a.setAttribute('href',href);a.target='_blank';a.rel='noopener noreferrer';address.appendChild(a);}else address.textContent=literal;const count=value=>Number.isSafeInteger(value)&&value>=0?value:'?';append(tr,address,el('td','',row.scope==='outside'?'Поза вмістом · тема':'Вміст замовника'),el('td','',({expected:'Очікується · збігається',missing:'Відсутня',mismatch:'Кількість відрізняється',unexpected:'Неочікувана',invalid:'Небезпечна або некоректна'}[row.status]||'Невідомо')+(row.truncated?' · скорочено':'')),el('td','',count(row.nativeHrefs)+' / '+count(row.expectedNativeHrefs)),el('td','',count(row.repeatedControls)+' / '+count(row.expectedRepeatedControls)));rows.appendChild(tr);}table.appendChild(rows);const wrap=el('div','ap-link-report-table');wrap.appendChild(table);body.appendChild(wrap);
 }catch(error){if(current()){clear(body);body.appendChild(el('p','ap-notice error',errorText(error)));}}finally{if(current())dialog.setAttribute('aria-busy','false');}
}
function statusBadge(run){const publication=publicationStatus(run.publication,run.verification);if(publication)return badge(publication.label,publication.type);const type=run.state==='completed'?'good':['failed','uncertain'].includes(run.state)?'error':['awaiting_review','waiting_source','needs_attention'].includes(run.state)?'warning':'';return badge(labels[run.state]||'Обробляємо',type);}
let reconciliationTail=Promise.resolve();
function currentReconciliation(session){return state.reconciliation===session&&$('ap-reconciliation').open&&!state.restartRequired;}
function reconciliationControls(session){if(!currentReconciliation(session))return;const ready=!session.busy&&!session.invalid&&session.publication?.canReconcile===true&&Number.isSafeInteger(session.revision);$('ap-reconciliation-check').disabled=!ready;$('ap-reconciliation-refresh').disabled=!!session.busy;$('ap-reconciliation').setAttribute('aria-busy',String(!!session.busy));}
function renderReconciliation(session){
 if(!currentReconciliation(session))return;const p=session.publication,root=$('ap-reconciliation-identity');clear(root);root.appendChild(el('p','',publicationStatus(p)?.label||'Стан ще не підтверджено'));
 root.appendChild(el('p','','WP ID: '+(Number.isSafeInteger(p?.postId)&&p.postId>0?p.postId:'невідомий')));root.appendChild(p?.url?link(p.url,p.url):el('p','','Точний URL ще не збережено.'));root.appendChild(el('p','','Checkpoint: '+(typeof p?.checkpoint==='string'?p.checkpoint:'невідомий')));if(p?.cleanupPhase)root.appendChild(el('p','','Кошик: '+p.cleanupPhase));
 const proof={published:'Опубліковано',draft:'Чернетка',trashed:'Кошик підтверджено',unknown:'Результат не підтверджено',missing_identity:'Немає відомого WP ID'},evidence=p?.lastEvidence;root.appendChild(el('p','','Підтверджено: '+(proof[evidence?.observation]||'доказів ще немає')+(evidence?.at?' · '+date(evidence.at):'')));const diagnostics=publicationDiagnostics(p);if(diagnostics)root.appendChild(diagnostics);reconciliationControls(session);
}
function reconcileRequest(session,check=false){
 if(!currentReconciliation(session)||session.busy||check&&(session.invalid||session.publication?.canReconcile!==true||!Number.isSafeInteger(session.revision)))return;
 session.busy=true;if(check)session.invalid=true;reconciliationControls(session);showMessage(check?'Читаємо стан саме цієї сторінки…':'Оновлюємо збережені докази…',false,$('ap-reconciliation-note'));
 const task=async()=>{if(!currentReconciliation(session))return;try{const result=await request('/autopilot/'+encodeURIComponent(session.runId)+(check?'/reconcile':'/reconciliation'),check?{expectedRevision:session.revision}:undefined);if(!currentReconciliation(session))return;if(result.run?.id!==session.runId||!result.publication||!Number.isSafeInteger(result.run.revision))throw Error('Сервер не підтвердив поточну сторінку. Оновіть докази.');session.publication=result.publication;session.revision=result.run.revision;session.invalid=false;renderReconciliation(session);const proof={published:'Опубліковано. Далі виконується перевірка збереженої сторінки.',draft:'Підтверджено чернетку. Публікація цим читанням не виконувалась.',trashed:'Кошик підтверджено читанням.',unknown:'Результат не підтверджено. Повторне відправлення не дозволено.',missing_identity:'Немає точного WP ID. Повторне відправлення не дозволено.'};showMessage(check?(proof[result.observation]||'Докази оновлено; результат ще не підтверджено.'):'Збережені докази оновлено. Читання WordPress запускається окремою кнопкою.',false,$('ap-reconciliation-note'));if(check)window.dispatchEvent(new CustomEvent('pageposter:queue-updated',{detail:{runId:session.runId}}));}
 catch(error){if(currentReconciliation(session)){session.invalid=true;showMessage(errorText(error)+' Оновіть докази перед наступною перевіркою.',true,$('ap-reconciliation-note'));}}
 finally{session.busy=false;reconciliationControls(session);}};
 reconciliationTail=reconciliationTail.catch(()=>{}).then(task);
}
function openReconciliation(run){
 if(state.restartRequired||!run?.id||!run.publication)return;const dialog=$('ap-reconciliation');if(dialog.open){if(state.reconciliation?.runId===run.id)return;dialog.close();}const session={runId:run.id,publication:run.publication,revision:null,busy:false,invalid:true};state.reconciliation=session;dialog._focusAddress={queueItem:document.activeElement?.closest('[data-queue-item]')?.dataset.queueItem,runId:run.id};openDialog('ap-reconciliation');renderReconciliation(session);reconcileRequest(session);
}
async function downloadSupport(){
 const control=$('ap-support-download');if(control.disabled||state.restartRequired)return;control.disabled=true;showMessage('Готуємо звіт…',false,$('ap-support-note'));
 try{const report=await request('/support/export',{}),blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='pageposter-support-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);showMessage('Звіт завантажено. Він містить безпечну діагностику без вмісту сторінок і скриншотів.',false,$('ap-support-note'));}catch{showMessage('Не вдалося отримати звіт. Спробуйте завантажити його ще раз.',true,$('ap-support-note'));}finally{control.disabled=state.restartRequired;}
}
function needsAiSettings(run){return ['AI_ACCESS_DENIED','AI_AUTH_FAILED','AI_MODEL_UNAVAILABLE','AI_REGION_UNSUPPORTED','not_configured'].includes(run.error?.code);}
function checkDiagnostics(verification){
 const value=verification?.diagnostics;if(!value)return null;
 const box=el('details','ap-inline-note');box.dataset.checkDiagnostics='';append(box,el('summary','','Результати перевірки браузером'),el('p','',value.code),el('p','',verification.summary));
 const progressLabels={public_read:'Отримання сторінки',public_assets:'Завантаження ресурсів',baseline_assets:'Підготовка еталонного HTML',browser_launch:'Запуск браузера',public_render:'Відображення сторінки на ПК',visual_compare:'Порівняння вигляду на ПК',screenshot:'Збереження знімка',interactions:'Перевірка кнопок',cleanup:'Завершення перевірки'},progress=value.progress;if(progress&&progressLabels[progress.stage]&&Number.isSafeInteger(progress.elapsedMs)&&Number.isSafeInteger(progress.budgetMs))box.appendChild(el('p','','Етап: '+progressLabels[progress.stage]+' · '+(progress.elapsedMs/1000).toFixed(1)+' / '+(progress.budgetMs/1000).toFixed(1)+' с'));
 const states={ok:'пройдено',problem:'проблема',unknown:'не підтверджено',not_applicable:'не потрібна'},labels={marker:'Обгортка',links:'Посилання',cta_targets:'Кнопки',navigation:'Навігація',overflow:'Ширина',required_content:'Видимість вмісту',runtime:'PagePoster',clean_links_runtime:'Clean Links',assets:'Зображення',mobile_menu:'Мобільне меню',clicks:'Переходи'};
 for(const view of (value.viewports||[]).slice(0,2)){const line=el('p','',(view.name==='mobile'?'Телефон (mobile)':'Комп’ютер (desktop)')+': '+(view.checks||[]).slice(0,16).map(check=>(labels[check.kind]||'Перевірка')+' — '+(states[check.state]||'не підтверджено')).join('; '));box.appendChild(line);}
 const networkLabels={untrustedScripts:'Непідтримувані скрипти',removedHandlers:'Обробники подій',unsupportedDocuments:'Вбудовані документи',fetchedAssets:'Отримані ресурси',blockedAssets:'Заблоковані ресурси',failedAssets:'Помилки ресурсів',deniedBrowserRequests:'Відхилені запити браузера'};
 const links=value.linkSummary;if(links&&['expectedUrls','ourUrls','nativeHrefs','repeatedControls','outsideUrls','unexpectedOurUrls'].every(key=>Number.isSafeInteger(links[key])&&links[key]>=0))append(box,el('p','','Наші адреси: '+links.ourUrls+' / '+links.expectedUrls+' · Нативні href: '+links.nativeHrefs+' · Повторні кнопки: '+links.repeatedControls),el('p','ap-fine','Сторонні адреси теми: '+links.outsideUrls+' · Неочікувані наші адреси: '+links.unexpectedOurUrls));
 for(const [name,label] of Object.entries(networkLabels))if(Number.isSafeInteger(value.network?.[name]))box.appendChild(el('p','',label+': '+value.network[name]));
 for(const limitation of (value.limitations||[]).slice(0,3))box.appendChild(el('p','ap-fine',limitation));
 return box;
}
function openAiSettings(){openSettings();window.PagePosterSettings?.show('ai');if($('ap-key-editor'))$('ap-key-editor').open=true;$('ap-key-form').elements.apiKey.focus();}
function currentDestination(session){return state.destinationSession===session&&$('ap-destination').open&&!state.restartRequired;}
function destinationControls(session){
 if(state.destinationSession!==session)return;
 const blocked=!!session.blockedReason,busy=!!session.busy,source=session.mode==='source',catalogue=session.catalogue;
 $('ap-destination').classList.toggle('ap-destination-source-mode',source);$('ap-destination-source').hidden=!source;$('ap-destination-form').hidden=source;
 for(const [id,selected]of [['ap-destination-source-tab',source],['ap-destination-manual-tab',!source]]){$(id).setAttribute('aria-pressed',String(selected));$(id).disabled=busy;}
 for(const control of $('ap-destination-form').elements)control.disabled=busy||blocked;
 for(const id of ['ap-donor-search','ap-donor-all'])$(id).disabled=busy||blocked;
 $('ap-donor-refresh').disabled=busy||blocked||session.loading;
 $('ap-donor-prev').disabled=busy||blocked||session.loading||!catalogue||catalogue.offset===0;
 $('ap-donor-next').disabled=busy||blocked||session.loading||!catalogue||catalogue.offset+catalogue.candidates.length>=catalogue.total;
 $('ap-donor-list').setAttribute('aria-busy',String(!!session.loading));
 for(const control of $('ap-donor-list').querySelectorAll('[data-donor-choice]'))control.disabled=busy||blocked||session.loading||control.dataset.available!=='true';
}
function destinationMode(session,mode){
 if(!currentDestination(session)||session.busy)return;session.mode=mode;clearTimeout(session.searchTimer);destinationControls(session);
 if(mode==='source'&&!session.catalogue&&!session.loading&&!session.blockedReason)loadDestinationCandidates(session,0);
}
function destinationCriteria(criteria){const geo=Array.isArray(criteria?.geo)?criteria.geo.join(', '):criteria?.geo;return 'Вимоги сторінки: гео '+(geo||'будь-яке')+' · DR '+(criteria?.minDr==null?'без обмеження':'від '+criteria.minDr)+' · трафік '+(criteria?.minTraffic==null?'без обмеження':'від '+criteria.minTraffic);}
function renderDestinationCandidates(session){
 if(!currentDestination(session))return;const list=$('ap-donor-list'),catalogue=session.catalogue;clear(list);
 if(!catalogue){list.appendChild(el('p','ap-donor-empty',session.loading?'Завантажуємо донорів…':session.blockedReason||'Оновіть список або вкажіть сайт вручну.'));$('ap-donor-count').textContent='';destinationControls(session);return;}
 if(!catalogue.candidates.length)list.appendChild(el('p','ap-donor-empty','За цими умовами донорів немає. Змініть пошук або покажіть сайти поза вимогами сторінки.'));
 for(const candidate of catalogue.candidates){
  let url;try{url=new URL(candidate.baseUrl);if(url.protocol!=='https:'||url.username||url.password)url=null;}catch{}
  const row=el('article','ap-donor-row'+(candidate.matchesCriteria===false?' ap-donor-mismatch':'')),details=el('div','ap-donor-description');
  details.appendChild(url?link(url.hostname,url.href,'ap-donor-domain'):el('strong','','Некоректна адреса'));if(url&&url.pathname!=='/')details.appendChild(el('span','ap-donor-path',url.pathname));
  const countries=Array.isArray(candidate.geo)?candidate.geo.join(', '):candidate.geo,number=value=>Number.isFinite(value)?value.toLocaleString('uk-UA'):'—';
  details.appendChild(el('p','ap-donor-metrics','DR: '+number(candidate.dr)+' · трафік: '+number(candidate.traffic)+' · гео: '+(countries||'—')));
  if(candidate.current)details.appendChild(el('span','ap-donor-status','Поточний донор'));
  if(candidate.reason||candidate.available!==true)details.appendChild(el('p','ap-donor-reason',candidate.reason||'Донор зараз недоступний.'));
  if(candidate.exclusion)details.appendChild(el('p','ap-donor-reason',exclusionDescription(candidate.exclusion)));
  if(candidate.warning||candidate.matchesCriteria===false)details.appendChild(el('p','ap-donor-warning',candidate.warning||'Сайт поза вимогами цієї сторінки.'));
  const selected=candidate.current&&session.run.donorPinned===true,available=!!url&&typeof candidate.id==='string'&&candidate.available===true&&!selected;
  const choose=button(session.busy&&session.pendingCandidateId===candidate.id?'Зберігаємо…':selected?'Обрано':'Обрати',()=>chooseDestinationCandidate(session,catalogue,candidate),'ap-button '+(selected?'ap-secondary':'ap-primary'));
  choose.dataset.donorChoice=String(candidate.id);choose.dataset.available=String(available);choose.disabled=!available||session.busy||!!session.blockedReason;
  if(!available)choose.title=candidate.reason||(selected?'Цей донор уже закріплений за сторінкою.':'Цей донор зараз недоступний.');append(row,details,choose);list.appendChild(row);
 }
 $('ap-donor-count').textContent=catalogue.candidates.length?'Показано '+(catalogue.offset+1)+'–'+(catalogue.offset+catalogue.candidates.length)+' із '+catalogue.total:'Знайдено: '+catalogue.total;destinationControls(session);
}
async function loadDestinationCandidates(session,offset=0){
 if(!currentDestination(session)||session.busy||session.blockedReason||session.mode!=='source')return;
 clearTimeout(session.searchTimer);const serial=++session.sourceSerial;session.loading=true;session.catalogue=null;showMessage('',false,$('ap-destination-note'));renderDestinationCandidates(session);
 const query=new URLSearchParams({search:$('ap-donor-search').value.trim(),offset:String(offset),limit:'30',all:$('ap-donor-all').checked?'1':'0'});
 try{
  const result=await request('/autopilot/'+encodeURIComponent(session.runId)+'/donors?'+query);
  if(!currentDestination(session)||serial!==session.sourceSerial)return;
  if(result.run?.id!==session.runId)throw Error('Сервер не підтвердив сторінку для вибору донора. Оновіть список.');
  session.run=result.run;session.blockedReason=result.run.canSetDestination===false?(result.run.destinationBlockedReason||'Зараз донора цієї сторінки змінити не можна.'):'';
  if(session.blockedReason){showMessage(session.blockedReason,true,$('ap-destination-note'));return;}
  if(!Array.isArray(result.candidates)||result.candidates.length>100||!Number.isSafeInteger(result.total)||result.total<0||!Number.isSafeInteger(result.offset)||result.offset<0||!Number.isSafeInteger(result.limit)||result.limit<1||typeof result.token!=='string'||!Number.isSafeInteger(result.destinationRevision)||result.destinationRevision<0)throw Error('Сервер не підтвердив список донорів. Оновіть його ще раз.');
  session.revision=result.destinationRevision;
  session.catalogue=result;$('ap-donor-criteria').textContent=destinationCriteria(result.criteria);$('ap-destination-current').textContent=result.run.selectedDomain?'Поточний донор: '+result.run.selectedDomain+(result.run.donorPinned?' · закріплений за сторінкою':''):'';
 }catch(error){if(currentDestination(session)&&serial===session.sourceSerial)showMessage(errorText(error)+' Можна оновити список або вказати сайт вручну.',true,$('ap-destination-note'));}
 finally{if(currentDestination(session)&&serial===session.sourceSerial){session.loading=false;renderDestinationCandidates(session);}}
}
function scheduleDestinationSearch(){
 const session=state.destinationSession;if(!currentDestination(session)||session.busy)return;clearTimeout(session.searchTimer);session.sourceSerial++;session.loading=false;session.catalogue=null;renderDestinationCandidates(session);session.searchTimer=setTimeout(()=>loadDestinationCandidates(session,0),300);
}
function openDestination(run,{queueMode=false}={}){
 if(!run?.id||state.restartRequired)return;const prior=state.destinationSession;if(prior){clearTimeout(prior.searchTimer);prior.sourceSerial++;}state.destinationOpenSerial=(state.destinationOpenSerial||0)+1;
 const form=$('ap-destination-form');form.reset();const session={runId:run.id,run,revision:run.destinationRevision||0,selection:state.selected,queueMode,mode:'source',sourceSerial:0,loading:false,catalogue:null,busy:false,blockedReason:run.canSetDestination===true?'':run.destinationBlockedReason||'Зараз донора цієї сторінки змінити не можна.'};state.destinationSession=session;
 form.elements.siteUrl.value=run.destinationMode==='manual'?run.selectedDomain:'';$('ap-donor-search').value='';$('ap-donor-all').checked=false;$('ap-donor-criteria').textContent='';
 $('ap-destination-page').textContent=run.title||'Підготовлена сторінка';$('ap-destination-current').textContent=run.selectedDomain?'Поточний донор: '+run.selectedDomain+(run.donorPinned?' · закріплений за сторінкою':''):'';showMessage(session.blockedReason,!!session.blockedReason,$('ap-destination-note'));
 if(!$('ap-destination').open)openDialog('ap-destination');destinationControls(session);renderDestinationCandidates(session);if(!session.blockedReason)loadDestinationCandidates(session,0);
}
async function openQueueDestination(detail){
 const {projectId,runId}=detail||{};if(!projectId||!runId||state.restartRequired)return;
 const serial=state.destinationOpenSerial=(state.destinationOpenSerial||0)+1,target=$('pq-dashboard-note')||$('ap-notice');showMessage('Завантажуємо стан сторінки…',false,target);
 try{const result=await request('/projects/'+encodeURIComponent(projectId)+'/autopilot');if(serial!==state.destinationOpenSerial||state.restartRequired)return;const run=(result.runs||[]).find(value=>value.id===runId&&value.projectId===projectId);if(!run)throw Error('Цю сторінку вже змінено або видалено. Оновіть список.');showMessage('',false,target);openDestination(run,{queueMode:true});}
 catch(error){if(serial===state.destinationOpenSerial)showMessage(errorText(error),true,target);}
}
async function destinationSaved(session,run){
 if(run?.id!==session.runId)throw Error('Сервер не підтвердив вибір донора. Оновіть список.');
 if(run.projectId===state.selected){state.load++;state.runs=[run,...state.runs.filter(value=>value.id!==run.id)];renderResults();}
 if(state.stage?.runId===run.id)state.stage.reviewToken=null;
 window.dispatchEvent(new CustomEvent('pageposter:queue-updated',{detail:{runId:run.id}}));
 if(!currentDestination(session))return;
 closeDialog('ap-destination');showMessage('Донора збережено для цієї сторінки. Перегляньте її та підтвердьте публікацію.',false,session.queueMode?$('pq-dashboard-note'):$('ap-notice'));
 if(!session.queueMode&&state.selected===session.selection){await loadPreparedRun(session.runId);scheduleRefresh();}
}
async function chooseDestinationCandidate(session,catalogue,candidate){
 if(!currentDestination(session)||session.busy||session.loading||session.catalogue!==catalogue||candidate.available!==true)return;
 session.busy=true;session.pendingCandidateId=candidate.id;session.sourceSerial++;clearTimeout(session.searchTimer);renderDestinationCandidates(session);
 try{const result=await request('/autopilot/'+encodeURIComponent(session.runId)+'/donor',{token:catalogue.token,candidateId:candidate.id,expectedRevision:session.revision});await destinationSaved(session,result.run);}
 catch(error){if(currentDestination(session))showMessage(errorText(error)+' Оновіть список перед наступною спробою.',true,$('ap-destination-note'));}
 finally{if(currentDestination(session)){session.busy=false;session.pendingCandidateId=null;session.catalogue=null;renderDestinationCandidates(session);}}
}
async function saveDestination(event){
 event.preventDefault();const session=state.destinationSession,form=event.currentTarget;
 if(!currentDestination(session)||session.busy||session.mode!=='manual'||session.blockedReason)return;
 const address=form.elements.siteUrl.value.trim();
 const payload={baseUrl:address.includes('://')?address:'https://'+address,username:form.elements.siteUsername.value.trim(),password:form.elements.sitePassword.value,expectedRevision:session.revision};
 session.busy=true;session.sourceSerial++;session.loading=false;session.catalogue=null;clearTimeout(session.searchTimer);destinationControls(session);
 try{
  const result=await request('/autopilot/'+session.runId+'/destination',payload);
  await destinationSaved(session,result.run);
 }catch(error){if(state.destinationSession===session)showMessage(errorText(error),true,$('ap-destination-note'));}
 finally{payload.password='';if(state.destinationSession===session){form.elements.sitePassword.value='';session.busy=false;destinationControls(session);}}
}
async function deleteRun(run){
 if(!window.confirm('Видалити «'+(run.title||'Нова сторінка')+'» з PagePoster?\nЦей запуск і його неопублікована чернетка зникнуть зі списку.'))return;
 const result=await request('/autopilot/'+run.id+'/delete',{});
 if(result.deleted!==true||result.id!==run.id)throw Error('Сервер не підтвердив видалення. Оновіть список і спробуйте ще раз.');
 state.load++;state.runs=state.runs.filter(item=>item.id!==run.id);state.pages=state.pages.filter(page=>page.id!==run.pageId);
 if(state.stage?.runId===run.id||state.autoPreviewRun===run.id||state.stageLoading===run.id){clearStage();state.suppressAutoPreview=true;}
 renderResults();scheduleRefresh();showMessage('Сторінку видалено з PagePoster.');
 try{await loadResults();}catch{showMessage('Сторінку видалено. Не вдалося оновити решту списку; оновіть сторінку.',true);}
}
function renderRun(run,{inspector=false}={}){
 const card=el('article','ap-run');card.dataset.runId=run.id;card.dataset.state=run.state;
 const top=el('div','ap-run-top'),text=el('div');append(text,el('h3','',run.title||'Нова сторінка'),el('p','ap-run-meta',(state.selected||!run.projectName?'':run.projectName+' · ')+date(run.updatedAt)));
 append(top,text,statusBadge(run));card.appendChild(top);
 const progress=el('ol','ap-run-steps');let index=steps.findIndex(s=>s[0]===run.stage);if(run.state==='completed')index=steps.length;else if(index<0)index=0;
 steps.forEach((item,i)=>progress.appendChild(el('li','ap-step '+(i<index?'done':i===index?'active':''),i===0&&(run.source==='html'||run.stage==='preparing')?'Підготовка HTML':item[1])));card.appendChild(progress);
 if(run.state==='awaiting_review')card.appendChild(el('p','ap-inline-note','Сторінку підготовлено. Перегляньте її на комп’ютері, потім натисніть «Опублікувати сторінку».'));
 if(run.state==='waiting_source')card.appendChild(el('p','ap-inline-note','HTML уже збережено. Укажіть сайт вручну або підключіть Google Таблицю для підбору.'));
 if(run.destinationMode==='manual')card.appendChild(el('p','ap-inline-note','Сайт публікації: '+run.selectedDomain+' · вибрано вручну'));
 for(const skipped of run.skippedSites||[]){let host;try{host=new URL(skipped.baseUrl).hostname;}catch{continue;}card.appendChild(el('p','ap-inline-note','Пропущено '+host+': '+(skipped.code==='NATIVE_VISUAL_REJECTED'?'зламаний вигляд; створену сторінку переміщено в кошик.':skipped.code==='bootstrap_auth_failed'?'дані для входу не підійшли.':skipped.code==='CLEAN_LINKS_FILESYSTEM_REQUIRED'?'WordPress потребує FTP-доступу для плагіна.':skipped.code==='BROWSER_PAGE_UNAVAILABLE'?(Number.isInteger(skipped.httpStatus)?'відповідь HTTP '+skipped.httpStatus+' під час відкриття WordPress.':'не вдалося відкрити WordPress.'):'установлення плагіна недоступне.')));}
 if(run.pluginFallback)card.appendChild(el('p','ap-inline-note',run.cleanupPhase?'Зламаний вигляд сторінки. Тул підтверджує її переміщення в кошик перед зміною донора.':'Clean Links недоступний. Тул публікує HTML і перевіряє його вигляд на комп’ютері.'));
 if(run.error&&!publicationStatus(run.publication)?.working)card.appendChild(el('p','ap-inline-note',errorText(run.error)));
 const publicationDetails=publicationDiagnostics(run.publication);if(publicationDetails)card.appendChild(publicationDetails);
 if(run.verification?.diagnostics)card.appendChild(checkDiagnostics(run.verification));
 if(run.state==='uncertain')card.appendChild(el('p','ap-muted','Сервер перевірить попередній запит перед продовженням, щоб не створити дубль сторінки.'));
 if(run.fullUrl)card.appendChild(link(run.fullUrl,run.fullUrl));
 const actions=el('div','ap-run-actions');
 if(needsAiSettings(run)&&['failed','uncertain','needs_attention','paused'].includes(run.state))actions.appendChild(button('Перевірити підключення OpenAI',openAiSettings));
 if(!inspector&&(['selecting','installing','publishing','checking','completed'].includes(run.stage)||run.pageId))actions.appendChild(button(run.state==='awaiting_review'?'Переглянути й опублікувати':'Попередній перегляд',event=>working(event.currentTarget,()=>preview(run.id))));
 if(!inspector&&(run.hasHtml||run.pageId))actions.appendChild(button('Копіювати HTML',event=>{const control=event.currentTarget;return working(control,()=>copyRunHTML(run.id,control));}));
 if(run.publication?.canReconcile){const reconcile=button('Звірити стан сторінки',()=>openReconciliation(run));reconcile.dataset.action='reconcile';actions.appendChild(reconcile);}
 if(run.pageId)actions.appendChild(linkReportControl(run.pageId));
 if(publicationCanContinue(run.publication)&&['waiting_source','failed','uncertain','needs_attention','paused'].includes(run.state)){
  if(run.state==='waiting_source'&&!state.status?.source?.configured)actions.appendChild(button('Підключити таблицю',openSettings));
  else actions.appendChild(button(run.state==='waiting_source'?'Продовжити публікацію':'Продовжити зі збереженого кроку',event=>working(event.currentTarget,async()=>{const result=await request('/autopilot/'+run.id+'/resume',{});if(!result.run?.id)throw Error('Сервер не підтвердив продовження запуску. Оновіть його стан.');state.runs=[result.run,...state.runs.filter(saved=>saved.id!==result.run.id)];renderResults();syncPreparedPreview();scheduleRefresh();await loadResults();})));
 }
 if(run.canSetDestination===true)actions.appendChild(button(run.selectedDomain?'Змінити донора':'Вказати донора',()=>openDestination(run)));
 if(!run.canSetDestination&&run.hasHtml&&['failed','uncertain','needs_attention','paused'].includes(run.state)&&run.destinationBlockedReason)card.appendChild(el('p','ap-inline-note',run.destinationBlockedReason));
 if(run.browserWindow&&run.browserMode!=='hidden')actions.appendChild(button('Показати вікно WordPress',event=>working(event.currentTarget,async()=>{try{await request('/autopilot/'+run.id+'/browser',{});}catch(error){if(['BROWSER_CLOSED','BROWSER_NOT_OPEN'].includes(error.code))throw Error('Вікно WordPress закрито. Натисніть «Продовжити зі збереженого кроку», щоб відкрити його знову.');throw error;}})));
 if(run.canDelete===true)actions.appendChild(button('Видалити',event=>working(event.currentTarget,()=>deleteRun(run)),'ap-button ap-secondary ap-delete-run'));
 card.appendChild(actions);return card;
}
function pageVerification(page){return state.overview.get(page.id)?.verification||page.verification||{state:'pending'};}
function renderPage(page,{isCurrent=()=>true}={}){
 const card=el('article','ap-page'),top=el('div','ap-page-top'),text=el('div'),verification=pageVerification(page);
 append(text,el('h3','',page.title||'Опублікована сторінка'),link(page.fullUrl,page.fullUrl));if(!state.selected)text.appendChild(el('p','ap-page-meta',page.projectName));
 const name=verification.state==='ok'?'Перевірена':verification.state==='problem'?'Є проблеми':verification.state==='unknown'?'Потрібна перевірка':'Очікує перевірки';
 append(top,text,badge(name,verification.state==='ok'?'good':verification.state==='problem'?'error':'warning'));card.appendChild(top);
 const bottom=el('div','ap-page-bottom'),info=el('div','ap-verification');append(info,el('strong','',verification.checkedAt?'Перевірено '+date(verification.checkedAt):'Ще не перевірена'),el('div','',verification.summary||'Натисніть «Перевірити стан сторінок».'));
 const actions=el('div','ap-page-actions');append(actions,link('Відкрити ↗',page.fullUrl,'ap-button ap-secondary'),button('Замінити посилання',event=>working(event.currentTarget,()=>openReplacement(page,isCurrent))));
 actions.appendChild(linkReportControl(page.id));
 append(bottom,info,actions);card.appendChild(bottom);return card;
}

function renderOverview(){
 const pages=state.pages.filter(page=>page.fullUrl),attention=new Set(pages.filter(page=>['problem','unknown'].includes(pageVerification(page).state)).map(page=>page.id));
 state.runs.filter(run=>!publicationStatus(run.publication)?.working&&(['waiting_source','failed','uncertain','needs_attention'].includes(run.state)||run.state==='paused'&&run.error)).forEach(run=>attention.add(run.pageId||'run:'+run.id));
 $('ap-overview').hidden=!state.projects.some(project=>!project.archived);
 $('ap-stat-published').textContent=pages.length;
 $('ap-stat-verified').textContent=pages.filter(page=>pageVerification(page).state==='ok').length;
 $('ap-stat-active').textContent=state.runs.filter(runWorking).length;
 $('ap-stat-attention').textContent=attention.size;
 $('ap-check-pages').hidden=!pages.length;
 $('ap-library').hidden=!state.projects.some(project=>!project.archived);
}
function renderSetup(){
 const missingAi=state.mode==='ai'&&!state.status?.aiConfigured,missingSource=!state.status?.source?.configured,sourceDraft=!!state.status?.source?.spreadsheetId;
 $('ap-setup').hidden=!state.selected||!state.status||(!missingAi&&!missingSource);
 $('ap-setup-title').textContent=missingAi?'Підготуйте генерацію сторінок':sourceDraft?'Підключіть акаунт Google':'Підключіть базу для публікації';
 $('ap-setup-copy').textContent=missingAi?'Збережіть ключ OpenAI у налаштуваннях або виберіть готовий HTML — для нього ключ не потрібен.':sourceDraft?'Таблиця й колонки налаштовані. Підключіть робочий або сервісний акаунт Google із доступом на читання.':'Додайте Google Таблицю із сайтами. Поки вона не підключена, підготовлений HTML збережеться й чекатиме публікації.';
}
function previewSize(mobile){
 state.dialogMobile=mobile;$('ap-preview-frame').closest('.ap-preview-canvas').classList.toggle('is-mobile',mobile);
 $('ap-preview-mobile').setAttribute('aria-pressed',String(mobile));$('ap-preview-desktop').setAttribute('aria-pressed',String(!mobile));fitAllPreviews();
}
function stageSize(mobile){
 state.stageMobile=mobile;$('ap-stage-canvas').classList.toggle('is-mobile',mobile);
 $('ap-stage-mobile').setAttribute('aria-pressed',String(mobile));$('ap-stage-desktop').setAttribute('aria-pressed',String(!mobile));fitAllPreviews();
}
function fitFrame(frame,canvas,mobile){
 if(frame.hidden)return;const width=mobile?390:1280,available=Math.max(1,(canvas.clientWidth||640)-32),height=Math.max(200,(canvas.clientHeight||560)-32),scale=Math.min(1,available/width);
 Object.assign(frame.style,{position:'absolute',width:width+'px',height:Math.ceil(height/scale)+'px',left:Math.max(0,((canvas.clientWidth||640)-width*scale)/2)+'px',top:'16px',border:'0',transformOrigin:'0 0',transform:'scale('+scale+')'});
}
function fitAllPreviews(){fitFrame($('ap-stage-frame'),$('ap-stage-canvas'),state.stageMobile);fitFrame($('ap-preview-frame'),$('ap-preview-frame').closest('.ap-preview-canvas'),state.dialogMobile);}
const previewDestinations=new WeakMap();
function previewURL(value){
 if(typeof value!=='string'||!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f]/.test(value))return '';
 try{const url=new URL(value);return url.hostname&&!url.username&&!url.password?value:'';}catch{return '';}
}
function previewNavigationClient(){
 function follow(event){
  if(!event.isTrusted||(event.type==='keydown'&&!['Enter',' '].includes(event.key))||(event.type==='auxclick'&&event.button!==1))return;
  const node=event.target?.closest?.('a[href],[data-pp-url]');if(!node||!node.closest('#pp-landing'))return;
  const url=node.getAttribute('data-pp-url')||node.getAttribute('href');if(!/^https?:\/\//i.test(url||''))return;
  event.preventDefault();event.stopImmediatePropagation();parent.postMessage({type:'pageposter-preview-navigate',url},'*');
 }
 for(const event of ['click','auxclick','keydown'])window.addEventListener(event,follow,true);
}
window.addEventListener('message',event=>{
 if(event.data?.type!=='pageposter-preview-navigate'||!navigator.userActivation?.isActive)return;
 const frame=[$('ap-stage-frame'),$('ap-preview-frame')].find(node=>node?.contentWindow===event.source);
 const url=previewURL(event.data.url);
 if(!frame||frame.hidden||!frame.getClientRects().length||!url||!previewDestinations.get(frame)?.has(url))return;
 window.open(url,'_blank','noopener,noreferrer');
});
function mountPreview(id,html){
 const previous=$(id),frame=previous.cloneNode(false);frame.removeAttribute('srcdoc');previous.replaceWith(frame);frame.hidden=false;
 const doc=new DOMParser().parseFromString(html,'text/html');
 previewDestinations.set(frame,new Set([...doc.querySelectorAll('#pp-landing a[href],#pp-landing [data-pp-url]')].map(node=>previewURL(node.getAttribute('data-pp-url')||node.getAttribute('href'))).filter(Boolean)));
 frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; img-src https: data:; style-src \'unsafe-inline\' https:; font-src https: data:; form-action \'none\'; base-uri \'none\'">'+'<script>('+previewNavigationClient.toString()+')();<\/script>'+html;fitAllPreviews();return frame;
}
function clearStage(title='Спочатку перегляньмо результат',copy='Додайте посилання або готовий HTML ліворуч і натисніть «Підготувати й переглянути».'){
 invalidateManualExport();state.stageSerial++;state.stage=null;state.dialogStage=null;state.stageLoading=null;state.autoPreviewRun=null;if($('ap-preview').open)closeDialog('ap-preview');
 if($('ap-stage-settings'))$('ap-stage-settings').hidden=true;
 const frame=$('ap-stage-frame');frame.hidden=true;frame.removeAttribute('srcdoc');$('ap-stage-empty').hidden=false;$('ap-stage').dataset.status='empty';
 $('ap-stage-title').textContent='Ваша майбутня сторінка';$('ap-stage-caption').textContent='Перевірте оформлення перед публікацією у WordPress.';
 $('ap-stage-empty-title').textContent=title;$('ap-stage-empty-copy').textContent=copy;updateStageActions();
}
function editableChanged(){clearStage('Дані змінилися','Підготуйте новий перегляд. Уже створені варіанти збережено в списку запусків.');state.suppressAutoPreview=true;saveDraft();}
function setStage(data){
 invalidateManualExport();
 if($('ap-stage-settings'))$('ap-stage-settings').hidden=true;
 if($('ap-preview').open)closeDialog('ap-preview');state.dialogStage=null;
 state.stage={...data,selection:state.selected};$('ap-stage-empty').hidden=true;$('ap-stage').dataset.status='ready';
 $('ap-stage-title').textContent=data.title||'Перегляд сторінки';$('ap-stage-caption').textContent=data.kind==='draft'?'Ваш HTML, підготовлений для WordPress.':'Збережена сторінка — повторна генерація не потрібна.';
 mountPreview('ap-stage-frame',data.html);updateStageActions();
}
function setDraftPreview(review){setStage({kind:'draft',html:review.html,fingerprint:review.fingerprint,title:review.title||'Ваш HTML'});$('ap-stage-title').focus({preventScroll:true});}
function updateStageActions(){
 if(manualExportSession&&!manualExportSession.isCurrent())invalidateManualExport();
 const stage=state.stage,review=stage?.kind==='draft'?currentReview():null,run=stage?.run;
 const draftReady=stage?.kind==='draft'&&stage.fingerprint===review?.fingerprint&&review?.viewed&&(!review.warnings.length||review.accepted)&&!getPending();
 const runReady=stage?.kind==='run'&&run?.state==='awaiting_review'&&!!stage.reviewToken;
 const ready=!!stage&&stage.selection===state.selected&&(draftReady||runReady),busy=state.busy||state.fileBusy||state.publishBusy||!!state.stageLoading;
 $('ap-stage-expand').disabled=!stage?.html||!!state.stageLoading;
 $('ap-stage-copy').disabled=!stage?.html||stage.selection!==state.selected||busy;
 $('ap-copy-html').disabled=$('ap-stage-copy').disabled||state.dialogStage!==stage;for(const id of ['ap-stage-manual-export','ap-preview-manual-export'])if($(id))$(id).disabled=$('ap-stage-copy').disabled||(id==='ap-preview-manual-export'&&state.dialogStage!==stage);
 $('ap-stage-publish').disabled=!ready||busy;$('ap-preview-publish').disabled=!ready||busy||state.dialogStage!==stage;
 $('ap-stage-destination').hidden=!run?.canSetDestination;$('ap-stage-destination').disabled=busy;
 $('ap-stage-destination').textContent=run?.selectedDomain?'Змінити донора':'Вказати донора';
 let message='Публікація почнеться після вашого натискання.';
 if(state.stageLoading)message='Завантажуємо вибраний варіант…';
 else if(busy)message='Зберігаємо запит… Не потрібно надсилати його повторно.';
 else if(stage?.kind==='status')message=activeStates.has(run?.state)?'Підготовка виконується. Публікація чекає вашого перегляду.':'Автоматичного повтору немає. Виправте причину й продовжте збережений запуск нижче.';
 else if(stage?.kind==='draft')message=getPending()?'Попередній запит ще не підтверджено. Скористайтеся кнопкою «Повторити збережений запит».':!draftReady?'Підтвердьте зміни HTML під формою перед публікацією.':state.status?.source?.configured?'Перевірте обидва розміри. Цей варіант готовий до публікації.':'Можна підтвердити публікацію зараз. HTML збережеться й чекатиме підключення бази сайтів.';
 else if(stage?.kind==='run')message=runReady?(state.status?.source?.configured?'Сторінку ще не опубліковано. Перевірте її й підтвердьте публікацію.':'Сторінку ще не опубліковано. Після підтвердження вона чекатиме підключення бази сайтів.'):run?.state==='awaiting_review'?'Відкрийте актуальний перегляд, щоб підтвердити цей варіант.':run?.state==='waiting_source'?'Публікацію підтверджено. Підключіть базу сайтів, щоб продовжити.':run?.state==='completed'?'Сторінку опубліковано. Перевірки завершено.':'Стан публікації показано в списку запусків нижче.';
 if(stage?.kind==='run'&&!busy&&run?.destinationMode==='manual'&&runReady)message='Сайт публікації: '+run.selectedDomain+' — почнемо після вашого натискання.';
 else if(stage?.kind==='run'&&!busy&&run?.canSetDestination&&!state.status?.source?.configured)message='Укажіть сайт вручну або підключіть таблицю. Сторінку вже збережено.';
 $('ap-stage-status').textContent=message;$('ap-preview-note').textContent=message;
 if(ready&&!busy&&state.status?.visibleBrowser){$('ap-stage-status').textContent+=(run?.browserMode||state.status.browserMode)==='hidden'?' Після підтвердження браузер виконає публікацію в прихованому режимі.':' Після підтвердження відкриється окреме вікно WordPress.';$('ap-preview-note').textContent=$('ap-stage-status').textContent;}
}
async function loadPreparedRun(id,{automatic=false}={}){
 const selection=state.selected,serial=++state.stageSerial,run=state.runs.find(item=>item.id===id);state.stageLoading=id;updateStageActions();
 if(!automatic){state.suppressAutoPreview=true;state.autoPreviewRun=null;}
 try{
  const result=await request('/autopilot/'+id+'/html');if(serial!==state.stageSerial||selection!==state.selected)return;
  if(typeof result.html!=='string')throw Error('HTML ще не готовий. Дочекайтеся завершення підготовки.');
  setStage({kind:'run',runId:id,run:state.runs.find(item=>item.id===id)||run,html:result.html,reviewToken:result.reviewToken||null,title:run?.title||'Підготовлена сторінка'});
  if(!selection)showPreview(result.html);else if(!automatic)$('ap-stage-title').focus({preventScroll:true});
 }catch(error){if(serial===state.stageSerial){showMessage(errorText(error),true);state.suppressAutoPreview=true;}}
 finally{if(serial===state.stageSerial){state.stageLoading=null;updateStatus();}}
}
function showPreparationState(run){
 const active=activeStates.has(run.state),titles={failed:'Не вдалося підготувати сторінку',uncertain:'Результат підготовки потребує перевірки',paused:'Підготовку призупинено',needs_attention:'Підготовка потребує уваги'};
 const title=active?'Готуємо вашу сторінку':titles[run.state]||labels[run.state],copy=active?'ШІ створює тексти й оформлення. Публікація почнеться після вашого підтвердження.':run.error?errorText(run.error):'Запуск збережено. Продовжте його вручну з картки нижче.';
 clearStage(title,copy);state.autoPreviewRun=run.id;state.stage={kind:'status',runId:run.id,run,selection:state.selected};
 $('ap-stage').dataset.status=active?'loading':'error';$('ap-stage-title').textContent=title;$('ap-stage-caption').textContent=active?'Стан підготовки оновлюється автоматично.':'Підготовку зупинено. Ваші посилання й анкор збережено.';
 let settings=$('ap-stage-settings');if(!settings){settings=button('Перевірити підключення OpenAI',openAiSettings);settings.id='ap-stage-settings';$('ap-stage-empty').appendChild(settings);}settings.hidden=active||!needsAiSettings(run);updateStageActions();
 if(!active)showMessage(copy,true);
}
function syncPreparedPreview(){
 if(state.stage?.kind==='run'){const run=state.runs.find(item=>item.id===state.stage.runId);if(run){state.stage.run=run;updateStageActions();}}
 if(!state.selected||state.stageLoading)return;
 const tracked=state.autoPreviewRun?state.runs.find(run=>run.id===state.autoPreviewRun):null;
 const target=tracked?.state==='awaiting_review'?tracked:!state.autoPreviewRun&&!state.stage&&!state.suppressAutoPreview?state.runs.filter(run=>run.state==='awaiting_review').sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))[0]:null;
 if(target){state.autoPreviewRun=null;loadPreparedRun(target.id,{automatic:true});return;}
 const pending=tracked||(!state.stage&&!state.suppressAutoPreview&&state.mode==='ai'?state.runs.slice().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))[0]:null);
 if(pending&&pending.source!=='html'&&pending.stage==='generating'&&!pending.hasHtml&&['queued','running','failed','uncertain','needs_attention','paused'].includes(pending.state))showPreparationState(pending);
}
async function publishPrepared(event){
 const stage=state.stage;if(event?.currentTarget?.id==='ap-preview-publish'&&(state.dialogStage!==stage||$('ap-preview-publish').disabled))return;if(!stage||$('ap-stage-publish').disabled)return;
 if(stage.kind==='draft')return launch({preventDefault(){}});
 const serial=state.stageSerial;state.publishBusy=true;updateStatus();
 try{
  const result=await request('/autopilot/'+stage.runId+'/approve',{reviewToken:stage.reviewToken});
  if(!result.run?.id)throw Error('Сервер не підтвердив публікацію. Повторіть підтвердження цього самого варіанта.');
  if(serial===state.stageSerial){stage.run=result.run;state.runs=[result.run,...state.runs.filter(run=>run.id!==result.run.id)];renderResults();scheduleRefresh();showMessage('Публікацію підтверджено. Наступні кроки виконуватимуться автоматично.');}
  try{await loadResults();}catch{if(serial===state.stageSerial)showMessage('Публікацію підтверджено. Не вдалося оновити стан; перевіряємо зв’язок із сервером.',true);scheduleRefresh();}
 }catch(error){if(serial===state.stageSerial){if(error.code==='REVIEW_REQUIRED')stage.reviewToken=null;showMessage(errorText(error),true);}scheduleRefresh();}
 finally{state.publishBusy=false;updateStatus();}
}

function renderResultsError(error){
 const root=$('ap-results');clear(root);root.removeAttribute('aria-busy');
 const box=el('div','ap-results-error'),retry=button('Повторити завантаження',event=>working(event.currentTarget,()=>loadResults()));
 append(box,el('strong','','Не вдалося завантажити сторінки'),el('p','',errorText(error)),retry);root.appendChild(box);
}
function renderResults(){
 const root=$('ap-results');clear(root);root.removeAttribute('aria-busy');renderOverview();
 if(!state.projects.some(project=>!project.archived)){
  const empty=el('div','ap-empty');append(empty,el('span','ap-empty-symbol','↗'),el('h2','','Перша сторінка починається тут'),el('p','','Створіть проєкт, додайте посилання з анкорами або готовий HTML. PagePoster підготує матеріал і проведе його до публікації.'),button('Створити проєкт',()=>openDialog('ap-project-dialog'),'ap-button ap-primary'));root.appendChild(empty);return;
 }
 const query=$('ap-search').value.trim().toLocaleLowerCase(),filter=$('ap-filter').value;
 const matches=item=>!query||[item.title,item.fullUrl,item.projectName].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
 const runs=state.runs.filter(run=>matches(run)&&(filter==='all'||filter==='active'&&runWorking(run)||filter==='attention'&&!publicationStatus(run.publication)?.working&&(['waiting_source','failed','uncertain','needs_attention'].includes(run.state)||run.state==='paused'&&run.error))).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
 const pages=state.pages.filter(page=>page.fullUrl&&matches(page)&&(filter==='all'||filter==='attention'&&pageVerification(page).state!=='ok'||filter==='verified'&&pageVerification(page).state==='ok'));
 const count=pages.length+runs.length;
 $('ap-library-count').textContent=query||filter!=='all'?'Знайдено: '+count:'Сторінок: '+state.pages.filter(page=>page.fullUrl).length+' · Запусків: '+state.runs.length;
 if(!count&&(query||filter!=='all')){
  const empty=el('div','ap-empty');append(empty,el('h2','','Нічого не знайдено'),el('p','','Спробуйте іншу частину назви, адреси або змініть фільтр.'),button('Скинути фільтри',()=>{$('ap-search').value='';$('ap-filter').value='all';renderResults();$('ap-search').focus();},'ap-button ap-secondary'));root.appendChild(empty);return;
 }
 const current=runs.filter(run=>run.state!=='completed'),completed=runs.filter(run=>run.state==='completed');
 if(current.length){const group=section('Поточні запуски',current.length);current.forEach(run=>group.appendChild(renderRun(run)));root.appendChild(group);}
 if(pages.length||filter==='all'&&!query){
  const group=section('Опубліковані сторінки',pages.length);
  if(pages.length)pages.forEach(page=>group.appendChild(renderPage(page)));
  else{const empty=el('div','ap-empty');append(empty,el('span','ap-empty-symbol','▤'),el('h2','','Тут з’являться ваші сторінки'),el('p','','Після публікації тут будуть повна адреса, результат перевірки й керування посиланнями.'));group.appendChild(empty);}
  root.appendChild(group);
 }
 if(completed.length){const history=el('details','ap-run-history');history.open=!!query||!!state.historyOpen;const summary=el('summary','','Завершені запуски · '+completed.length);history.appendChild(summary);completed.forEach(run=>history.appendChild(renderRun(run)));history.addEventListener('toggle',()=>{state.historyOpen=history.open;});root.appendChild(history);}
}

async function launch(event){
 event.preventDefault();if(state.busy||state.fileBusy||!state.selected)return;if(getPending())restoreDraft();let content;
 if(state.mode==='html'){content=htmlValues();const invalid=htmlError(content),review=currentReview();if(invalid)return showMessage(invalid,true);if(!review?.viewed||(review.warnings.length&&!review.accepted))return showMessage('Перегляньте поточний HTML і підтвердьте зміни перед публікацією.',true);content.reviewToken=review.token;}
 else{const links=Array.from($('ap-link-rows').children).map(row=>({url:row.querySelector('[name=linkUrl]').value.trim(),anchor:row.querySelector('[name=linkAnchor]').value}));if(!links.length||links.some(pair=>!safeUrl(pair.url)||!pair.anchor.trim()))return showMessage('Укажіть повне посилання http/https та анкор у кожному рядку.',true);const editorial=editorialValues();if(editorial.topic==='custom'&&!editorial.customTopic)return showMessage('Введіть власну тему сторінки.',true);content={links,editorial,reviewBeforePublish:true};if(chromeMode()!=='custom')content.chromeMode=chromeMode();}
 const prior=getPending();if(state.pendingReadErrors.has(pendingKey()))return showMessage('Не вдалося прочитати збережений запит. Відновіть доступ до сховища браузера перед запуском.',true);const payload=prior||{idempotencyKey:key(),...content};if(!savePending(payload)){updateStatus();return showMessage('Не вдалося зберегти запит у браузері. Запуск не надіслано. Звільніть сховище й повторіть збережений запит.',true);}saveDraft();
 state.busy=true;updateStatus();showMessage('');const selected=state.selected;if(state.mode==='ai'){clearStage('Готуємо вашу сторінку','ШІ створює тексти й оформлення. Публікація почнеться після вашого підтвердження.');$('ap-stage').dataset.status='loading';}
 try{const result=await request('/projects/'+selected+'/autopilot',payload);if(!result.run?.id)throw Error('Сервер не підтвердив запуск. Повторіть запит із тими самими даними.');savePending(null);if(state.mode==='ai'){state.autoPreviewRun=result.run.id;state.suppressAutoPreview=false;}else if(state.stage?.kind==='draft'){state.stage={...state.stage,kind:'run',runId:result.run.id,run:result.run,reviewToken:null};}state.runs=[result.run,...state.runs.filter(run=>run.id!==result.run.id)];renderResults();syncPreparedPreview();scheduleRefresh();showMessage(state.mode==='ai'?'Підготовку розпочато. Готова сторінка з’явиться в перегляді; публікація чекає вашого рішення.':'Публікацію підтверджено. Наступні кроки виконуватимуться автоматично.');try{await loadResults();}catch{showMessage('Запуск прийнято й збережено. Не вдалося оновити список; перевіряємо зв’язок із сервером.',true);}}
 catch(error){if(error.status&&error.status<500&&error.status!==408)savePending(null);if(error.code==='HTML_REVIEW_REQUIRED'){state.review=null;renderHtmlReview();}showMessage(errorText(error),true);}
 finally{state.busy=false;updateStatus();}
}
async function previewCustomerHtml(){
 if(state.busy||state.fileBusy||state.previewBusy)return;const data=htmlValues(),invalid=htmlError(data);if(invalid)return showMessage(invalid,true,$('ap-html-note'));
 const fingerprint=JSON.stringify(data),cached=currentReview();if(cached?.html){cached.viewed=true;setDraftPreview(cached);renderHtmlReview();updateStatus();return;}
 const serial=++state.previewSerial,selected=state.selected;state.previewBusy=true;updateStatus();showMessage('',false,$('ap-html-note'));
 try{const result=await request('/autopilot/preview',data);if(serial!==state.previewSerial||selected!==state.selected||state.mode!=='html'||fingerprint!==JSON.stringify(htmlValues()))return;
  if(typeof result.html!=='string'||typeof result.reviewToken!=='string'||!result.reviewToken)throw Error('Сервер не підтвердив перегляд. Спробуйте ще раз.');
  state.review={fingerprint,token:result.reviewToken,warnings:Array.isArray(result.warnings)?result.warnings.map(String):[],accepted:false,viewed:true,html:result.html,title:result.title};renderHtmlReview();saveDraft();setDraftPreview(state.review);
 }catch(error){if(serial===state.previewSerial)showMessage(errorText(error),true,$('ap-html-note'));}
 finally{if(serial===state.previewSerial){state.previewBusy=false;updateStatus();}}
}
async function readHtmlFile(){
 const files=Array.from($('ap-html-file').files);if(!files.length||state.busy||state.publishBusy)return;const serial=++state.fileSerial,selected=state.selected;state.fileBusy=true;htmlChanged(false);
 try{if(files.length===1&&/\.html?$/i.test(files[0].name)&&files[0].size>htmlLimit)throw Error(htmlLimitMessage);if(!window.PagePosterHTMLPackage)throw Error('Імпорт файлів недоступний. Перезапустіть PagePoster після оновлення.');const bundle=await window.PagePosterHTMLPackage.prepareFiles(files),value=bundle.html;if(serial!==state.fileSerial||selected!==state.selected||state.mode!=='html'||state.busy||state.publishBusy)return;if(new TextEncoder().encode(value).byteLength>htmlLimit)throw Error(htmlLimitMessage);$('ap-launch-form').elements.customerHtml.value=value;state.fileBusy=false;htmlChanged(false);if(bundle.assetCount||bundle.warnings?.length)showMessage(bundle.assetCount?'HTML завантажено разом із ресурсами: '+bundle.assetCount+'. Зображення й шрифти включено в сторінку.':bundle.warnings.join(' '),false,$('ap-html-note'));}
 catch(error){if(serial===state.fileSerial)showMessage(error instanceof TypeError?'Не вдалося прочитати файл. Збережіть HTML у кодуванні UTF-8.':errorText(error),true,$('ap-html-note'));}
 finally{if(serial===state.fileSerial){state.fileBusy=false;$('ap-html-file').value='';updateStatus();}}
}
async function checkPages(event){
 const control=event.currentTarget;await working(control,async()=>{const result=await request(state.selected?'/projects/'+state.selected+'/check-pages':'/check-pages',{});
 showMessage(result.queued?'Перевірку запущено. Результати з’являться біля сторінок.':result.reused?'Перевірка вже виконується. Повторні завдання не створено.':'Немає опублікованих сторінок, доступних для перевірки.',!!result.failed);
 trackJobs(result.jobs);await loadResults();
 });
}
const sourceColumns=[['columnUrl','url','B'],['columnUsername','username','K'],['columnPassword','password','L'],['columnAlternateUsername','alternateUsername','N'],['columnAlternatePassword','alternatePassword','O'],['columnDr','dr','D'],['columnTraffic','traffic','E'],['columnGeo','geo','F'],['columnEnabled','enabled','']];
function spreadsheetId(value){
 const text=value.trim();if(/^[A-Za-z0-9_-]{10,200}$/.test(text))return text;
 try{const url=new URL(text),match=/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/.exec(url.pathname);if(url.protocol==='https:'&&url.hostname==='docs.google.com'&&match)return match[1];}catch{}
 throw Error('Вставте ID або повне посилання Google Таблиці.');
}
function sourceValues(){
 const form=$('ap-source-form'),columns={};for(const [field,key] of sourceColumns){const value=form.elements[field]?.value.trim().toUpperCase();if(value)columns[key]=value;}
 const headerRows=Number(form.elements.headerRows?.value??1);if(!Number.isSafeInteger(headerRows)||headerRows<0||headerRows>20)throw Error('Кількість рядків заголовка має бути цілим числом від 0 до 20.');
 const reference=form.elements.spreadsheetId.value.trim();spreadsheetId(reference);
 return {...(/^https:\/\//i.test(reference)?{spreadsheetUrl:reference}:{spreadsheetId:reference}),...(form.elements.sheetRange.value.trim()?{range:form.elements.sheetRange.value.trim()}:{}),headerRows,columns,authMode:form.elements.authMode?.value||'user'};
}
function sourceFingerprint(source){const columns={};for(const [,key] of sourceColumns)if(source.columns?.[key])columns[key]=source.columns[key];let id=source.spreadsheetId||'',sheetId=source.sheetId??null;if(source.spreadsheetUrl){try{const url=new URL(source.spreadsheetUrl);id=spreadsheetId(source.spreadsheetUrl);const raw=url.searchParams.get('gid')??new URLSearchParams(url.hash.slice(1)).get('gid');if(raw!==null)sheetId=Number(raw);}catch{}}const rank=value=>[...value].reduce((total,c)=>total*26+c.charCodeAt(0)-64,0),mapped=Object.values(columns).sort((a,b)=>rank(a)-rank(b));return JSON.stringify({spreadsheetId:id,sheetId,range:source.range||(mapped.length?mapped[0]+':'+mapped.at(-1):''),headerRows:source.headerRows??1,columns,authMode:source.authMode||'service'});}
function sourceControls(){const form=$('ap-source-form'),submit=form.querySelector('button[type=submit]');submit.disabled=state.sourceBusy||state.restartRequired;if(window.pageposterDesktop){let dirty=true;try{dirty=sourceFingerprint(sourceValues())!==sourceFingerprint(state.status?.source||{})||form.elements.authMode.value==='service'&&!!form.elements.serviceAccount.value.trim();}catch{}submit.hidden=!dirty&&!state.sourceBusy;}if($('ap-source-check'))$('ap-source-check').disabled=state.sourceBusy||state.restartRequired;}
function exclusionDate(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return '';return new Date(value).toLocaleString('uk-UA');}
function exclusionDescription(item){
 const type={manual:'Ручна заборона',cooldown:'Тимчасова відмова',transient:'Тимчасова відмова',credentialrestriction:'Обмеження даних для входу',credentials:'Обмеження даних для входу',auth:'Обмеження даних для входу',visual:'Обмеження для цього матеріалу й донора',security:'Обмеження безпеки',advisory:'Зауваження до можливостей донора',plugin:'Зауваження до можливостей донора',legacy:'Історичне обмеження: потрібен перегляд'}[item.type]||'Обмеження підбору',expiry=exclusionDate(item.expiresAt),released=exclusionDate(item.releasedAt);
 return [type,typeof item.reason==='string'?item.reason:'',released?'Знято: '+released:item.active===false?'Строк минув'+(expiry?': '+expiry:''):expiry?(['advisory','plugin'].includes(item.type)?'Зауваження чинне до ':'Тимчасово недоступний до ')+expiry:item.type==='manual'?'До явного зняття':'',item.legacy&&item.type!=='legacy'?'Історичний запис: потрібен перегляд':''].filter(Boolean).join(' · ');
}
function currentExclusions(session){return !!session&&state.exclusionsSession===session&&session.selection===state.selected&&$('ap-exclusions')?.open&&!state.restartRequired;}
function invalidateExclusions(){const session=state.exclusionsSession;if(session){clearTimeout(session.searchTimer);session.serial++;}state.exclusionsSession=null;if($('ap-exclusions-list')){clear($('ap-exclusions-list'));$('ap-exclusions-list').setAttribute('aria-busy','false');$('ap-exclusions-count').textContent='';}}
function exclusionsControls(session){
 if(!currentExclusions(session))return;const data=session.list,busy=session.busy;
 for(const id of ['ap-exclusions-origin','ap-exclusions-search','ap-exclusions-state'])$(id).disabled=busy;
 $('ap-exclusions-form').querySelector('button').disabled=busy||session.loading||!data;
 $('ap-exclusions-refresh').disabled=busy||session.loading;
 $('ap-exclusions-prev').disabled=busy||session.loading||!data||data.offset===0;
 $('ap-exclusions-next').disabled=busy||session.loading||!data||data.offset+data.limit>=data.total;
 $('ap-exclusions-list').setAttribute('aria-busy',String(!!session.loading));
 for(const control of $('ap-exclusions-list').querySelectorAll('button'))control.disabled=busy||session.loading;
}
function renderExclusions(session){
 if(!currentExclusions(session))return;const root=$('ap-exclusions-list'),data=session.list;clear(root);$('ap-exclusions-count').textContent='';
 if(!data){root.appendChild(el('p','ap-donor-empty',session.loading?'Завантажуємо стоп-лист…':'Оновіть список, щоб переглянути обмеження.'));exclusionsControls(session);return;}
 if(!data.items.length)root.appendChild(el('p','ap-donor-empty','За цим пошуком обмежень немає.'));
 for(const item of data.items){
  const row=el('article','ap-donor-row'),description=el('div','ap-donor-description');let origin='Некоректний домен';try{const url=new URL(item.origin);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)origin=url.origin;}catch{}
  description.appendChild(el('strong','ap-donor-domain',origin));description.appendChild(el('p','ap-donor-reason',exclusionDescription(item)));row.appendChild(description);
  if(item.active===true&&item.canRelease===true&&typeof item.id==='string'&&Number.isSafeInteger(item.revision)&&item.revision>=0){const release=button('Повернути до підбору',()=>changeExclusion(session,'release',{id:item.id,expectedRevision:item.revision}));release.setAttribute('aria-label','Повернути до підбору');row.appendChild(release);}
  root.appendChild(row);
 }
 $('ap-exclusions-count').textContent=data.items.length?'Показано '+(data.offset+1)+'–'+(data.offset+data.items.length)+' із '+data.total:'Знайдено: '+data.total;exclusionsControls(session);
}
async function loadExclusions(session,offset=0,preserveNote=false){
 if(!currentExclusions(session)||session.busy)return;clearTimeout(session.searchTimer);const serial=++session.serial;session.loading=true;session.list=null;if(!preserveNote)showMessage('',false,$('ap-exclusions-note'));renderExclusions(session);
 const query=new URLSearchParams({search:$('ap-exclusions-search').value.trim(),offset:String(offset),limit:'30',state:$('ap-exclusions-state').value});
 try{const result=await request('/autopilot/donor-exclusions?'+query);if(!currentExclusions(session)||serial!==session.serial)return;
  if(!Array.isArray(result.items)||result.items.some(item=>!item||typeof item!=='object'||typeof item.origin!=='string')||!Number.isSafeInteger(result.total)||result.total<0||result.offset!==offset||!Number.isSafeInteger(result.limit)||result.limit<1||result.limit>100||result.items.length>result.limit)throw Error('Invalid exclusion list');session.list=result;
 }catch{if(currentExclusions(session)&&serial===session.serial)showMessage('Не вдалося прочитати стоп-лист. Оновіть список перед зміною обмежень.',true,$('ap-exclusions-note'));}
 finally{if(currentExclusions(session)&&serial===session.serial){session.loading=false;renderExclusions(session);}}
}
function openExclusions(){
 if(state.restartRequired||!$('ap-exclusions'))return;invalidateExclusions();const session={selection:state.selected,serial:0,list:null,busy:false,loading:false};state.exclusionsSession=session;$('ap-exclusions-form').reset();$('ap-exclusions-search').value='';$('ap-exclusions-state').value='active';showMessage('',false,$('ap-exclusions-note'));openDialog('ap-exclusions');loadExclusions(session);
}
function exclusionOrigin(value){try{const url=new URL(value.includes('://')?value:'https://'+value);return url.username||url.password?'':url.origin;}catch{return '';}}
async function banExclusion(event){
 event.preventDefault();const session=state.exclusionsSession;if(!currentExclusions(session)||session.busy||session.loading||!session.list)return;const origin=$('ap-exclusions-origin').value.trim();if(!origin)return;const normalized=exclusionOrigin(origin),known=session.list.items.find(item=>item.type==='manual'&&exclusionOrigin(item.origin)===normalized);
 await changeExclusion(session,'ban',{origin,expectedRevision:Number.isSafeInteger(known?.revision)?known.revision:0});
}
async function changeExclusion(session,action,body){
 if(!currentExclusions(session)||session.busy||session.loading)return;session.busy=true;clearTimeout(session.searchTimer);session.serial++;exclusionsControls(session);let failed=false;
 try{await request('/autopilot/donor-exclusions/'+action,body);if(!currentExclusions(session))return;
  if(action==='ban')$('ap-exclusions-origin').value='';showMessage(action==='ban'?'Ручну заборону збережено для всіх проєктів.':'Обмеження знято. Інші обмеження та зайняті, опубліковані й невизначені резерви зберігаються.',false,$('ap-exclusions-note'));
 }catch(error){if(!currentExclusions(session))return;failed=true;
  if(error.status===409){if(action==='ban'){$('ap-exclusions-search').value=exclusionOrigin(body.origin).slice(0,200);$('ap-exclusions-state').value='all';}showMessage('Стоп-лист змінився. Перегляньте оновлений стан і повторіть потрібну дію. Зміну повторно не надсилали.',true,$('ap-exclusions-note'));}
  else showMessage(error.status===400?'Перевірте домен і оновлений список перед повторною дією.':'Не вдалося підтвердити зміну. Перевірте оновлений стан перед наступною дією.',true,$('ap-exclusions-note'));
 }finally{if(currentExclusions(session)){session.busy=false;await loadExclusions(session,0,true);if(!failed)window.dispatchEvent(new CustomEvent('pageposter:queue-updated'));}}
}
function scheduleExclusionsSearch(){const session=state.exclusionsSession;if(!currentExclusions(session)||session.busy)return;clearTimeout(session.searchTimer);session.serial++;session.list=null;session.loading=true;renderExclusions(session);session.searchTimer=setTimeout(()=>loadExclusions(session,0),300);}
async function openSettings(){
 const buildIdentity=$('ap-build-identity');
 if(buildIdentity&&window.pageposterDesktop?.info)window.pageposterDesktop.info().then(({version,buildId})=>{
  buildIdentity.textContent=buildId?'Збірка '+version+' · '+buildId:'Версія '+version;
  buildIdentity.hidden=false;
 }).catch(()=>{});
 $('ap-browser-mode').value=state.status?.browserMode||'visible';
 if(window.pageposterDesktop)$('ap-browser-form').querySelector('button').hidden=true;
 state.settingsSerial++;const source=state.status?.source||{},form=$('ap-source-form'),saved=!!source.spreadsheetId||!!source.range||!!source.configured;form.elements.spreadsheetId.value=source.spreadsheetUrl||(source.spreadsheetId?'https://docs.google.com/spreadsheets/d/'+source.spreadsheetId+'/edit'+(source.sheetId!==undefined&&source.sheetId!==null?'#gid='+source.sheetId:''):source.id||'');form.elements.sheetRange.value=source.range||'';
 for(const [fieldName,keyName,fallback] of sourceColumns)if(form.elements[fieldName])form.elements[fieldName].value=saved?(source.columns?.[keyName]||''):fallback;
 if(form.elements.headerRows)form.elements.headerRows.value=source.headerRows??1;
 const sourceMode=source.authMode==='service'||!source.authMode&&saved?'service':'user';if(form.elements.authMode)form.elements.authMode.value=sourceMode;form.elements.serviceAccount.value='';$('ap-key-form').elements.apiKey.value='';showMessage('',false,$('ap-settings-note'));sourceControls();openDialog('ap-settings');window.dispatchEvent(new CustomEvent('pageposter:settings-opened',{detail:{source:{...source,authMode:sourceMode}}}));
}
function renderSiteSelection(project=state.projects.find(item=>item.id===state.selected)){
 const control=$('ap-site-selection-open'),summary=$('ap-site-selection-summary');if(control)control.hidden=!project;if(!summary)return;summary.hidden=!project;if(!project)return;
 const selection=project.siteSelection||{},parts=[];if(selection.minDr!==null&&selection.minDr!==undefined)parts.push('DR ≥ '+selection.minDr);if(selection.minTraffic!==null&&selection.minTraffic!==undefined)parts.push('Трафік ≥ '+selection.minTraffic);if(selection.geo)parts.push('Гео: '+selection.geo.split(',').join(', '));summary.textContent=(parts.join(' · ')||'Без обмежень за DR, трафіком і GEO')+'. Правила для наступних запусків.';
}
function openSiteSelection(){
 const project=state.projects.find(item=>item.id===state.selected);if(!project)return;const form=$('ap-site-selection-form'),selection=project.siteSelection||{};state.selectionSession={id:project.id,revision:project.revision};form.elements.minDr.value=selection.minDr??'';form.elements.minTraffic.value=selection.minTraffic??'';form.elements.geo.value=selection.geo||'';showMessage('',false,$('ap-site-selection-note'));openDialog('ap-site-selection');
}
async function saveSiteSelection(event){
 event.preventDefault();const session=state.selectionSession;if(!session)return;const form=event.currentTarget,control=form.querySelector('button[type=submit]');if(control.disabled)return;control.disabled=true;
 try{
  const number=name=>form.elements[name].value.trim()===''?null:Number(form.elements[name].value),minDr=number('minDr'),minTraffic=number('minTraffic'),geo=form.elements.geo.value.trim().toUpperCase().split(',').map(value=>value.trim()).filter(Boolean);
  if(minDr!==null&&(!Number.isFinite(minDr)||minDr<0||minDr>100)||minTraffic!==null&&(!Number.isSafeInteger(minTraffic)||minTraffic<0)||geo.some(value=>!/^[A-Z]{2}$/.test(value)))throw Error('Перевірте DR (0–100), цілий трафік і дволітерні коди країн через кому.');
  const result=await request('/projects/'+session.id,{expectedRevision:session.revision,siteSelection:{minDr,minTraffic,geo:[...new Set(geo)].join(',')}},'PATCH');if(!result.project?.id)throw Error('Сервер не підтвердив збереження правил.');state.projects=state.projects.map(project=>project.id===result.project.id?result.project:project);renderSiteSelection();
  if(state.selectionSession===session){session.revision=result.project.revision;showMessage('Правила збережено для наступних запусків проєкту. Уже розпочаті запуски зберігають попередні вимоги.',false,$('ap-site-selection-note'));}
 }catch(error){if(state.selectionSession===session)showMessage(errorText(error),true,$('ap-site-selection-note'));}finally{control.disabled=state.restartRequired;}
}
async function saveSource(event){
 event.preventDefault();if(state.sourceBusy)return;const form=event.currentTarget,serial=state.settingsSerial,submittedId=form.elements.spreadsheetId.value,accountText=form.elements.serviceAccount.value.trim();state.sourceBusy=true;sourceControls();
 try{
  const config=sourceValues();if(accountText&&config.authMode==='service')try{config.serviceAccount=JSON.parse(accountText);}catch{throw Error('Не вдалося прочитати JSON сервісного акаунта. Вставте файл повністю.');}
  const result=await request('/autopilot/source',config);if(!result.source)throw Error('Сервер не підтвердив збереження бази.');state.status={...state.status,source:result.source};updateStatus();
  if(serial===state.settingsSerial){if(form.elements.serviceAccount.value.trim()===accountText)form.elements.serviceAccount.value='';if(form.elements.spreadsheetId.value===submittedId)form.elements.spreadsheetId.value=result.source.spreadsheetUrl||'https://docs.google.com/spreadsheets/d/'+result.source.spreadsheetId+'/edit';showMessage(result.source.configured?'Налаштування бази сайтів збережено.':'Налаштування бази сайтів збережено. Підключіть вибраний акаунт Google й перевірте підбір.',false,$('ap-settings-note'));window.dispatchEvent(new CustomEvent('pageposter:settings-opened',{detail:{source:result.source}}));}
  await loadResults();
 }catch(error){if(serial===state.settingsSerial)showMessage(errorText(error),true,$('ap-settings-note'));}finally{state.sourceBusy=false;sourceControls();}
}
window.addEventListener('pageposter:google-account-prepare',async event=>{
 const {resolve,reject}=event.detail||{};if(typeof resolve!=='function'||typeof reject!=='function')return;
 if(state.sourceBusy||state.restartRequired)return reject(Error('Дочекайтеся збереження налаштувань і повторіть вхід.'));
 const form=$('ap-source-form'),reference=form.elements.spreadsheetId.value,serial=state.settingsSerial;state.sourceBusy=true;sourceControls();
 if(!reference.trim()){state.sourceBusy=false;sourceControls();resolve({projectId:state.selected});return;}
 try{const config={...sourceValues(),authMode:'user'};let url;try{url=new URL(config.spreadsheetUrl);}catch{throw Error('Вставте повне посилання на потрібну вкладку Google Таблиці.');}if(!(url.searchParams.has('gid')||new URLSearchParams(url.hash.slice(1)).has('gid')))throw Error('Скопіюйте адресу відкритої вкладки Google Таблиці повністю, разом із gid.');const fingerprint=sourceFingerprint(config),result=await request('/autopilot/source',config);if(!result.source?.spreadsheetUrl)throw Error('Сервер не підтвердив вибрану вкладку.');state.status={...state.status,source:result.source};updateStatus();if(serial!==state.settingsSerial||reference!==form.elements.spreadsheetId.value||fingerprint!==sourceFingerprint(sourceValues()))throw Error('Посилання або налаштування змінилися. Натисніть «Увійти через Google» ще раз.');form.elements.spreadsheetId.value=result.source.spreadsheetUrl;resolve({...result.source,projectId:state.selected});}
 catch(error){reject(error);}finally{state.sourceBusy=false;sourceControls();}
});
async function checkSource({googleVerification=false}={}){
 if(state.sourceBusy){if(googleVerification)throw Error('Дочекайтеся збереження налаштувань і повторіть перевірку таблиці.');return;}const serial=state.settingsSerial,projectId=state.selected;let fingerprint;
 try{const values=sourceValues();fingerprint=sourceFingerprint(values);if(values.authMode==='service'&&$('ap-source-form').elements.serviceAccount.value.trim()||fingerprint!==sourceFingerprint(state.status?.source||{}))throw Error('Спочатку збережіть зміни бази, потім перевірте підбір.');}
 catch(error){showMessage(errorText(error),true,$('ap-settings-note'));if(googleVerification)throw error;return;}
 state.sourceBusy=true;sourceControls();showMessage('Перевіряємо збережену базу й правила підбору…',false,$('ap-settings-note'));
 try{
  const result=await request('/autopilot/source/check',projectId?{projectId}:{});if(serial!==state.settingsSerial||projectId!==state.selected||fingerprint!==sourceFingerprint(sourceValues())){if(googleVerification)throw Error('Посилання або налаштування змінилися. Збережіть їх і повторіть перевірку.');return;}
  if(!Number.isSafeInteger(result.candidateCount)||result.candidateCount<0||!Number.isSafeInteger(result.issueCount)||result.issueCount<0||!Array.isArray(result.sample))throw Error('Сервер не підтвердив результат перевірки бази.');
  const details=result.sample.slice(0,5).map(site=>String(site.domain||'')+' · DR: '+(Number.isFinite(site.dr)?site.dr:'—')+' · трафік: '+(Number.isFinite(site.traffic)?site.traffic:'—')+' · гео: '+(Array.isArray(site.geo)?site.geo.map(String).join(', '):'—'));
  const groups=Array.isArray(result.groups)?result.groups:[];
  for(const group of groups)if(group.criteria&&['pages','selected','eligible','available'].every(key=>Number.isSafeInteger(group[key])&&group[key]>=0))details.push((group.criteria.geo||'Будь-яке гео')+': сторінок '+group.pages+', підібрано '+group.selected+', підходить '+group.eligible+', вільно '+group.available+' (DR '+(group.criteria.minDr==null?'будь-який':'від '+group.criteria.minDr)+', трафік '+(group.criteria.minTraffic==null?'будь-який':'від '+group.criteria.minTraffic)+')');
  showMessage('Придатних сайтів: '+result.candidateCount+'. Зауважень до даних: '+result.issueCount+'.'+(details.length?' '+details.join('; '):' Перевірте вимоги проєкту й дані таблиці.'),false,$('ap-settings-note'));
  return result;
 }catch(error){if(serial===state.settingsSerial)showMessage(errorText(error),true,$('ap-settings-note'));if(googleVerification)throw error;}finally{state.sourceBusy=false;sourceControls();}
}
window.addEventListener('pageposter:google-source-verify',event=>{const {resolve,reject}=event.detail||{};if(typeof resolve==='function'&&typeof reject==='function')checkSource({googleVerification:true}).then(resolve,reject);});
function showPreview(html){
 state.html=html;state.dialogStage=state.stage;openDialog('ap-preview');mountPreview('ap-preview-frame',html);previewSize(state.stageMobile);updateStageActions();
}
async function preview(id){await loadPreparedRun(id);}

let manualExportSession=null,manualExportSerial=0;
function invalidateManualExport(){manualExportSerial++;manualExportSession=null;const dialog=$('ap-manual-export');if(!dialog)return;$('ap-manual-html').value='';$('ap-manual-title').value='';for(const id of ['ap-manual-copy-title','ap-manual-copy-html','ap-manual-download','ap-manual-variant'])$(id).disabled=true;if(dialog.open)dialog.close();}
function manualCurrent(session){return manualExportSession===session&&!state.restartRequired&&$('ap-manual-export').open&&session.isCurrent();}
function manualControls(session){const disabled=!manualCurrent(session)||session.busy||!session.result?.html;for(const id of ['ap-manual-copy-title','ap-manual-copy-html','ap-manual-download'])$(id).disabled=disabled;$('ap-manual-variant').disabled=session.busy||!manualCurrent(session)||!session.result?.available;}
async function loadManualVariant(session,variant){
 if(!manualCurrent(session)||session.busy)return;const serial=++manualExportSerial;session.busy=true;session.result=null;$('ap-manual-html').value='';manualControls(session);showMessage('Готуємо обраний варіант…',false,$('ap-manual-note'));
 try{const result=await session.load(variant);if(serial!==manualExportSerial||!manualCurrent(session))return;if(result.version!==1||result.variant!==variant||typeof result.html!=='string'||!result.html||session.runId!==undefined&&result.runId!==session.runId||session.pageId&&result.pageId!==session.pageId||Number.isSafeInteger(session.pageRevision)&&result.pageRevision!==session.pageRevision)throw Error('Сервер не підтвердив цей варіант HTML.');const binding=JSON.stringify([result.runId,result.pageId,result.pageRevision]);if(session.binding&&session.binding!==binding)throw Error('Сторінка змінилась. Відкрийте ручний експорт ще раз.');session.binding=binding;session.result=result;
  $('ap-manual-variant').value=variant;for(const option of $('ap-manual-variant').options)option.disabled=result.available?.[option.value]!==true;$('ap-manual-title').value=result.title||'';$('ap-manual-html').value=result.html;
  const audit=$('ap-manual-audit');clear(audit);audit.appendChild(el('strong','',result.audit?.state==='needs_review'?'Аудит заглушок: потрібна перевірка':'Аудит заглушок: '+(result.audit?.placeholderCount||0)+' знайдено'));for(const item of result.audit?.placeholders||[])audit.appendChild(el('p','ap-fine',[item.attribute,item.url,item.label].filter(Boolean).join(' · ')));for(const warning of result.warnings||[])if(warning?.message)audit.appendChild(el('p','ap-fine',warning.message));
  const steps=$('ap-manual-steps');clear(steps);for(const step of result.steps||[])steps.appendChild(el('li','',step));showMessage(variant==='simplified'?'Спрощений варіант створено лише для цього експорту. Перевірте вигляд і динамічні елементи перед вставленням.':'Копіювання та завантаження використовують обраний варіант. Публікація потребує окремого запуску.',false,$('ap-manual-note'));
 }catch(error){if(serial===manualExportSerial&&manualCurrent(session))showMessage(errorText(error),true,$('ap-manual-note'));}
 finally{if(manualExportSession===session){session.busy=false;manualControls(session);}}
}
function openManualExport(options){
 if(state.restartRequired||!options?.isCurrent?.())return;invalidateManualExport();const session={...options,busy:false,result:null,binding:null};manualExportSession=session;$('ap-manual-variant').value='prepared';$('ap-manual-audit').replaceChildren();$('ap-manual-steps').replaceChildren();openDialog('ap-manual-export');void loadManualVariant(session,'prepared');
}
function openStageManualExport(){
 const stage=state.stage,selection=state.selected,serial=state.stageSerial;if(!stage?.html||state.stageLoading||stage.selection!==selection)return;
 const runBinding=stage.kind==='run'?JSON.stringify(stage.run):null,isCurrent=()=>state.stage===stage&&state.stageSerial===serial&&state.selected===selection&&!state.stageLoading&&(stage.kind!=='run'||JSON.stringify(state.runs.find(run=>run.id===stage.runId))===runBinding);
 if(stage.kind==='draft'){const review=currentReview(),data=htmlValues();if(!review?.token||stage.fingerprint!==review.fingerprint)return;const body={...data,reviewToken:review.token};openManualExport({runId:null,isCurrent:()=>isCurrent()&&currentReview()===review&&JSON.stringify(htmlValues())===review.fingerprint,load:variant=>request('/autopilot/manual-export',{...body,variant})});}
 else if(stage.kind==='run'&&stage.runId)openManualExport({runId:stage.runId,pageId:stage.run?.pageId,pageRevision:stage.run?.pageRevision,isCurrent,load:variant=>request('/autopilot/'+encodeURIComponent(stage.runId)+'/manual-export?variant='+variant)});
}
function installManualExport(){
 const dialog=el('dialog','ap-dialog ap-manual-export');dialog.id='ap-manual-export';dialog.setAttribute('aria-labelledby','ap-manual-heading');dialog.innerHTML='<div class="ap-dialog-heading"><h2 id="ap-manual-heading">Ручне розміщення у WordPress</h2><button id="ap-manual-close" class="ap-icon" type="button" aria-label="Закрити ручний експорт">×</button></div><p class="ap-muted">Оригінал — початковий матеріал; підготовлений — поточний HTML для WordPress. Спрощення доступне лише за явним вибором і потребує перевірки вигляду.</p><label class="ap-field">Варіант HTML<select id="ap-manual-variant"><option value="original">Оригінальний HTML</option><option value="prepared">Підготовлений HTML</option><option value="simplified">Спрощений HTML без скриптів</option></select></label><label class="ap-field">Назва сторінки<input id="ap-manual-title" readonly></label><div class="pq-actions"><button id="ap-manual-copy-title" class="ap-button ap-secondary" type="button">Копіювати назву</button><button id="ap-manual-copy-html" class="ap-button ap-secondary" type="button">Копіювати обраний HTML</button><button id="ap-manual-download" class="ap-button ap-secondary" type="button">Завантажити обраний HTML</button></div><div id="ap-manual-note" class="ap-notice" role="status" aria-live="polite"></div><label class="ap-field">HTML обраного варіанта<textarea id="ap-manual-html" readonly spellcheck="false" rows="10"></textarea></label><div id="ap-manual-audit" data-manual-audit></div><ol id="ap-manual-steps"></ol>';document.body.appendChild(dialog);
 $('ap-manual-close').addEventListener('click',invalidateManualExport);dialog.addEventListener('close',()=>{if(manualExportSession)invalidateManualExport();});$('ap-manual-variant').addEventListener('change',()=>{if(manualExportSession)void loadManualVariant(manualExportSession,$('ap-manual-variant').value);});
 for(const [id,field] of [['ap-manual-copy-title','ap-manual-title'],['ap-manual-copy-html','ap-manual-html']])$(id).addEventListener('click',async()=>{const session=manualExportSession;if(!session?.result||!manualCurrent(session)||session.busy)return;try{await navigator.clipboard.writeText(field==='ap-manual-title'?session.result.title:session.result.html);if(manualCurrent(session))showMessage(field==='ap-manual-title'?'Назву скопійовано.':'Обраний HTML скопійовано.',false,$('ap-manual-note'));}catch{if(manualCurrent(session)){$(field).focus();$(field).select();showMessage('Текст виділено. Натисніть Ctrl+C.',false,$('ap-manual-note'));}}});
 $('ap-manual-download').addEventListener('click',()=>{const session=manualExportSession;if(!session?.result||!manualCurrent(session)||session.busy)return;const value=session.result,url=URL.createObjectURL(new Blob([value.html],{type:'text/html;charset=utf-8'})),anchor=el('a');anchor.href=url;anchor.download=value.filename||'pageposter-'+value.variant+'.html';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),3000);});
 for(const [before,id] of [['ap-stage-copy','ap-stage-manual-export'],['ap-copy-html','ap-preview-manual-export']]){const control=button('Ручне розміщення',openStageManualExport);control.id=id;control.disabled=true;$(before).after(control);}
 window.PagePosterManualExport=Object.freeze({open:({runId,pageId,pageRevision,isCurrent})=>{if(runId)openManualExport({runId,pageId,pageRevision,isCurrent,load:variant=>request('/autopilot/'+encodeURIComponent(runId)+'/manual-export?variant='+variant)});},invalidate:()=>{if(manualExportSession&&!manualExportSession.isCurrent())invalidateManualExport();}});
 window.addEventListener('pageposter:inspector-invalidated',()=>window.PagePosterManualExport.invalidate());window.addEventListener('pageposter:recovery-restored',invalidateManualExport);
}

async function copyReadyHTML(html,control){
 if(typeof html!=='string'||!html.length)throw Error('HTML ще не готовий. Дочекайтеся завершення підготовки.');
 try{
  if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
  await navigator.clipboard.writeText(html);
  control.textContent='Скопійовано';setTimeout(()=>{if(control.isConnected)control.textContent='Копіювати HTML';},1800);
  const message='Готовий HTML скопійовано. Вставте його в блок «Власний HTML» у WordPress.';
  showMessage(message);$('ap-stage-status').textContent=message;$('ap-preview-note').textContent=message;
 }catch{
  const code=$('ap-ready-html');code.value=html;openDialog('ap-html-code');code.focus();code.select();
 }
}
async function copyRunHTML(id,control){
 const selection=state.selected,serial=state.stageSerial;
 const result=await request('/autopilot/'+id+'/html');
 if(selection!==state.selected||serial!==state.stageSerial||!state.runs.some(run=>run.id===id))return;
 await copyReadyHTML(result.html,control);
}
async function copyStageHTML(control){
 const stage=state.stage;
 if(!stage?.html||state.stageLoading||stage.selection!==state.selected||control.id==='ap-copy-html'&&state.dialogStage!==stage)return;
 await copyReadyHTML(stage.html,control);
}
function downloadHtml(){if(!state.html)return;const url=URL.createObjectURL(new Blob([state.html],{type:'text/html;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='PagePoster-page.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
const replacementStorageKey='pageposter.native-replacements.v1',replacementLocks=new Map();
try{const saved=JSON.parse(sessionStorage.getItem(replacementStorageKey)||'{}');for(const [id,value] of Object.entries(saved))if(value&&value.mode==='native')replacementLocks.set(id,value);}catch{}
function saveReplacementLocks(){try{sessionStorage.setItem(replacementStorageKey,JSON.stringify(Object.fromEntries(replacementLocks)));return true;}catch{return false;}}
function invalidateReplacement(){for(const input of $('ap-replacement').querySelectorAll('input[type=password]'))input.value='';state.replacement=null;state.replacementSerial++;}
function currentReplacement(session,mutation=false){return state.replacement===session&&state.replacementSerial===session.serial&&$('ap-replacement').open&&session.isCurrent({accepted:!mutation&&session.acceptedNative===true,revision:session.pageRevision});}
function nativeReplacementReason(capability){const messages={NATIVE_ACCESS_REQUIRED:'Потрібний звичайний логін WordPress для цієї сторінки.',NATIVE_BROWSER_REQUIRED:'Для заміни потрібна настільна версія PagePoster і звичайний логін WordPress.',NATIVE_SNAPSHOT_UNAVAILABLE:'Немає підтвердженої копії опублікованої сторінки. Заміна недоступна.',NATIVE_BINDING_UNAVAILABLE:'Не підтверджено прив’язку до цієї сторінки WordPress. Заміна недоступна.',NATIVE_SOURCE_UNAVAILABLE:'Не підтверджено джерело сторінки. Заміна недоступна.',NATIVE_UPDATE_PENDING:'Попередня заміна ще не підтверджена. Спочатку звірте результат.',disabled:'Цей сайт вимкнено. Заміна недоступна.'};return messages[capability?.reason]||'Заміна для цієї сторінки зараз недоступна. Оновіть її стан.';}
function nativeComparison(parent,comparison,uncertain=false){if(!comparison)return;const box=el('section','ap-diff');box.dataset.nativeComparison='true';box.appendChild(el('h3','',uncertain?'Порівняння стану WordPress':'WordPress змінився — запис зупинено'));for(const [name,value] of [['Погоджено',comparison.expected],['Зараз у WordPress',comparison.actual],['Підготовлено',comparison.proposed]])if(value){box.appendChild(el('strong','',name));for(const [key,label] of [['title','Заголовок'],['status','Стан'],['contentHash','Хеш вмісту']])if(typeof value[key]==='string')box.appendChild(el('p','ap-exact-url',label+': '+value[key]));}parent.appendChild(box);}
function replacementHeading(root,session){append(root,el('h3','',session.title||'Опублікована сторінка'),el('p','ap-muted','WP ID: '+session.wpId+' · '+(session.fullUrl||'')));}
async function readReplacementStatus(session,reconcile=false){
 if(!currentReplacement(session))return;
 if(reconcile){const jobId=session.update?.jobId||session.capability?.jobId||replacementLocks.get(session.pageId)?.jobId;if(!jobId)return;await request('/jobs/'+encodeURIComponent(jobId)+'/reconcile',{});}
 let result;try{result=await request('/pages/'+encodeURIComponent(session.pageId)+'/replacement-status');}catch(error){if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);}throw error;}if(!currentReplacement(session))return;
 session.capability=result.replacement||session.capability;session.update=result.update||null;session.statusReadFailed=false;
 const lock=replacementLocks.get(session.pageId),update=session.update;
 if(lock||session.capability?.jobId||update&&['queued','running','uncertain','checking','waiting_manual'].includes(update.state))session.acceptedNative=true;
 if(lock?.checkPending&&lock.checkJobId&&update?.state!=='completed'){
  let check;try{const result=await request('/projects/'+encodeURIComponent(session.projectId)+'/jobs'),found=(result.jobs||[]).find(job=>job.id===lock.checkJobId&&job.pageId===session.pageId&&job.type==='page_check');check=found?{id:found.id,state:found.state}:null;}catch(error){if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);}throw error;}if(!currentReplacement(session))return;
  if(check&&['completed','failed','uncertain'].includes(check.state)){lock.checkPending=false;lock.checkJobId=null;saveReplacementLocks();}
 }
 if(update&&lock){lock.jobId=update.jobId||lock.jobId;lock.state=update.state;if(update.state!=='waiting_manual')lock.resumePending=false;if(update.state==='completed'){session.completedNotice=true;replacementLocks.delete(session.pageId);}else if(update.state==='failed'&&!['dispatching','published'].includes(update.phase))replacementLocks.delete(session.pageId);saveReplacementLocks();}
 if(update?.state==='completed'&&session.completedUpdateId!==update.id){session.acceptedNative=true;try{await refreshNativeReplacement(session,update.id);}catch(error){if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);}throw error;}}
 renderNativeReplacement(session);
}
async function refreshNativeReplacement(session,updateId){
 const result=await request('/pages/'+encodeURIComponent(session.pageId));if(!currentReplacement(session))return;const page=result.page;
 if(page?.id!==session.pageId||page.projectId!==session.projectId||page.wpId!==session.wpId||page.fullUrl!==session.fullUrl||!Number.isSafeInteger(page.revision))throw Error('Прив’язка сторінки змінилася. Відкрийте актуальні дані.');
 const data=await request('/pages/'+encodeURIComponent(session.pageId)+'/placements');if(!currentReplacement(session))return;
 if(data.pageRevision!==page.revision||data.replacement?.mode!=='native'||!Array.isArray(data.placements))throw Error('Версія сторінки змінилася під час читання. Оновіть стан.');
 session.pageRevision=page.revision;session.placements=data.placements;session.capability=data.replacement;session.title=page.title;session.completedUpdateId=updateId;session.completedNotice=false;session.rollbackVersion=null;session.acceptedNative=false;
}
async function resumeNativeReplacement(session){
 const update=session.update,prior=replacementLocks.get(session.pageId);
 if(!currentReplacement(session,true)||session.statusReadFailed||update?.state!=='waiting_manual'||update.canResume!==true||!['queued','prepared'].includes(update.phase)||!update.jobId||prior?.resumePending)return;
 const lock={...prior,mode:'native',projectId:session.projectId,jobId:update.jobId,state:'submitting',resumePending:true};replacementLocks.set(session.pageId,lock);
 if(!saveReplacementLocks()){if(prior)replacementLocks.set(session.pageId,prior);else replacementLocks.delete(session.pageId);throw Error('Не вдалося зберегти стан продовження. Запис не надіслано.');}renderNativeReplacement(session);
 try{const result=await request('/jobs/'+encodeURIComponent(update.jobId)+'/native-resume',{});if(result.job?.id!==update.jobId||result.job.state!=='queued')throw Error('Результат продовження ще не підтверджено.');lock.resumePending=false;lock.state='queued';saveReplacementLocks();session.update={...update,state:'queued',canResume:false};trackJobs([result.job],session.projectId);scheduleRefresh();if(currentReplacement(session))await readReplacementStatus(session);}
 catch(error){if(lock.resumePending)lock.state='uncertain';saveReplacementLocks();if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);}throw error;}
}
async function checkNativeReplacement(session){
 const prior=replacementLocks.get(session.pageId);if(!currentReplacement(session)||session.statusReadFailed||session.update?.state!=='checking'||prior?.checkPending)return;
 const lock={...prior,mode:'native',projectId:session.projectId,jobId:session.update.jobId,state:'checking',checkPending:true,checkJobId:null};replacementLocks.set(session.pageId,lock);
 if(!saveReplacementLocks()){if(prior)replacementLocks.set(session.pageId,prior);else replacementLocks.delete(session.pageId);throw Error('Не вдалося зберегти стан перевірки. Запит не надіслано.');}renderNativeReplacement(session);
 try{const result=await request('/pages/'+encodeURIComponent(session.pageId)+'/check',{});if(!result.job?.id||result.job.type!=='page_check'||result.job.pageId!==session.pageId)throw Error('Результат запиту перевірки ще не підтверджено.');lock.checkJobId=result.job.id;saveReplacementLocks();trackJobs([result.job],session.projectId);scheduleRefresh();if(currentReplacement(session))await readReplacementStatus(session);}
 catch(error){saveReplacementLocks();if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);}throw error;}
}
function nativeCheckStatusText(status){
 const counted=Number.isSafeInteger(status?.attempt)&&Number.isSafeInteger(status?.limit)&&status.attempt>=1&&status.attempt<=status.limit&&status.limit<=3;
 if(status?.state==='problem')return 'Перевірка опублікованої сторінки виявила проблему. Наступна публікація чекає підтвердження.';
 if(status?.code==='NATIVE_CHECK_RETRIES_EXHAUSTED')return 'Не вдалося підтвердити перевірку після '+(counted?status.attempt:3)+' спроб. Можна запустити повторну перевірку сторінки.';
 if(status?.state==='unknown')return 'Перевірку опублікованої сторінки ще не підтверджено. Наступна публікація чекає звірки.';
 if(status?.state==='pending')return 'Запис підтверджено. Перевіряємо опубліковану сторінку та переходи.'+(counted?' Спроба '+status.attempt+' із '+status.limit+'.':'');
 if(status?.state==='ok')return 'Перевірку пройдено. Завершуємо підтвердження поточної сторінки.';
 return 'Запис підтверджено. Результат перевірки опублікованої сторінки ще не підтверджено.';
}
function renderNativeReplacement(session){
 if(!currentReplacement(session))return;const root=$('ap-replacement-content');clear(root);replacementHeading(root,session);const cap=session.capability,update=session.update,lock=replacementLocks.get(session.pageId);
 if(lock||cap?.jobId||session.statusReadFailed||update&&['queued','running','uncertain','checking','waiting_manual'].includes(update.state)){
  const manualReady=!session.statusReadFailed&&update?.state==='waiting_manual'&&update.canResume===true&&['queued','prepared'].includes(update.phase)&&update.jobId&&!lock?.resumePending;
  const note=el('p','ap-muted',manualReady?'Запис ще не надсилався. Завершіть CAPTCHA або вхід у відкритому вікні WordPress, потім підтвердьте продовження.':'Результат заміни ще не підтверджено. Повторний запис заблоковано; звірка лише читає WordPress.');note.dataset.nativeUpdateState=update?.state||lock?.state||'uncertain';root.appendChild(note);
  root.appendChild(el('p','ap-muted','Відкат версії стане доступним після підтвердження поточної заміни та перевірки сторінки.'));
  if(update?.state==='checking'){const checkStatus=el('p','ap-muted',nativeCheckStatusText(update.checkStatus));checkStatus.dataset.nativeCheckStatus='true';root.appendChild(checkStatus);}
  if(update?.state==='checking'&&!session.statusReadFailed&&!lock?.checkPending){const check=button('Перевірити сторінку',event=>working(event.currentTarget,()=>checkNativeReplacement(session)));check.dataset.nativeCheck='true';root.appendChild(check);}
  root.appendChild(button('Оновити стан',event=>working(event.currentTarget,()=>readReplacementStatus(session))));
  if(manualReady){const resume=button('Продовжити після CAPTCHA',event=>working(event.currentTarget,()=>resumeNativeReplacement(session)));resume.dataset.nativeResume='true';root.appendChild(resume);}
  if((update?.jobId||cap?.jobId||lock?.jobId)&&(!update||update.state==='uncertain')){const reconcile=button('Звірити',event=>working(event.currentTarget,()=>readReplacementStatus(session,true)));reconcile.dataset.nativeReconcile='true';root.appendChild(reconcile);}nativeComparison(root,update?.comparison,true);return;
 }
 if(update?.comparison){nativeComparison(root,update.comparison);root.appendChild(el('p','ap-muted','Віддалені правки збережено. Перед новими змінами потрібна актуальна підтверджена копія.'));return;}
 if(update?.state==='completed'&&session.completedNotice){root.appendChild(el('p','ap-muted','Зміну та опублікований результат підтверджено. Для наступної заміни відкрийте актуальні дані сторінки.'));return;}
 if(update?.state==='completed'&&session.completedUpdateId===update.id)root.appendChild(el('p','ap-muted','Поточну версію підтверджено. Дані для наступної заміни оновлено.'));
 if(cap?.available===false){root.appendChild(el('p','ap-muted',nativeReplacementReason(cap)));if(cap.accessRequired)renderNativeAccess(root,session);return;}
 renderReplacementFields(root,session,true);
  renderNativeHistory(root,session);
}
function renderNativeHistory(root,session){
 const history=el('details','ap-native-history');history.dataset.nativeHistory='true';history.appendChild(el('summary','','Попередні версії'));const list=el('div');history.appendChild(list);root.appendChild(history);let loading=false,loaded=false;
 history.addEventListener('toggle',async()=>{
  if(!history.open||loading||loaded||!currentReplacement(session)||session.capability?.available!==true)return;loading=true;list.textContent='Завантажуємо підтверджені версії…';
  try{
   const result=await request('/pages/'+encodeURIComponent(session.pageId)+'/rollback-versions');if(!currentReplacement(session)||!history.isConnected)return;if(result.pageRevision!==session.pageRevision||!Array.isArray(result.versions))throw Error('Версія сторінки змінилася. Відкрийте актуальні дані перед відкатом.');
   loaded=true;clear(list);if(!result.versions.length){list.appendChild(el('p','ap-muted','Попередніх підтверджених версій ще немає.'));return;}
   for(const version of result.versions){
    if(typeof version.id!=='string'||!version.id||!Number.isSafeInteger(version.revision))continue;
    const row=el('article','ap-diff');append(row,el('h4','','Версія '+version.revision),el('p','ap-muted',version.title||'Без назви'));if(version.createdAt)row.appendChild(el('p','ap-muted',date(version.createdAt)));
    const prepare=button('Підготувати відкат',event=>working(event.currentTarget,async()=>{
     if(!currentReplacement(session,true)||replacementLocks.has(session.pageId)||session.capability?.available!==true)return;const serial=session.proposalSerial=(session.proposalSerial||0)+1;
     const prepared=await request('/pages/'+encodeURIComponent(session.pageId)+'/rollback-proposals',{expectedRevision:session.pageRevision,versionId:version.id});if(!currentReplacement(session)||serial!==session.proposalSerial)return;
     if(prepared.proposal?.kind!=='native-rollback'||prepared.proposal.pageId!==session.pageId||prepared.proposal.expectedPageRevision!==session.pageRevision)throw Error('Не вдалося підтвердити пропозицію відкату. Оновіть дані сторінки.');
     session.rollbackVersion={revision:version.revision,title:version.title||''};renderProposal(prepared.proposal,session);
    }));prepare.dataset.nativeRollback=version.id;row.appendChild(prepare);list.appendChild(row);
   }
  }catch(error){if(currentReplacement(session)&&history.isConnected)list.textContent=errorText(error);}finally{loading=false;}
 });
}
function renderNativeAccess(root,session){
 const form=el('form');form.dataset.nativeAccess='true';form.autocomplete='off';const username=field(form,'Логін WordPress','nativeUsername'),password=field(form,'Пароль WordPress','nativePassword','','password');username.autocomplete='username';password.autocomplete='current-password';username.required=true;password.required=true;
 const submit=button('Зберегти доступ і продовжити',()=>{},'ap-button ap-primary');submit.type='submit';form.appendChild(submit);
 form.addEventListener('submit',event=>{event.preventDefault();if(!currentReplacement(session,true))return;const access={expectedRevision:session.pageRevision,username:username.value.trim(),password:password.value};password.value='';username.value='';working(submit,async()=>{try{await request('/pages/'+encodeURIComponent(session.pageId)+'/native-access',access);}finally{access.password='';}if(currentReplacement(session))await openReplacement({...session,id:session.pageId},session.isCurrent);});});root.appendChild(form);
}
async function openReplacement(page,isCurrent=()=>true){
 if(!isCurrent())return;
 const serial=++state.replacementSerial,selected=state.selected;state.replacement=null;let result;
 try{result=await request('/pages/'+page.id+'/placements');}catch(error){if(isCurrent()&&serial===state.replacementSerial&&selected===state.selected)throw error;return;}
 if(!isCurrent()||serial!==state.replacementSerial||selected!==state.selected)return;
 const session={serial,pageId:page.id,projectId:page.projectId,title:page.title,wpId:page.wpId,fullUrl:page.fullUrl,isCurrent,pageRevision:result.pageRevision,placements:result.placements||[],capability:result.replacement,acceptedNative:!!(replacementLocks.has(page.id)||result.replacement?.jobId)};state.replacement=session;
 const root=$('ap-replacement-content');clear(root);$('ap-replacement').querySelector('.ap-operation-error')?.remove();
 if(!$('ap-replacement').open)openDialog('ap-replacement');
 if(session.capability?.mode==='native'||replacementLocks.has(page.id)){try{await readReplacementStatus(session);}catch(error){if(currentReplacement(session)){session.statusReadFailed=true;renderNativeReplacement(session);throw error;}}return;}
 if(session.capability?.available===false){root.appendChild(el('p','ap-muted',nativeReplacementReason(session.capability)));return;}
 append(root,el('h3','',page.title||'Опублікована сторінка'),el('p','ap-muted','Позначте потрібні місця. Спочатку ви побачите точні зміни, потім підтвердите заміну.'));
 renderReplacementFields(root,session,false);
}
async function openQueueReplacement(detail){
 const {pageId,projectId}=detail||{},bound=typeof detail?.isCurrent==='function'?detail.isCurrent:()=>true;
 if(state.restartRequired||!bound()||!/^[-a-zA-Z0-9]{1,100}$/.test(pageId||'')||!/^[-a-zA-Z0-9]{1,100}$/.test(projectId||'')||!state.projects.some(project=>project.id===projectId&&!project.archived))return;
 const serial=state.queueReplacementSerial=(state.queueReplacementSerial||0)+1,selected=state.selected,current=(options={})=>serial===state.queueReplacementSerial&&state.selected===selected&&!state.restartRequired&&bound(options);
 try{
  const result=await request('/pages/'+encodeURIComponent(pageId));if(!current())return;const page=result.page;
  if(page?.id!==pageId||page.projectId!==projectId||!Number.isSafeInteger(page.wpId)||page.wpId<1||!safeUrl(page.fullUrl)||(page.remoteSnapshot?.status||page.lifecycleState)!=='publish'&&(page.remoteSnapshot?.status||page.lifecycleState)!=='published')throw Error('Не підтверджено опубліковану сторінку в цьому проєкті. Оновіть список сторінок.');
  await openReplacement(page,current);
 }catch(error){if(current())showMessage(errorText(error),true,$('pq-dashboard-note')||$('ap-notice'));}
}
function renderReplacementFields(root,session,native){
 if(native)root.appendChild(el('p','ap-muted','Одна адреса об’єднує всі її кнопки й посилання. Зміняться всі переходи групи; анкори, дизайн, WP ID та адреса сторінки зберігаються.'));
 if(!session.placements.length){root.appendChild(el('p','ap-muted','У цій сторінці немає підтримуваних посилань для заміни.'));return;}
 const form=el('form');form.id='ap-replacement-form';
 session.placements.forEach(place=>{
  const group=el('fieldset','ap-placement');group.dataset.placement=place.id;group.appendChild(el('legend','',place.label||place.role||'Посилання'));
  const checkLabel=el('label','ap-check-label'),check=el('input');check.type='checkbox';check.name='replacementSelected';append(checkLabel,check,el('span','',native?'Замінити всю групу':'Замінити це місце'));group.appendChild(checkLabel);group.appendChild(el('p','ap-exact-url',place.url));
  if(native){group.appendChild(el('p','ap-muted',place.memberCount+' переходів · '+place.nativeCount+' прямих href'));for(const member of place.members||[])group.appendChild(el('p','ap-muted','Анкор: '+member.anchor));}
  const url=field(group,native?'Нова повна адреса':'Нове посилання','replacementUrl',place.url,'url');url.required=true;url.maxLength=10000;
  if(!native&&place.anchorEditable===true)field(group,'Анкор','replacementAnchor',place.anchor||'');
  form.appendChild(group);
 });const submit=button(native?'Показати точні зміни':'Показати зміни',()=>{},'ap-button ap-primary');submit.type='submit';form.appendChild(submit);
 form.addEventListener('submit',async event=>{event.preventDefault();const data=session;if(!currentReplacement(data,true))return;const serial=data.proposalSerial=(data.proposalSerial||0)+1;await working(submit,async()=>{
  const changes=[];form.querySelectorAll('[data-placement]').forEach(row=>{if(!row.querySelector('[name=replacementSelected]').checked)return;const place=data.placements.find(p=>p.id===row.dataset.placement),url=row.querySelector('[name=replacementUrl]').value.trim();if(!safeUrl(url))throw Error('Перевірте нове посилання.');const change={id:place.id,url,expectedUrl:place.url,expectedAnchor:place.anchor};if(place.binding!==undefined)change.expectedBinding=place.binding;const anchor=row.querySelector('[name=replacementAnchor]');if(anchor)change.anchor=anchor.value;changes.push(change);});
  if(!changes.length)throw Error('Позначте хоча б одне місце для заміни.');
  let response;try{response=await request('/pages/'+data.pageId+'/proposals',{expectedRevision:data.pageRevision,changes});}catch(error){if(currentReplacement(data))throw error;return;}
  if(currentReplacement(data)&&serial===data.proposalSerial){data.rollbackVersion=null;renderProposal(response.proposal,data);}
 });});
 root.appendChild(form);
}
function renderProposal(proposal,session){
 if(!currentReplacement(session))return;
 const native=session.capability?.mode==='native',rollback=proposal.kind==='native-rollback',root=$('ap-replacement-content');clear(root);root.appendChild(el('h3','',session.title||'Опублікована сторінка'));root.appendChild(el('p','ap-muted',rollback?'Перевірте збережену версію перед відкатом. Запис почнеться лише після окремого підтвердження.':native?'Перевірте точні зміни. Запис почнеться лише після окремого підтвердження.':'Перевірте, куди вестимуть посилання. Зміни застосуються після підтвердження.'));
 if(rollback&&session.rollbackVersion)root.appendChild(el('p','ap-muted','Версія '+session.rollbackVersion.revision+' · '+session.rollbackVersion.title));
 for(const item of proposal.diff||[]){const card=el('article','ap-diff');card.appendChild(el('h3','',item.label||'Посилання'));for(const [label,value] of [[native?'Було':'Було',item.before],[native?'Буде':'Буде',item.after]]){const row=el('div','ap-diff-row');append(row,el('strong','',label),el('span','',(value?.url||'')+(value?.anchor?'\n'+(rollback?'Значення / хеш: ':'Анкор: ')+value.anchor:'')));card.appendChild(row);}root.appendChild(card);}
 if(native)root.appendChild(el('p','ap-muted',rollback?'Повернеться погоджена збережена версія на тому самому WP ID та URL сторінки. Свіжі зовнішні зміни зупинять відкат.':'Показано всі переходи вибраних груп. Анкори, дизайн, WP ID та URL цієї сторінки залишаться тими самими.'));
 const confirm=button(rollback?'Підтверджую відкат цієї версії':native?'Підтверджую ці заміни':'Підтвердити заміну',event=>working(event.currentTarget,async()=>{
  if(!currentReplacement(session,true))return;let result;
  if(native){if(replacementLocks.has(session.pageId))return;replacementLocks.set(session.pageId,{mode:'native',projectId:session.projectId,proposalId:proposal.id,state:'submitting'});if(!saveReplacementLocks()){replacementLocks.delete(session.pageId);throw Error('Не вдалося зберегти стан підтвердження. Запис не надіслано.');}session.acceptedNative=true;renderNativeReplacement(session);}
  try{result=await request('/proposals/'+proposal.id+'/confirm',{expectedRevision:proposal.revision,confirmed:true});if(!result.job?.id)throw Error('Результат підтвердження невідомий.');}catch(error){if(native){const lock=replacementLocks.get(session.pageId);if(error.status&&error.status<500&&error.status!==408)replacementLocks.delete(session.pageId);else if(lock)lock.state='uncertain';saveReplacementLocks();if(currentReplacement(session)){renderNativeReplacement(session);try{await readReplacementStatus(session);}catch{}}}if(currentReplacement(session))throw error;return;}
  // Accepted writes outlive the dialog, but their responses must not close a newer page's session.
  trackJobs(result.job?[result.job]:[],session.projectId);scheduleRefresh();
  if(native){const lock=replacementLocks.get(session.pageId);if(lock){lock.jobId=result.job.id;lock.state=result.job.state||'queued';saveReplacementLocks();}if(currentReplacement(session))await readReplacementStatus(session);await loadResults();return;}
  if(currentReplacement(session)){closeDialog('ap-replacement');showMessage('Заміну прийнято. Після оновлення сторінку буде перевірено.');}
  await loadResults();
 }),'ap-button ap-primary');root.appendChild(confirm);
}
async function init(){
 installManualExport();
 initLinkReport();
 $('ap-exclusions-open')?.addEventListener('click',openExclusions);
 $('ap-exclusions-form')?.addEventListener('submit',banExclusion);
 $('ap-exclusions-search')?.addEventListener('input',scheduleExclusionsSearch);
 $('ap-exclusions-state')?.addEventListener('change',()=>loadExclusions(state.exclusionsSession,0));
 $('ap-exclusions-refresh')?.addEventListener('click',()=>loadExclusions(state.exclusionsSession,state.exclusionsSession?.list?.offset||0));
 $('ap-exclusions-prev')?.addEventListener('click',()=>{const session=state.exclusionsSession;if(session?.list)loadExclusions(session,Math.max(0,session.list.offset-session.list.limit));});
 $('ap-exclusions-next')?.addEventListener('click',()=>{const session=state.exclusionsSession;if(session?.list)loadExclusions(session,session.list.offset+session.list.limit);});
 $('ap-exclusions')?.addEventListener('close',()=>{if(!$('ap-exclusions').open)invalidateExclusions();});
 window.addEventListener('pageposter:project-selected',()=>{if($('ap-exclusions')?.open)closeDialog('ap-exclusions');invalidateExclusions();});
 window.addEventListener('pageposter:recovery-restored',invalidateExclusions);
 window.addEventListener('pageposter:reconcile-publication',event=>openReconciliation(event.detail?.run));
 $('ap-reconciliation-check')?.addEventListener('click',()=>reconcileRequest(state.reconciliation,true));
 $('ap-reconciliation-refresh')?.addEventListener('click',()=>reconcileRequest(state.reconciliation));
 $('ap-reconciliation')?.addEventListener('close',()=>{if(!$('ap-reconciliation').open){state.reconciliation=null;const previous=state.focusReturn.get('ap-reconciliation');if(previous&&!previous.isConnected){const address=$('ap-reconciliation')._focusAddress,target=address?.queueItem?[...document.querySelectorAll('[data-queue-item]')].find(row=>row.dataset.queueItem===address.queueItem):[...document.querySelectorAll('[data-run-id]')].find(row=>row.dataset.runId===address?.runId);state.focusReturn.set('ap-reconciliation',target?.querySelector('[data-action=reconcile]'));}}});
 $('ap-support-download')?.addEventListener('click',downloadSupport);
 window.addEventListener('pageposter:queue-project-open',event=>{const id=event.detail?.projectId;if(state.projects.some(project=>project.id===id))selectProject(id,{composer:!!event.detail?.newPage}).catch(error=>showMessage(errorText(error),true));});
 window.addEventListener('pageposter:replace-links',event=>openQueueReplacement(event.detail));
 window.addEventListener('pageposter:project-selected',()=>{state.queueReplacementSerial=(state.queueReplacementSerial||0)+1;if(state.replacement&&!state.replacement.isCurrent()){invalidateReplacement();if($('ap-replacement').open)closeDialog('ap-replacement');}});
 window.addEventListener('pageposter:queue-item-details',async event=>{
  const {projectId,runId,pageId,target,isCurrent}=event.detail||{};if(!target||!runId&&!pageId)return;
  target.textContent='Завантажуємо поточний стан…';
  try{const [runs,pages]=await Promise.all([runId?request('/projects/'+encodeURIComponent(projectId)+'/autopilot'):Promise.resolve({runs:[]}),pageId?request('/projects/'+encodeURIComponent(projectId)+'/pages'):Promise.resolve({pages:[]})]);if(!isCurrent())return;const run=(runs.runs||[]).find(run=>run.id===runId);clear(target);if(run)target.appendChild(renderRun(run,{inspector:true}));const page=(pages.pages||[]).find(page=>page.id===pageId&&page.fullUrl);if(page)target.appendChild(renderPage(page,{isCurrent}));}
  catch(error){if(isCurrent())target.textContent='Не вдалося завантажити дії сторінки. '+errorText(error);}
 });
 window.addEventListener('pageposter:choose-donor',event=>openQueueDestination(event.detail));
 window.addEventListener('pageposter:project-imported',async()=>{try{const result=await request('/projects');state.projects=result.projects||[];renderProjects();renderHeading();await loadResults();}catch(error){showMessage('Проєкт імпортовано. '+errorText(error),true);}});
 window.addEventListener('pageposter:queue-updated',()=>{loadResults().catch(()=>{});});
 window.addEventListener('pageposter:inspector-invalidated',()=>{if(state.replacement&&!state.replacement.isCurrent()){invalidateReplacement();if($('ap-replacement').open)closeDialog('ap-replacement');showMessage('Сторінка змінилася. Відкрийте її поточні дані перед заміною посилань.');}});
 window.addEventListener('pageposter:queue-check-project',async event=>{const {projectId,control}=event.detail||{};if(!projectId||!control)return;await working(control,async()=>{const result=await request('/projects/'+encodeURIComponent(projectId)+'/check-pages',{});trackJobs(result.jobs,projectId);await loadResults();window.dispatchEvent(new CustomEvent('pageposter:queue-updated'));showMessage(result.queued?'Перевірка опублікованих сторінок запущена.':'Нових перевірок не додано; поточні результати збережено.');});});
 window.addEventListener('pageposter:recovery-restored',()=>{
  state.restartRequired=true;state.busy=true;state.load++;clearTimeout(state.poll);state.previewSerial++;state.fileSerial++;state.stageSerial++;invalidateReplacement();updateStatus();
  document.querySelectorAll('button,input,select,textarea').forEach(control=>{if(!control.closest('#ap-backup')&&!control.hasAttribute('data-close'))control.disabled=true;});
  showMessage('Копію відновлено. Перезапустіть PagePoster перед продовженням роботи.');
 });
 $('ap-stage-desktop').addEventListener('click',()=>stageSize(false));$('ap-stage-mobile').addEventListener('click',()=>stageSize(true));
 $('ap-stage-expand').addEventListener('click',()=>{if(state.stage?.html&&!state.stageLoading)showPreview(state.stage.html);});
 for(const id of ['ap-stage-copy','ap-copy-html'])$(id).addEventListener('click',event=>{const control=event.currentTarget;return working(control,()=>copyStageHTML(control))?.finally(updateStageActions);});
 $('ap-select-html').addEventListener('click',()=>{$('ap-ready-html').focus();$('ap-ready-html').select();});
 $('ap-html-code').addEventListener('close',()=>{if(!$('ap-html-code').open)$('ap-ready-html').value='';});
 $('ap-stage-publish').addEventListener('click',publishPrepared);$('ap-preview-publish').addEventListener('click',publishPrepared);
 $('ap-stage-destination').addEventListener('click',()=>openDestination(state.stage?.run));
 $('ap-destination-form').addEventListener('submit',saveDestination);
 $('ap-destination-source-tab').addEventListener('click',()=>destinationMode(state.destinationSession,'source'));
 $('ap-destination-manual-tab').addEventListener('click',()=>destinationMode(state.destinationSession,'manual'));
 $('ap-donor-search').addEventListener('input',scheduleDestinationSearch);
 $('ap-donor-all').addEventListener('change',()=>{const session=state.destinationSession;if(currentDestination(session)&&!session.busy)loadDestinationCandidates(session,0);});
 $('ap-donor-refresh').addEventListener('click',()=>{const session=state.destinationSession;if(currentDestination(session)&&!session.busy)loadDestinationCandidates(session,session.catalogue?.offset||0);});
 $('ap-donor-prev').addEventListener('click',()=>{const session=state.destinationSession,catalogue=session?.catalogue;if(currentDestination(session)&&catalogue&&!session.busy&&!session.loading)loadDestinationCandidates(session,Math.max(0,catalogue.offset-catalogue.limit));});
 $('ap-donor-next').addEventListener('click',()=>{const session=state.destinationSession,catalogue=session?.catalogue;if(currentDestination(session)&&catalogue&&!session.busy&&!session.loading)loadDestinationCandidates(session,catalogue.offset+catalogue.limit);});
 $('ap-destination').addEventListener('close',()=>{if(!$('ap-destination').open){const session=state.destinationSession;if(session){clearTimeout(session.searchTimer);session.sourceSerial++;}state.destinationOpenSerial=(state.destinationOpenSerial||0)+1;state.destinationSession=null;$('ap-destination-form').reset();clear($('ap-donor-list'));}});
 window.addEventListener('resize',fitAllPreviews);
 if(typeof ResizeObserver==='function'){const sizes=new ResizeObserver(fitAllPreviews);sizes.observe($('ap-stage-canvas'));sizes.observe($('ap-preview-frame').closest('.ap-preview-canvas'));}

 $('ap-replacement').addEventListener('cancel',invalidateReplacement);
 $('ap-setup-open').addEventListener('click',openSettings);
 $('ap-search').addEventListener('input',renderResults);$('ap-filter').addEventListener('change',renderResults);
 $('ap-preview-mobile').addEventListener('click',()=>previewSize(true));$('ap-preview-desktop').addEventListener('click',()=>previewSize(false));
  readWorkspace();
 document.querySelectorAll('[data-close]').forEach(control=>control.addEventListener('click',()=>closeDialog(control.dataset.close)));
 $('ap-projects-manage').addEventListener('click',openProjectManager);$('ap-project-scope').addEventListener('change',renderManagedProjects);$('ap-project-action-confirm').addEventListener('click',confirmProjectAction);
 document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('close',()=>{if(dialog.open)return;const target=state.focusReturn.get(dialog.id);(target?.isConnected&&!target.disabled?target:$('ap-main')).focus({preventScroll:true});}));
 $('ap-preview').addEventListener('close',()=>{if($('ap-preview').open)return;$('ap-preview-frame').srcdoc='';state.html='';});
 $('ap-settings-open').addEventListener('click',openSettings);$('ap-all').addEventListener('click',()=>selectProject(null));$('ap-add-link').addEventListener('click',()=>{addLink();editableChanged();$('ap-link-rows').lastElementChild.querySelector('input').focus();});$('ap-launch-form').addEventListener('submit',event=>{event.preventDefault();if(state.mode==='html')previewCustomerHtml();else launch(event);});$('ap-retry-launch')?.addEventListener('click',()=>{if(state.busy||!getPending())return;launch({preventDefault(){}});});$('ap-check-pages').addEventListener('click',checkPages);$('ap-download-html').addEventListener('click',downloadHtml);
 document.querySelectorAll('[name=contentSource]').forEach(input=>input.addEventListener('change',()=>switchMode(input.value)));
 ['ap-editorial-format','ap-editorial-topic','ap-editorial-language'].forEach(id=>$(id).addEventListener('change',()=>{updateEditorial();editableChanged();}));
 $('ap-editorial-custom').addEventListener('input',editableChanged);
 document.querySelectorAll('[name=chromeMode]').forEach(input=>input.addEventListener('change',()=>{if(state.mode==='html')htmlChanged();else editableChanged();}));
 ['customerHtml','htmlBaseUrl','htmlBrand','htmlBrandUrl'].forEach(name=>$('ap-launch-form').elements[name].addEventListener('input',htmlChanged));
 $('ap-html-preview').addEventListener('click',previewCustomerHtml);$('ap-html-file').addEventListener('change',readHtmlFile);
 $('ap-project-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,name=form.elements.projectName.value.trim(),workflowType=form.elements.workflowType?.value;if(!name)return;await working(form.querySelector('button[type=submit]'),async()=>{const result=await request('/projects',{name,...(workflowType?{workflowType}:{})});state.projects.push(result.project);form.reset();closeDialog('ap-project-dialog');await selectProject(result.project.id);});});
 const checkAI=button('Перевірити доступ до моделі',event=>working(event.currentTarget,async()=>{try{const data=await request('/api/ai/check',{});showMessage(data.model+': '+data.message,false,$('ap-settings-note'));}catch(error){showMessage(errorText(error),true,$('ap-settings-note'));}}));checkAI.id='ap-ai-check';$('ap-key-form').after(checkAI);
 $('ap-key-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,keyValue=form.elements.apiKey.value.trim();if(!keyValue)return showMessage('Вставте ключ OpenAI API.',true,$('ap-settings-note'));const control=form.querySelector('button');control.disabled=true;try{await request('/api/ai/connect',{apiKey:keyValue});form.reset();await refreshStatus();showMessage('Ключ OpenAI збережено.',false,$('ap-settings-note'));}catch(error){showMessage(errorText(error),true,$('ap-settings-note'));}finally{control.disabled=false;}});
 $('ap-browser-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,control=form.querySelector('button'),serial=state.settingsSerial;control.disabled=true;try{const result=await request('/autopilot/browser-settings',{mode:form.elements.browserMode.value});if(!['visible','hidden'].includes(result.browserMode))throw Error('Сервер не підтвердив режим браузера.');state.status={...state.status,browserMode:result.browserMode};if(serial===state.settingsSerial)showMessage('Режим браузера збережено для нових запусків.',false,$('ap-settings-note'));}catch(error){if(serial===state.settingsSerial)showMessage(errorText(error),true,$('ap-settings-note'));}finally{control.disabled=false;}});
 $('ap-source-form').addEventListener('submit',saveSource);$('ap-source-form').addEventListener('input',sourceControls);$('ap-source-form').addEventListener('change',sourceControls);$('ap-source-check')?.addEventListener('click',checkSource);
 $('ap-browser-mode').addEventListener('change',()=>{if(window.pageposterDesktop)$('ap-browser-form').querySelector('button').hidden=$('ap-browser-mode').value===(state.status?.browserMode||'visible');});
 $('ap-settings').addEventListener('close',()=>{if(!$('ap-settings').open)state.settingsSerial++;});
 $('ap-site-selection-open')?.addEventListener('click',openSiteSelection);$('ap-site-selection-form')?.addEventListener('submit',saveSiteSelection);$('ap-site-selection')?.addEventListener('close',()=>{if(!$('ap-site-selection').open)state.selectionSession=null;});
 try{const [projects,status]=await Promise.all([request('/projects'),request('/autopilot/status')]);state.projects=projects.projects||[];state.status=status;updateStatus();await selectProject(state.savedSelection===null?null:state.projects.find(p=>!p.archived&&p.id===state.savedSelection)?.id||state.projects.find(p=>!p.archived)?.id||null);}
 catch(error){$('ap-title').textContent='Підключення до PagePoster';$('ap-subtitle').textContent='Для автоматичної генерації й публікації потрібен запущений сервер PagePoster.';$('ap-connection-copy').textContent='Немає зв’язку із сервером';showMessage(errorText(error),true);}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
