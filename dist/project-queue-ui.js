(function(){
'use strict';
const $=id=>document.getElementById(id),api='/api/lifecycle';
const state={projects:[],overview:null,preview:null,previewSerial:0,inputSerial:0,fileSerial:0,csvSerial:0,files:[],csvText:'',projectFile:null,projectFileSerial:0,projectFileBusy:false,pending:null,previewBusy:false,importBusy:false,queueBusy:false,refreshSerial:0,timer:null,reviews:new Map(),selected:new Set(),review:null,reviewSerial:0,disabled:false,disabledReason:'',regionEdit:null,projectFilter:'',requirements:null};
const htmlLanguages={en:'Англійська',es:'Іспанська',pl:'Польська',de:'Німецька',fr:'Французька',hu:'Угорська',pt:'Португальська',it:'Італійська',nl:'Нідерландська',cs:'Чеська',sk:'Словацька',ro:'Румунська',sv:'Шведська',fi:'Фінська',nb:'Норвезька',da:'Данська',el:'Грецька',tr:'Турецька',uk:'Українська',ru:'Російська',ja:'Японська',ko:'Корейська',zh:'Китайська',ar:'Арабська'};
const countryNames=new Intl.DisplayNames(['uk'],{type:'region'});
for(const [code,entry]of Object.entries(window.PagePosterGenerationOptions.languages))htmlLanguages[code]=entry[1];
function languageName(value){return htmlLanguages[value]||value;}
function countryName(value){if(!value)return 'Без заданого гео';return value.split(',').map(code=>{try{return countryNames.of(code.trim())||code;}catch{return code;}}).join(', ');}
function languageOptions(select,value,html=true){select.replaceChildren();for(const [code,label] of Object.entries(htmlLanguages)){if(!html&&!Object.hasOwn(window.PagePosterGenerationOptions.languages,code))continue;const option=node('option','',label+' ('+code+')');option.value=code;select.appendChild(option);}if(value&&!Array.from(select.options).some(option=>option.value===value)){const option=node('option','',value);option.value=value;select.appendChild(option);}select.value=value||'en';}
const statuses={running:'В роботі',waiting:'У черзі',queued:'У черзі',generating:'Генерація',preparing:'Підготовка HTML',ready:'Готова до перегляду',awaiting_review:'Готова до перегляду',publishing:'Публікація',checking:'Перевірка',completed:'Опублікована',attention:'Потребує уваги',needs_attention:'Потребує уваги',failed:'Помилка',uncertain:'Потрібна перевірка',waiting_source:'Потрібен сайт',paused:'Призупинена'};
function node(tag,cls,text){const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=String(text??'');return value;}
function append(parent,...children){for(const child of children)if(child)parent.appendChild(child);return parent;}
function button(text,action,cls='ap-button ap-secondary'){const control=node('button',cls,text);control.type='button';control.addEventListener('click',action);return control;}
function note(id,text,bad=false){const target=$(id);target.textContent=text;target.hidden=!text;target.classList.toggle('error',bad);}
function errorMessage(error){return state.disabled?state.disabledReason:error?.message||'Не вдалося отримати відповідь сервера. Спробуйте ще раз.';}
async function request(endpoint,body,{zip=false,ai=false}={}){
 if(state.disabled)throw Error(state.disabledReason);
 const response=await fetch((ai?'/api/ai':api)+endpoint,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:body===undefined?undefined:JSON.stringify(body)});
 if(state.disabled)throw Error(state.disabledReason);
 if(zip&&response.ok&&response.headers.get('Content-Type')==='application/zip')return response.blob();
 let result;
 try{result=await response.json();}catch{throw Error('Сервер повернув нерозпізнану відповідь.');}
 if(state.disabled)throw Error(state.disabledReason);
 if(!response.ok)throw Object.assign(Error(result?.error?.message||result?.error||result?.message||'Не вдалося виконати запит.'),{status:response.status,code:result?.code,issues:result?.issues});
 if(zip)throw Error('Сервер не повернув ZIP.');
 return result;
}
function open(id){if(!$(id).open){$(id)._pqFocus=document.activeElement;if(['pq-dashboard','pq-review'].includes(id))$(id).show();else $(id).showModal();}if(id==='pq-dashboard')document.body.dataset.workspaceView='queue';}
function close(id){$(id).close();}
function projectId(project){return project.projectId||project.id;}
function workflow(project){return project.type||project.workflowType;}
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const data=crypto.getRandomValues(new Uint8Array(16));data[6]=(data[6]&15)|64;data[8]=(data[8]&63)|128;return [...data].map((v,i)=>([4,6,8,10].includes(i)?'-':'')+v.toString(16).padStart(2,'0')).join('');}
function fingerprint(item){const {updatedAt,...content}=item;return JSON.stringify(content);}
function findItem(id){for(const project of state.overview?.projects||[]){const item=(project.items||[]).find(row=>row.id===id);if(item)return item;}return null;}
function reviewable(item){return item?.canApprove===true&&!!item.runId&&(!item.batchId||!!item.selectedSite);}
function validReview(item){const review=state.reviews.get(item.id);return review&&review.fingerprint===fingerprint(item)&&reviewable(item)?review:null;}
function controls(){const locked=state.importBusy||!!state.pending;$('pq-auto-file').disabled=locked||state.disabled||state.projectFileBusy;$('pq-auto-retry').disabled=state.importBusy||state.disabled;for(const control of $('pq-import-form').querySelectorAll('input,select,textarea'))control.disabled=locked||state.disabled;$('pq-project-file').disabled=locked||state.disabled||state.projectFileBusy;$('pq-preview-import').disabled=locked||state.previewBusy||state.disabled||$('pq-source').value==='project-file'&&state.projectFileBusy;$('pq-commit-import').disabled=state.importBusy||state.previewBusy||state.disabled||!state.preview?.items?.length||!!state.preview?.issues?.length;$('pq-commit-import').textContent=state.importBusy?'Додаємо…':state.pending?'Повторити імпорт':'Додати до черги';for(const control of $('pq-import-preview').querySelectorAll('[data-region-edit],[data-file-edit]'))control.disabled=locked||state.previewBusy||state.disabled;$('pq-row-apply').disabled=locked||state.previewBusy||state.disabled;for(const control of $('pq-row-form').querySelectorAll('input,select'))control.disabled=locked||state.previewBusy||state.disabled;for(const control of $('pq-bulk-form').querySelectorAll('input,button'))control.disabled=locked||state.previewBusy||state.disabled||!state.preview?.items?.length||!!state.preview?.issues?.length;renderGoogleCapabilities();}
function invalidate(){state.inputSerial++;state.previewSerial++;state.preview=null;state.pending=null;state.regionEdit=null;if($('pq-row-settings')?.open)close('pq-row-settings');$('pq-import-preview').hidden=true;note('pq-import-note','');controls();}
function defaults(){const result={language:$('pq-default-language').value,geo:$('pq-default-geo').value.trim(),format:$('pq-default-format').value,topic:$('pq-default-topic').value,customTopic:$('pq-default-custom').value.trim(),chromeMode:$('pq-default-chrome').value};if($('pq-type').value==='html')result.detectFileRegions=$('pq-detect-regions').checked;for(const [id,key] of [['pq-default-dr','minDr'],['pq-default-traffic','minTraffic']]){const value=$(id).value.trim();if(value!=='')result[key]=Number(value);}return result;}
let googleCapabilities=null,capabilitySerial=0;
function googleNeeds(){const source=$('pq-source').value,attachment=$('pq-type').value==='html'&&['text','csv','sheets'].includes(source)?$('pq-html-attachment').value:'';return {sheets:source==='sheets',drive:source==='drive'||attachment==='drive'};}
function googleBlock(){const needs=googleNeeds();return (needs.sheets&&googleCapabilities?.google?.sheets?.available!==true)||(needs.drive&&googleCapabilities?.google?.drive?.available!==true);}
function renderGoogleCapabilities(){
 if(window.pageposterDesktop)$('pq-template').hidden=!['text','csv','sheets'].includes($('pq-source').value);
 const target=$('pq-google-capabilities');if(!target)return;const needs=googleNeeds(),google=googleCapabilities?.google;target.hidden=!needs.sheets&&!needs.drive;target.replaceChildren();if(target.hidden)return;
 if(!google)target.appendChild(node('p','','Можливості Google ще не підтверджені. Оновіть підключення або виберіть локальні файли / таблицю.'));
 else{const modes={user:'Звичайний вхід Google',service:'Сервісний акаунт Google',browser:'Сесія Google у браузері',none:'Google не підключено'};target.appendChild(node('strong','',modes[google.mode]||'Підключення Google'));for(const [kind,label] of [['sheets','Google Таблиці'],['drive','Google Drive']])if(needs[kind])target.appendChild(node('p','',google[kind]?.available===true?label+': спосіб читання готовий. Доступ до вибраного ресурсу перевіримо під час читання.':label+': недоступний у поточному підключенні. Виберіть локальний файл або підтримуваний спосіб читання в налаштуваннях.'));}
 const locked=state.disabled||state.importBusy||!!state.pending;for(const [kind,ids] of [['sheets',['pq-sheet-url','pq-sheet-range']],['drive',['pq-drive-url']]])for(const id of ids)$(id).disabled=locked||google?.[kind]?.available!==true;
 if(googleBlock())$('pq-preview-import').disabled=true;
}
async function loadImportCapabilities(){const serial=++capabilitySerial;googleCapabilities=null;controls();try{const result=await request('/project-import/capabilities');if(serial!==capabilitySerial)return;if(result.version!==1||!result.google)throw Error('Можливості Google не підтверджені.');googleCapabilities=result;}catch{if(serial===capabilitySerial)googleCapabilities=null;}finally{if(serial===capabilitySerial)controls();}}
function sourceOptions(){const type=$('pq-type').value,previous=$('pq-source').value,options=[['text','Вставити CSV / TSV'],['csv','Файл CSV / TSV'],['sheets','Google Таблиця'],['project-file','Файл проєкту · таблиця або архів']];if(type==='html')options.push(['files','Файли HTML'],['drive','Google Drive: файл або тека']);$('pq-source').replaceChildren();for(const [value,label] of options){const option=node('option','',label);option.value=value;$('pq-source').appendChild(option);}if(options.some(([value])=>value===previous))$('pq-source').value=previous;else $('pq-source').value=type==='html'?'files':'text';renderSources();}
function renderSources(){const type=$('pq-type').value,source=$('pq-source').value,table=type==='html'&&['text','csv','sheets'].includes(source),attachment=table?$('pq-html-attachment').value:'none';for(const [key,id] of [['text','pq-text-source'],['csv','pq-csv-source'],['project-file','pq-project-file-source'],['sheets','pq-sheets-source'],['files','pq-files-source'],['drive','pq-drive-source']])$(id).hidden=source!==key;$('pq-html-attachment-wrap').hidden=!table;if(type==='html'){$('pq-text-source').hidden=!['text','files','drive'].includes(source);$('pq-files-source').hidden=source!=='files'&&attachment!=='files';$('pq-drive-source').hidden=source!=='drive'&&attachment!=='drive';}const mapping=$('pq-file-mapping');mapping.hidden=type!=='html'||table||source==='project-file';if(!mapping.hidden)mapping.appendChild($('pq-text-source'));else if($('pq-text-source').parentElement===mapping)mapping.before($('pq-text-source'));$('pq-google-help').hidden=!['sheets','drive'].includes(source)&&attachment!=='drive';$('pq-file-regions').hidden=type!=='html'||!['files','drive','project-file'].includes(source)&&!['files','drive'].includes(attachment);const language=$('pq-default-language');if(language.dataset.kind!==type){const prior=language.value;languageOptions(language,type==='html'||['en','es','pl','de','fr'].includes(prior)?prior:'en',type==='html');language.dataset.kind=type;}document.querySelectorAll('.pq-ai-default').forEach(control=>control.hidden=type!=='ai');$('pq-custom-topic-wrap').hidden=type!=='ai'||$('pq-default-topic').value!=='custom';$('pq-schema-help').textContent=type==='ai'?"Обов'язкові url та anchor; key, title, language, geo, minDr, minTraffic, format і topic — необов'язкові.":'Таблиця для набору файлів необов’язкова: гео й мову можна визначити автоматично та змінити перед імпортом. Для власного зіставлення: file, language, geo, title, minDr, minTraffic. Або вставте HTML у колонку html.';controls();}
function targetOptions(){const previous=$('pq-target').value,type=$('pq-type').value;$('pq-target').replaceChildren();const first=node('option','','Нового проєкту');first.value='';$('pq-target').appendChild(first);for(const project of state.projects.filter(project=>!project.archived&&workflow(project)===type)){const option=node('option','',project.name);option.value=projectId(project);$('pq-target').appendChild(option);}if([...$('pq-target').options].some(option=>option.value===previous))$('pq-target').value=previous;renderTarget();}
function renderTarget(){$('pq-name-wrap').hidden=!!$('pq-target').value;$('pq-name').required=!$('pq-target').value;}
async function loadProjects(){const result=await request('/projects');state.projects=result.projects||[];targetOptions();}
async function openImport(){if(state.disabled)return;closeReview();if(!$('pq-import-dialog').open)$('pq-manual-import').open=false;open('pq-import-dialog');void loadImportCapabilities();try{await loadProjects();}catch(error){note('pq-import-note',errorMessage(error),true);}}
async function automaticImportId(file){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await new Blob(['auto-import-v1\0',file.name,'\0',file]).arrayBuffer()));
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes.subarray(0,16),value=>value.toString(16).padStart(2,'0')).join('');
 return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
async function automaticImport(){
 const input=$('pq-auto-file'),file=input.files[0],manual=$('pq-manual-import'),retry=$('pq-auto-retry');
 if(!file||state.disabled||state.pending||state.importBusy||state.previewBusy||state.projectFileBusy)return;
 input.disabled=true;manual.hidden=true;state.projectFileBusy=true;invalidate();controls();
 note('pq-import-note','Читаємо проєкт і перевіряємо джерела…');
 try{
  const normalized=await window.PagePosterProjectNormalizer.normalize(file,{mapColumns:async(headers,hasHtml)=>{
   note('pq-import-note','Визначаємо призначення колонок через OpenAI…');
   return (await request('/project-columns',{headers,hasHtml},{ai:true})).columns;
  }});
  if(state.disabled||!$('pq-import-dialog').open)return;
  $('pq-type').value=normalized.type;sourceOptions();$('pq-source').value='project-file';renderSources();
  $('pq-target').value='';renderTarget();$('pq-name').value=file.name.replace(/\.[^.]+$/,'').slice(0,120).trim()||'Імпортований проєкт';
  const payload=projectFileInput(normalized,{type:normalized.type,defaults:{detectFileRegions:true}});
  if(await previewImport(null,payload)){
   const importId=await automaticImportId(file);
   if(!state.disabled&&$('pq-import-dialog').open)await commitImport(null,importId);
  }
 }catch(error){note('pq-import-note',errorMessage(error),true);}
 finally{
  input.disabled=false;input.value='';manual.hidden=false;state.projectFileBusy=false;
  retry.hidden=!state.pending;controls();
 }
}
async function retryAutomaticImport(){
 await commitImport();
 $('pq-auto-retry').hidden=!state.pending;
}
async function readProjectFile(){
 const serial=++state.projectFileSerial,file=$('pq-project-file').files[0],status=$('pq-project-file-status');
 const previousName=state.projectFile?.suggestedName;
 state.projectFile=null;state.projectFileBusy=!!file;invalidate();status.textContent=file?'Читаємо файл проєкту…':'';
 if(!file)return;
 try{
  const normalized=await window.PagePosterProjectNormalizer.normalize(file);
  if(serial!==state.projectFileSerial||state.disabled)return;
  const suggestedName=file.name.replace(/\.[^.]+$/,'').slice(0,120);
  state.projectFile={...normalized,suggestedName};
  const kind=normalized.type==='html'?'Готовий HTML':'Генерація AI';
  status.textContent=[file.name,kind,normalized.sheet&&'Аркуш «'+normalized.sheet+'»',normalized.sourceRows&&'Сторінок у ТЗ: '+normalized.sourceRows.length,normalized.files&&'HTML-файлів: '+normalized.files.length].filter(Boolean).join(' · ');
  if($('pq-source').value!=='project-file')return;
  $('pq-type').value=normalized.type;sourceOptions();targetOptions();
  if(!$('pq-target').value&&(!$('pq-name').value.trim()||$('pq-name').value===previousName))$('pq-name').value=suggestedName;
 }catch(error){
  if(serial!==state.projectFileSerial||state.disabled)return;
  status.textContent='Файл не прочитано.';
  if($('pq-source').value==='project-file')note('pq-import-note',errorMessage(error),true);
 }finally{if(serial===state.projectFileSerial){state.projectFileBusy=false;controls();}}
}
async function readCsv(){const serial=++state.csvSerial,file=$('pq-csv-file').files[0];invalidate();state.csvText='';$('pq-csv-status').textContent='';if(!file)return;if(file.size>20*1024*1024){note('pq-import-note','Таблиця має бути не більшою за 20 МБ.',true);return;}try{const text=await file.text();if(serial!==state.csvSerial)return;state.csvText=text;$('pq-csv-status').textContent=file.name+' · '+file.size.toLocaleString('uk-UA')+' байт';}catch(error){note('pq-import-note',errorMessage(error),true);}}
async function readHtmlFiles(){
 const serial=++state.fileSerial,files=[...$('pq-html-files').files];
 invalidate();state.files=[];$('pq-files-status').textContent='Читаємо файли…';
 try{
  if(files.length>1000)throw Error('Оберіть не більше 1000 файлів за один імпорт.');
  if(files.some(file=>file.size>500000))throw Error('Кожний HTML-файл має бути не більшим за 500 000 байт.');
  if(files.reduce((size,file)=>size+file.size,0)>20*1024*1024)throw Error('Загальний розмір файлів має бути не більшим за 20 МБ.');
  const result=await Promise.all(files.map(async file=>{
   const bytes=new Uint8Array(await file.arrayBuffer());
   try{return {name:file.name,html:window.PagePosterHTMLPackage.decodeHtml(bytes,false)};}
   catch(error){throw Error(file.name+' · '+error.message);}
  }));
  if(serial!==state.fileSerial)return;
  state.files=result;$('pq-files-status').textContent='Файлів: '+result.length+'. Кожний файл стане окремою сторінкою.';
 }catch(error){if(serial===state.fileSerial){$('pq-files-status').textContent='Файли не завантажені.';note('pq-import-note',errorMessage(error),true);}}
}
function projectFileInput(file,result){
 if(file.text){result.text=file.text;result.sourceFile=file.sourceFile;if(file.sourceRows)result.sourceRows=file.sourceRows;if(file.sourceLocations)result.sourceLocations=file.sourceLocations;if(file.columnMapping)result.columnMapping=file.columnMapping;}
 if(file.files)result.files=file.files;
 return result;
}
function importInput(){if(googleBlock())throw Error('Поточне підключення Google не підтримує вибране джерело. Виберіть локальне джерело або змініть підключення.');const source=$('pq-source').value,type=$('pq-type').value,result={type,defaults:defaults()},table=['text','csv','sheets'].includes(source),attachment=type==='html'&&table?$('pq-html-attachment').value:source;if(source==='project-file'){
 const file=state.projectFile;
 if(!file)throw Error('Оберіть і дочекайтеся читання файла проєкту.');
 if(file.type!==type)throw Error('Тип проєкту має відповідати вмісту файла.');
 return projectFileInput(file,result);
 }if(source==='text')result.text=$('pq-text').value;else if(source==='csv'){if(!state.csvText)throw Error('Оберіть CSV або TSV файл.');result.text=state.csvText;result.sourceFile=$('pq-csv-file').files[0]?.name;}else if(source==='sheets'){result.spreadsheetUrl=$('pq-sheet-url').value.trim();result.range=$('pq-sheet-range').value.trim();if(!result.spreadsheetUrl)throw Error('Вкажіть посилання на Google Таблицю.');}if(type==='html'&&attachment==='drive'){result.driveUrl=$('pq-drive-url').value.trim();if(!result.driveUrl)throw Error('Вкажіть посилання на файл або теку Google Drive.');}if(type==='html'&&attachment==='files'){if(!state.files.length)throw Error('Оберіть готові HTML-файли.');result.files=state.files.map(file=>({...file}));}if(type==='html'&&!table&&$('pq-text').value.trim())result.text=$('pq-text').value;if(['text','csv'].includes(source)&&!result.text.trim())throw Error('Додайте рядки таблиці.');return result;}
function provenanceDetails(provenance){
 if(!provenance||provenance.version!==1)return null;
 const detail=node('details','pq-provenance'),source=provenance.source||{},labels={items:'Рядки',table:'Таблиця',files:'HTML-файл','google-sheets':'Google Таблиця','google-drive':'Google Drive'},fields={key:'ключ',title:'назва',language:'мова',geo:'гео',minDr:'DR',minTraffic:'трафік',html:'HTML',chromeMode:'хедер / футер',links:'посилання',format:'формат',topic:'тема',customTopic:'власна тема',baseUrl:'адреса ресурсів',brand:'бренд',brandUrl:'посилання бренду'};
 detail.dataset.provenance='true';detail.appendChild(node('summary','',[labels[source.kind]||'Джерело',source.file,source.row?'рядок '+source.row:''].filter(Boolean).join(' · ')));
 for(const [key,label] of [['explicit','Задано явно'],['detected','Визначено'],['defaulted','Типові значення']]){const values=(provenance.fields?.[key]||[]).filter(value=>Object.hasOwn(fields,value));if(values.length)detail.appendChild(node('p','ap-fine',label+': '+values.map(value=>fields[value]).join(', ')));}
 if(source.spreadsheetId||source.driveId||source.gid!==undefined||source.range)detail.appendChild(node('p','ap-fine',[source.spreadsheetId?'Таблиця: '+source.spreadsheetId:'',source.driveId?'Drive: '+source.driveId:'',source.gid!==undefined?'gid: '+source.gid:'',source.range].filter(Boolean).join(' · ')));
 const warnings={LANGUAGE_DEFAULTED:'Мову взято з типових значень.',GEO_UNSPECIFIED:'Гео не задано — перевірте перед імпортом.',FILE_REGION_NOT_DETECTED:'Регіон не визначено з назви файлу.'};
 for(const code of provenance.warnings||[])if(warnings[code])detail.appendChild(node('p','ap-fine',warnings[code]));
 return detail;
}
function importLinksDetails(links){
 if(!links?.length)return null;
 const details=node('details','pq-provenance');
 details.appendChild(node('summary','','Посилання й анкори ('+links.length+')'));
 details.addEventListener('toggle',function showLinks(){
  if(!details.open)return;
  details.removeEventListener('toggle',showLinks);
  const list=node('ol','pq-import-links');
  for(const {url,anchor} of links){
   const item=node('li');
   item.append(node('strong','',anchor),node('p','ap-fine',url));list.appendChild(item);
  }
  details.appendChild(list);
 });
 return details;
}
function renderImportPreview(result){$('pq-import-preview').hidden=false;$('pq-import-count').textContent='3. Перевірка сторінок · Сторінок: '+result.items.length+' · Помилок: '+result.issues.length;$('pq-import-issues').replaceChildren();for(const issue of result.issues){const location=issue.row?'Рядок '+issue.row:issue.key?'Ключ '+issue.key:'';$('pq-import-issues').appendChild(node('li','',(location?location+': ':'')+issue.message));}$('pq-import-rows').replaceChildren();for(const item of result.items){const row=node('tr'),selection=item.siteSelection||{};row.dataset.importKey=item.key;for(const value of [item.key,item.title,item.language,Array.isArray(item.geo)?item.geo.join(', '):item.geo||'—',(selection.minDr??'—')+' / '+(selection.minTraffic??'—'),item.source==='html'?'Готовий HTML':'AI'])row.appendChild(node('td','',value));const provenance=provenanceDetails(item.provenance),links=importLinksDetails(item.links);if(provenance)row.lastChild.appendChild(provenance);if(links)row.lastChild.appendChild(links);const settings=node('td'),control=button('Змінити',()=>openRowSettings([item.key],item.title||item.key));control.dataset.fileEdit=item.key;settings.appendChild(control);row.appendChild(settings);$('pq-import-rows').appendChild(row);}renderBulkSettings(result);renderRegionGroups(result);controls();}
function renderBulkSettings(result){
 $('pq-bulk-settings').hidden=!result.items.length;note('pq-bulk-note','');
 for(const [id,key] of [['pq-bulk-dr','minDr'],['pq-bulk-traffic','minTraffic']]){const values=result.items.map(item=>item.siteSelection?.[key]??null),common=values.every(value=>value===values[0]);$(id).value=common?values[0]??'':'';$(id).placeholder=common?'Залишити без змін':'Різні значення — залишити';}
}
async function applyBulkSettings(event){
 event.preventDefault();const preview=state.preview;if(!preview?.items?.length||preview.issues.length||state.previewBusy||state.importBusy||state.pending||state.disabled)return;
 if(!$('pq-bulk-form').reportValidity())return;const changes={};
 for(const [id,key] of [['pq-bulk-dr','minDr'],['pq-bulk-traffic','minTraffic']]){const raw=$(id).value.trim();if(raw!=='')changes[key]=Number(raw);}
 if(!Object.keys(changes).length){note('pq-bulk-note','Вкажіть DR або трафік для всіх сторінок.',true);return;}
 if(changes.minDr!==undefined&&(!Number.isFinite(changes.minDr)||changes.minDr<0||changes.minDr>100)||changes.minTraffic!==undefined&&(!Number.isSafeInteger(changes.minTraffic)||changes.minTraffic<0)){note('pq-bulk-note','DR має бути від 0 до 100, трафік — цілим невід’ємним числом.',true);return;}
 const items=preview.items.map(item=>({...item,siteSelection:{...item.siteSelection,...changes}})),serial=++state.previewSerial;state.previewBusy=true;controls();note('pq-bulk-note','Застосовуємо вимоги до всіх сторінок…');
 try{const result=await request('/project-import/preview',{type:$('pq-type').value,items});if(serial!==state.previewSerial||preview!==state.preview)return;if(!Array.isArray(result.items)||!Array.isArray(result.issues)||result.items.length!==items.length)throw Error('Сервер не підтвердив налаштування всіх сторінок.');if(result.issues.length)throw Error(result.issues.slice(0,3).map(issue=>issue.message).join(' '));state.preview={...result,source:preview.source};renderImportPreview(state.preview);note('pq-bulk-note','Спільні вимоги застосовано до всіх сторінок: '+items.length+'.');}
 catch(error){if(serial===state.previewSerial&&preview===state.preview)note('pq-bulk-note',errorMessage(error),true);}
 finally{state.previewBusy=false;controls();}
}
function itemGeo(item){const geo=item.siteSelection?.geo??item.geo??'';return Array.isArray(geo)?geo.join(','):String(geo);}
function renderRegionGroups(result){
 const groups=new Map(),list=$('pq-region-groups');list.replaceChildren();$('pq-region-summary').hidden=$('pq-type').value!=='html'||!result.items.length;if($('pq-region-summary').hidden)return;
 for(const item of result.items){const geo=itemGeo(item),id=JSON.stringify([geo,item.language]);if(!groups.has(id))groups.set(id,{geo,language:item.language,keys:[]});groups.get(id).keys.push(item.key);}
 for(const group of groups.values()){const card=node('section','pq-region-group');card.dataset.geo=group.geo;card.dataset.language=group.language;append(card,node('h4','',countryName(group.geo)),node('p','ap-fine','Файлів: '+group.keys.length+' · '+languageName(group.language)));const control=button('Налаштувати',()=>openRowSettings(group.keys,countryName(group.geo)));control.dataset.regionEdit='true';card.appendChild(control);list.appendChild(card);}
}
function openRowSettings(keys,title){
 if(state.previewBusy||state.importBusy||state.pending||state.disabled||!state.preview)return;
 const selected=state.preview.items.filter(item=>keys.includes(item.key));if(!selected.length)return;
 state.regionEdit={keys:new Set(keys),preview:state.preview,touched:new Set()};$('pq-row-title').textContent=selected.length===1?'Налаштування сторінки':'Налаштування групи';$('pq-row-summary').textContent=title+' · сторінок: '+selected.length;note('pq-row-note','');
 const common=fn=>{const values=selected.map(fn);return values.every(value=>value===values[0])?values[0]:null;};languageOptions($('pq-row-language'),selected[0].language,$('pq-type').value==='html');
 for(const [id,get] of [['pq-row-geo',itemGeo],['pq-row-dr',item=>item.siteSelection?.minDr??''],['pq-row-traffic',item=>item.siteSelection?.minTraffic??'']]){const value=common(get);$(id).value=value??'';$(id).placeholder=value===null?'Різні значення — залишити':id==='pq-row-geo'?'HU, NZ, PL':'Без обмеження';}
 open('pq-row-settings');controls();
}
async function applyRowSettings(event){
 event.preventDefault();const session=state.regionEdit;if(!session||session.preview!==state.preview||state.previewBusy||state.pending||state.disabled)return;
 const values={language:$('pq-row-language').value,geo:$('pq-row-geo').value.trim(),minDr:$('pq-row-dr').value.trim(),minTraffic:$('pq-row-traffic').value.trim()},touched=session.touched;
 const items=state.preview.items.map(item=>{if(!session.keys.has(item.key))return item;const next={...item,siteSelection:{...item.siteSelection}};if(touched.has('pq-row-language')){next.language=values.language;if(next.source==='ai')next.editorial={...next.editorial,language:values.language};}if(touched.has('pq-row-geo')){next.geo=values.geo;next.siteSelection.geo=values.geo;}for(const [id,key] of [['pq-row-dr','minDr'],['pq-row-traffic','minTraffic']])if(touched.has(id))next.siteSelection[key]=values[key]===''?null:Number(values[key]);return next;});
 const serial=++state.previewSerial;state.previewBusy=true;controls();note('pq-row-note','Перевіряємо налаштування…');
 try{const result=await request('/project-import/preview',{type:$('pq-type').value,items});if(serial!==state.previewSerial||session!==state.regionEdit)return;if(!Array.isArray(result.items)||!Array.isArray(result.issues))throw Error('Сервер не підтвердив налаштування.');if(result.issues.length)throw Error(result.issues.slice(0,3).map(issue=>issue.message).join(' '));state.preview={...result,source:session.preview.source};close('pq-row-settings');state.regionEdit=null;renderImportPreview(state.preview);note('pq-import-note','Налаштування застосовано. Сторінок: '+session.keys.size+'. Матеріал збережено.');}
 catch(error){if(serial===state.previewSerial&&session===state.regionEdit)note('pq-row-note',errorMessage(error),true);}
 finally{state.previewBusy=false;controls();}
}
async function previewImport(_event,automaticPayload){if(state.previewBusy||state.importBusy||state.pending||state.disabled)return;let payload;try{payload=automaticPayload||importInput();}catch(error){note('pq-import-note',errorMessage(error),true);return;}const serial=++state.previewSerial;state.preview=null;state.previewBusy=true;controls();note('pq-import-note','Перевіряємо джерело й налаштування рядків…');try{const result=await request('/project-import/preview',payload);if(serial!==state.previewSerial)return;if(!Array.isArray(result.items)||!Array.isArray(result.issues))throw Error('Сервер не підтвердив склад імпорту.');state.preview=JSON.parse(JSON.stringify(result));renderImportPreview(state.preview);note('pq-import-note',result.issues.length?'Виправте помилки джерела. '+result.issues.slice(0,3).map(issue=>issue.message).join(' '):'Рядки перевірено. Перевірте мову й географію кожної сторінки.',!!result.issues.length);return result.items.length>0&&!result.issues.length;}catch(error){if(serial===state.previewSerial){if(Array.isArray(error.issues)){state.preview={items:[],issues:error.issues};renderImportPreview(state.preview);}note('pq-import-note',errorMessage(error),true);}}finally{state.previewBusy=false;controls();}}
async function commitImport(_event,importId){
 if(state.importBusy||state.disabled||!state.preview?.items?.length||state.preview.issues.length)return;
 if(!state.pending){
  if(!$('pq-target').value&&!$('pq-name').value.trim()){note('pq-import-note','Назвіть новий проєкт.',true);$('pq-name').focus();return;}
  state.pending={idempotencyKey:importId||uuid(),type:$('pq-type').value,items:JSON.parse(JSON.stringify(state.preview.items))};
  if($('pq-target').value)state.pending.projectId=$('pq-target').value;
  else state.pending.name=$('pq-name').value.trim();
 }
 const pending=state.pending;
 state.importBusy=true;
 controls();
 note('pq-import-note','Додаємо сторінки до черги…');
 try{
  const result=await request('/project-queue/import',pending);
  const count=result?.batch?.count,duplicates=result?.batch?.duplicateCount??0;
  if(!result?.project?.id||!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(duplicates)||duplicates<0||count+duplicates>pending.items.length)throw Error('Сервер не підтвердив імпорт. Повторіть той самий запит.');
  const message=result.reused?'Імпорт уже виконано. Сторінок у попередньому імпорті: '+count+'.':[
   'Додано сторінок: '+count+'.',
   duplicates?'Пропущено дублікатів: '+duplicates+'.':'',
   count?'Підготовка виконується у своїй черзі.':''
  ].filter(Boolean).join(' ');
  state.pending=null;state.preview=null;state.files=[];state.csvText='';state.projectFile=null;state.projectFileSerial++;state.projectFileBusy=false;
  $('pq-project-file-status').textContent='';$('pq-import-form').reset();$('pq-import-preview').hidden=true;sourceOptions();targetOptions();
  window.dispatchEvent(new CustomEvent('pageposter:project-imported',{detail:{project:result.project}}));
  close('pq-import-dialog');
  await openDashboard();
  if(!state.disabled)note('pq-dashboard-note',message);
 }catch(error){
  // Only these responses confirm that the import endpoint rejected the request.
  const rejected=error.status===400&&error.code==='IMPORT_VALIDATION'||error.status===404&&error.code==='NOT_FOUND'||
   error.status===409&&['CONFLICT','IMPORT_DUPLICATE_KEY','PROJECT_TYPE_MISMATCH'].includes(error.code);
  if(rejected&&state.pending===pending)state.pending=null;
  note('pq-import-note',state.disabled?state.disabledReason:errorMessage(error),true);
 }finally{state.importBusy=false;controls();}
}
function template(){const html=$('pq-type').value==='html',text=html?'key,title,file,language,geo,minDr,minTraffic\r\npage-1,My page,page.html,pl,PL,30,100\r\n':'key,title,url,anchor,language,geo,minDr,minTraffic,format,topic\r\npage-1,My page,https://example.com/,Exact anchor,pl,PL,30,100,article,casino\r\n',url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'})),link=node('a');link.href=url;link.download='pageposter-'+(html?'html':'ai')+'-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
function laneText(value){const count=input=>Array.isArray(input)?input.length:Number(input)||0;return 'В роботі: '+count(value?.active)+' · Очікує: '+count(value?.waiting);}
function publicationOwner(value){let box=$('pq-publication-owner');if(!box){box=node('div','pq-publication-owner');box.id='pq-publication-owner';box.setAttribute('role','status');$('pq-publication').closest('.pq-lanes').after(box);}const owner=value?.owner;box.hidden=!owner;if(!owner)return;box.dataset.blocked=String(owner.blocked===true);box.replaceChildren(node('strong','',owner.title||'Поточна сторінка'),node('span','',owner.message||'Наступна сторінка чекає підтвердження поточної.'));}
function syncReviews(){for(const [id,review] of state.reviews){const item=findItem(id);if(!item||!reviewable(item)||fingerprint(item)!==review.fingerprint){state.reviews.delete(id);state.selected.delete(id);}}if(state.review){const item=findItem(state.review.id);if(!item||fingerprint(item)!==state.review.fingerprint){state.review=null;state.reviewSerial++;for(const id of ['pq-mark-reviewed','pq-mark-next','pq-review-copy','pq-review-download','pq-review-manual'])$(id).disabled=true;$('pq-review-frame').hidden=true;$('pq-review-frame').removeAttribute('srcdoc');$('pq-review-code').value='';$('pq-review-code-wrap').hidden=true;$('pq-inspector-details').replaceChildren();note('pq-review-note','Сторінка змінилась. Відкрийте актуальний перегляд ще раз.',true);window.dispatchEvent(new CustomEvent('pageposter:inspector-invalidated'));}}}
function approveButton(){const ids=[...state.selected].filter(id=>{const item=findItem(id);return item&&validReview(item);});$('pq-approve-selected').textContent='Опублікувати вибрані ('+ids.length+')';$('pq-approve-selected').disabled=state.queueBusy||state.disabled||!ids.length;$('pq-selection-count').textContent='Вибрано: '+state.selected.size+' · переглянуто: '+ids.length;$('pq-clear-selection').hidden=!state.selected.size;const eligible=[...state.selected].map(findItem);$('pq-edit-requirements').disabled=state.disabled||state.queueBusy||!eligible.length||eligible.some(item=>!item?.canEditRequirements);if(window.pageposterDesktop)for(const id of ['pq-approve-selected','pq-edit-requirements','pq-selection-count'])$(id).hidden=!state.selected.size;}
function matchesFilter(item,project){
 if(item.state==='deleted'||state.projectFilter&&projectId(project)!==state.projectFilter)return false;
 const query=$('pq-search').value.trim().toLocaleLowerCase(),status=$('pq-filter-state').value,language=$('pq-filter-language').value,geo=$('pq-filter-geo').value,countries=Array.isArray(item.geo)?item.geo:String(item.geo||'').split(',').map(value=>value.trim());
 if(query&&![item.title,item.key,item.provenance?.source?.file,item.provenance?.source?.tableFile,item.selectedSite?.baseUrl,item.fullUrl,project.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))return false;
 if(language&&item.language!==language||geo&&!countries.includes(geo))return false;
 const working=window.PagePosterPublication?.status(item.publication)?.working===true;
 if(status==='ready'&&!reviewable(item)||status==='active'&&!working&&!['running','generating','preparing','publishing','checking','queued','waiting'].includes(item.state)||status==='attention'&&(working||!['failed','uncertain','needs_attention','attention','waiting_source','paused'].includes(item.state)&&(item.manualReview?!['declined','trash_failed','trash_uncertain'].includes(item.manualReview.state):!['problem','unknown'].includes(item.verification?.state)))||status==='completed'&&(item.manualReview?.state==='trashed'||item.publication?.state==='trashed'||item.state!=='completed'&&!item.fullUrl))return false;
 return true;
}
function visibleEntries(){return (state.overview?.projects||[]).flatMap(project=>(project.items||[]).filter(item=>matchesFilter(item,project)).map(item=>({project,item})));}
function filterOptions(){
 const set=(id,entries,label)=>{const control=$(id),prior=control.value,signature=JSON.stringify(entries);if(control._options===signature)return;control._options=signature;control.replaceChildren();for(const [value,text] of [['',label],...entries]){const option=node('option','',text);option.value=value;control.appendChild(option);}control.value=[...control.options].some(option=>option.value===prior)?prior:'';};
 const projects=state.overview?.projects||[],items=projects.flatMap(project=>project.items||[]);set('pq-project-filter',projects.map(project=>[projectId(project),project.name]),'Усі проєкти');$('pq-project-filter').value=state.projectFilter;
 set('pq-filter-language',[...new Set(items.map(item=>item.language).filter(Boolean))].sort().map(value=>[value,value]),'Усі');
 set('pq-filter-geo',[...new Set(items.flatMap(item=>Array.isArray(item.geo)?item.geo:String(item.geo||'').split(',')).map(value=>value.trim()).filter(Boolean))].sort().map(value=>[value,value]),'Усі');
}
function filtersChanged(){state.projectFilter=$('pq-project-filter').value;state.selected.clear();closeReview();renderQueues();}
function choosePageDonor(item){
 if(state.disabled||state.queueBusy||!item.runId||!item.canSetDestination)return;
 const project=(state.overview?.projects||[]).find(value=>(value.items||[]).some(row=>row.id===item.id));if(!project)return;
 window.dispatchEvent(new CustomEvent('pageposter:choose-donor',{detail:{projectId:projectId(project),runId:item.runId}}));
}
function selectedSiteCell(item){
 const cell=node('td','pq-site'),site=item.selectedSite;let url;
 if(item.amp){cell.appendChild(node('p','ap-fine',item.amp.state==='ready'?(item.amp.styleMode==='compact'?'AMP підтверджено · спрощений вигляд':'AMP · підтверджено'):item.fullUrl?'AMP · потрібна перевірка':'AMP · експеримент'));if(item.amp.url&&item.fullUrl){try{const ampUrl=new URL(item.amp.url),mainUrl=new URL(item.fullUrl);if(ampUrl.protocol==='https:'&&ampUrl.origin===mainUrl.origin&&!ampUrl.username&&!ampUrl.password){const link=node('a','','Відкрити AMP ↗');link.href=ampUrl.href;link.target='_blank';link.rel='noopener noreferrer';cell.appendChild(link);}}catch{}}}
 const donorChoice=()=>{if(!item.runId||!item.pageId||item.state==='deleted'||item.fullUrl)return;if(item.donorPinned)cell.appendChild(node('span','pq-site-metrics','Обрано для цієї сторінки'));const pick=button(site?'Змінити донора':'Вибрати донора',()=>choosePageDonor(item),'ap-button ap-secondary pq-donor-button');pick.dataset.action='choose-donor';pick.setAttribute('aria-label','Вибрати донора для сторінки '+item.title);pick.disabled=state.disabled||state.queueBusy||!item.canSetDestination;if(!item.canSetDestination)pick.title=item.destinationBlockedReason||'Дочекайтеся зупинки поточної дії.';cell.appendChild(pick);};
 const reasons={
  NATIVE_VISUAL_REJECTED:'зламаний вигляд, створену сторінку переміщено в кошик',
  bootstrap_auth_failed:'дані для входу не підійшли',
  CLEAN_LINKS_INSTALL_FORBIDDEN:'WordPress відхилив встановлення плагіна для цього акаунта',
  CLEAN_LINKS_FILESYSTEM_REQUIRED:'потрібен доступ до файлів WordPress для встановлення плагіна',
  BROWSER_ORIGIN_BLOCKED:'переадресацію за межі дозволеної адреси заблоковано',
  BROWSER_PAGE_UNAVAILABLE:'не вдалося відкрити WordPress',
  NATIVE_NAVIGATION_UNAVAILABLE:'недоступне створення сторінки',
  BROWSER_TIMEOUT:'час очікування WordPress вичерпано',
  BROWSER_LOGIN_UNCONFIRMED:'не вдалося підтвердити вхід у WordPress',
  network_timeout:'час очікування відповіді сайту вичерпано',
  network_failed:'помилка з’єднання із сайтом',
  dns_failed:'DNS не знайшов адресу сайту',
  unsafe_address:'адресу сайту заблоковано',
  unsafe_url:'адресу сайту заблоковано',
  invalid_redirect:'некоректна переадресація',
  cross_origin_redirect:'переадресацію на інший сайт заблоковано',
  too_many_redirects:'забагато переадресацій'
 };
 const history=()=>{
  for(const skipped of item.skippedSites||[]){
   let host;try{host=new URL(skipped.baseUrl).hostname;}catch{continue;}
   const reason=skipped.code==='BROWSER_PAGE_UNAVAILABLE'&&Number.isInteger(skipped.httpStatus)
    ?'відповідь HTTP '+skipped.httpStatus+' при відкритті WordPress'
    :Object.hasOwn(reasons,skipped.code)?reasons[skipped.code]:'причина потребує перевірки';
   cell.appendChild(node('span','pq-site-metrics','Пропущено '+host+': '+reason));
  }
 };
 try{url=new URL(site?.baseUrl);if(url.protocol!=='https:'||url.username||url.password)url=null;}catch{}
 if(!url){cell.appendChild(node('span','ap-fine',item.error?'Сайт не підібрано':item.pageId?'Очікує підбору':'Після підготовки сторінки'));
  const d=item.selectionDiagnostics;if(d&&['total','geo','dr','eligible','reserved','available'].every(key=>Number.isSafeInteger(d[key])&&d[key]>=0)){
   const k=d.criteria||{};cell.appendChild(node('p','ap-fine','Гео: '+(k.geo||'будь-яке')+' · DR: '+(k.minDr==null?'будь-який':'від '+k.minDr)+' · трафік: '+(k.minTraffic==null?'будь-який':'від '+k.minTraffic)));
   cell.appendChild(node('p','ap-fine','Унікальні донори: '+d.total+'. За гео: '+d.geo+' → за DR: '+d.dr+' → за трафіком: '+d.eligible+'; зайнято: '+d.reserved+'; вільно: '+d.available+'.'));
   const counts=(value,keys)=>value&&keys.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0),input=d.input,unknown=d.unknown,unavailable=d.unavailable;
   if(counts(input,['nonempty','disabled','invalidUrl','invalidRow','missingCredentials']))cell.appendChild(node('p','ap-fine','Непорожні рядки джерела: '+input.nonempty+'; вимкнено: '+input.disabled+'; некоректний URL: '+input.invalidUrl+'; пошкоджені рядки: '+input.invalidRow+'; без даних для входу: '+input.missingCredentials+'.'));
   if(counts(unknown,['dr','traffic','geo']))cell.appendChild(node('p','ap-fine','Невідомі метрики (унікальні донори): DR: '+unknown.dr+'; трафік: '+unknown.traffic+'; гео: '+unknown.geo+'.'));
   if(counts(unavailable,['published','reserved','excluded','other'])&&unavailable.published+unavailable.reserved+unavailable.excluded+unavailable.other===d.reserved)cell.appendChild(node('p','ap-fine','Недоступні унікальні донори: уже опубліковано: '+unavailable.published+'; зарезервовано: '+unavailable.reserved+'; історичні відмови: '+unavailable.excluded+'; інші причини: '+unavailable.other+'.'));
   const policyCounts=[['manual','ручні заборони'],['temporary','тимчасові відмови'],['credentials','дані для входу'],['visual','вигляд'],['security','безпека']].filter(([key])=>counts(unavailable,[key])).map(([key,label])=>label+': '+unavailable[key]);if(policyCounts.length)cell.appendChild(node('p','ap-fine','Обмеження підбору: '+policyCounts.join('; ')+'.'));
  }history();donorChoice();return cell;}
 const link=node('a','pq-site-domain',url.hostname);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';cell.appendChild(link);
 cell.appendChild(node('span','pq-site-metrics','DR: '+(Number.isFinite(site.dr)?site.dr:'—')+' · трафік: '+(Number.isFinite(site.traffic)?site.traffic:'—')+' · '+(Array.isArray(site.geo)&&site.geo.length?site.geo.join(', '):'гео не вказано')));history();donorChoice();return cell;
}
function publishedReplacement(item){
 if(!item?.pageId||!Number.isSafeInteger(item.wpId)||item.wpId<1||item.publishedStatus!=='publish'||!item.fullUrl||item.cleanupPhase||['deleted','queued','waiting','generating','preparing','ready','awaiting_review','publishing'].includes(item.state))return false;
 try{const url=new URL(item.fullUrl);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}
const manualReviewLabels={pending:'Опубліковано · очікує перегляду',approved:'Опубліковано · схвалено',declined:'Опубліковано · відхилено',trash_queued:'Перенесення в кошик',trash_failed:'Не вдалося перенести в кошик',trash_uncertain:'Кошик · потрібне звірення',trashed:'У кошику WordPress'};
function itemStatusLabel(item,publication=window.PagePosterPublication?.status(item.publication,item.verification)){const problem=!item.manualReview&&!!item.fullUrl&&['problem','unknown'].includes(item.verification?.state);return manualReviewLabels[item.manualReview?.state]||publication?.label||(problem?'Опублікована · потрібна перевірка':item.state==='awaiting_review'?(item.selectedSite?'Готова до запуску':'Очікує підбору'):statuses[item.state]||item.state||'У черзі');}
function openPublishedReview(item){
 const current=findItem(item.id);
 if(!publishedReplacement(current)||!current.manualReview||current.pageRevision!==item.pageRevision)return;
 const dialog=$('pq-published-review');
 dialog.item=current;
 $('pq-published-review-page').textContent=current.title;
 $('pq-published-review-live').href=current.fullUrl;
 const editor=$('pq-published-review-editor'),editorLink=$('pq-published-review-editor-link');
 editor.hidden=!current.manualReview.canOpenEditor;
 editor.disabled=false;
 editorLink.href=current.manualReview.editorUrl||'';
 editorLink.hidden=!!current.manualReview.canOpenEditor||!current.manualReview.editorUrl;
 const {state:reviewState,canTrash,trashMessage}=current.manualReview;
 const decline=$('pq-published-review-decline'),approve=$('pq-published-review-approve');
 decline.disabled=canTrash===false;
 decline.textContent=reviewState==='trash_uncertain'?'Звірити кошик':'Відхилити';
 decline.title='Перенести сторінку в кошик WordPress';
 approve.disabled=['trash_queued','trash_uncertain'].includes(reviewState);
 note('pq-published-review-note',trashMessage||(canTrash===false?'Перенесення в кошик доступне через редактор WordPress.':''),!!trashMessage);
 open(dialog.id);
 if(reviewState!=='trash_uncertain')window.open(current.fullUrl,'_blank','noopener,noreferrer');
}
async function openWordPressEditor(item,control,dialog=null){
 if(!item||state.disabled||control.disabled)return;
 const current=findItem(item.id);
 if(!current?.manualReview?.canOpenEditor||current.pageRevision!==item.pageRevision)return;
 const target=dialog?'pq-published-review-note':'pq-dashboard-note';
 const stillCurrent=()=>!dialog||dialog.open&&dialog.item===item;
 control.disabled=true;
 note(target,'Відкриваємо редактор WordPress…');
 try{
  await request('/project-queue/items/'+encodeURIComponent(item.id)+'/open-wordpress',{expectedPageRevision:item.pageRevision});
  if(stillCurrent())note(target,'Редактор відкрито у вікні WordPress.');
 }catch(error){if(stillCurrent())note(target,errorMessage(error),true);}
 finally{if(stillCurrent())control.disabled=false;}
}
async function savePublishedReview(decision){
 const dialog=$('pq-published-review'),item=dialog.item;
 if(!dialog.open||!item||state.queueBusy||state.disabled)return;
 const approve=$('pq-published-review-approve'),decline=$('pq-published-review-decline');
 approve.disabled=decline.disabled=true;
 try{
  const result=await request('/project-queue/items/'+encodeURIComponent(item.id)+'/published-review',{decision,expectedPageRevision:item.pageRevision,...(decision==='declined'&&Number.isSafeInteger(item.manualReview?.retryTrashRevision)?{expectedTrashRevision:item.manualReview.retryTrashRevision}:{})});
  await refreshQueues();
  if(dialog.open&&dialog.item===item){
   close(dialog.id);
   note('pq-dashboard-note',decision==='approved'?'Сторінку схвалено.':result.manualReview?.state==='trashed'?'Сторінка в кошику WordPress.':'Сторінку поставлено в чергу на перенесення в кошик.');
  }
 }catch(error){if(dialog.open&&dialog.item===item)note('pq-published-review-note',errorMessage(error),true);}
 finally{if(dialog.open&&dialog.item===item){approve.disabled=item.manualReview.state==='trash_uncertain';decline.disabled=item.manualReview.canTrash===false;}}
}
function publishedRowActions(item){
 const group=node('div','pq-row-actions');if(!publishedReplacement(item))return group;
 if(item.manualReview){
  const review=button(item.manualReview.state==='trash_uncertain'?'Звірити кошик':'Перевірити сторінку',()=>openPublishedReview(item));review.dataset.action='published-review';
  review.disabled=state.disabled||state.queueBusy||item.manualReview.state==='trash_queued';group.appendChild(review);
  if(item.manualReview.canOpenEditor){
   const editor=button('Відкрити в WordPress',()=>openWordPressEditor(item,editor));
   editor.disabled=state.disabled;group.appendChild(editor);
  }else if(item.manualReview.editorUrl){
   const editor=node('a','ap-button ap-secondary','Відкрити в WordPress');
   editor.href=item.manualReview.editorUrl;editor.target='_blank';editor.rel='noopener noreferrer';
   group.appendChild(editor);
  }
 }
 if(['trash_queued','trash_uncertain'].includes(item.manualReview?.state))return group;
 const replace=button('Замінити посилання',()=>{
  if(state.disabled||state.queueBusy||!$('pq-dashboard').open||!replace.isConnected)return;
  const project=(state.overview?.projects||[]).find(value=>(value.items||[]).some(row=>row.id===item.id)),current=project?.items.find(row=>row.id===item.id);if(!current||!publishedReplacement(current)||fingerprint(current)!==fingerprint(item))return;
  const ownerId=projectId(project),filter=state.projectFilter,binding=fingerprint(current),isCurrent=({accepted=false,revision}={})=>!state.disabled&&$('pq-dashboard').open&&state.projectFilter===filter&&visibleEntries().some(entry=>{
   const row=entry.item;if(projectId(entry.project)!==ownerId||row.id!==item.id||row.pageId!==item.pageId||row.wpId!==item.wpId||row.fullUrl!==item.fullUrl||!publishedReplacement(row))return false;
   if(accepted)return true;if(Number.isSafeInteger(revision)&&Number.isSafeInteger(row.pageRevision)){if(row.pageRevision>revision)return false;if(row.pageRevision===revision)return true;}return fingerprint(row)===binding;
  });
  window.dispatchEvent(new CustomEvent('pageposter:replace-links',{detail:{pageId:current.pageId,projectId:ownerId,isCurrent}}));
 });replace.dataset.action='replace-links';replace.disabled=state.disabled||state.queueBusy;group.appendChild(replace);return group;
}
function rowSignature(item){
 return JSON.stringify([fingerprint(item),state.selected.has(item.id),validReview(item),state.queueBusy,state.disabled]);
}
function rowFor(item,signature){
 const row=node('tr');row.dataset.queueItem=item.id;row.setAttribute('aria-selected',String(state.selected.has(item.id)));const selectCell=node('td'),check=node('input');check.type='checkbox';check.setAttribute('aria-label','Вибрати сторінку '+item.title);check.disabled=state.queueBusy||state.disabled;check.checked=state.selected.has(item.id);check.title='Вибрати для масових дій. Публікація потребує перегляду.';check.addEventListener('change',()=>{if(check.checked)state.selected.add(item.id);else state.selected.delete(item.id);row.setAttribute('aria-selected',String(check.checked));row._pqSignature=rowSignature(item);const section=row.closest('.pq-project');if(section)section._pqSignature=null;renderQueues();});selectCell.appendChild(check);row.appendChild(selectCell);
 const publication=window.PagePosterPublication?.status(item.publication,item.verification),title=node('td'),name=button(item.title||item.key||'Сторінка',()=>reviewItem(item.id),'pq-row-title pq-row-open');append(title,name,node('span','pq-row-key',item.key||''),item.slug?node('span','pq-row-key','Слаг: '+item.slug):null,item.requestedDonor?node('span','pq-row-key','Донор із ТЗ: '+item.requestedDonor):null,provenanceDetails(item.provenance));if(item.error&&!publication?.working)title.appendChild(node('p',item.publication?.state==='manual_action'?'ap-fine pq-manual-notice':'pq-error',typeof item.error==='string'?item.error:item.error.message||item.error.code||'Потрібна увага'));if(item.fullUrl&&!item.manualReview){try{const url=new URL(item.fullUrl);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){const link=node('a','','Відкрити сторінку ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';title.appendChild(link);}}catch{}}row.appendChild(title);row.appendChild(node('td','',(item.language||'—')+' / '+(Array.isArray(item.geo)?item.geo.join(', '):item.geo||'—')));row.appendChild(selectedSiteCell(item));
 const status=node('td'),problem=!item.manualReview&&!!item.fullUrl&&['problem','unknown'].includes(item.verification?.state),label=itemStatusLabel(item,publication);status.appendChild(node('span','pq-state '+(item.manualReview?'publication-'+(item.manualReview.state==='approved'?'good':'warning'):publication?'publication-'+(publication.type||'working'):item.state)+(problem?' attention':''),label));if(item.manualReview?.trashMessage)status.appendChild(node('p','ap-fine',item.manualReview.trashMessage));if(item.pluginFallback&&item.manualReview?.state!=='trashed')status.appendChild(node('p','ap-fine',item.cleanupPhase?'Зламаний вигляд · підтверджуємо кошик':item.manualReview?'Опубліковано без Clean Links':'Без Clean Links · перевірка вигляду'));if(item.publication?.state==='crawl_blocked')status.appendChild(node('p','ap-fine','robots.txt забороняє Googlebot обходити цю сторінку.'));else if(problem&&item.verification?.summary)status.appendChild(node('p','ap-fine',item.verification.summary));const diagnostics=window.PagePosterPublication?.diagnostics(item.publication);if(diagnostics)status.appendChild(diagnostics);row.appendChild(status);
 const actions=node('td'),group=publishedRowActions(item),manual=['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(item.error?.code);if(item.runId||item.pageId){const preview=button(validReview(item)?'Переглянуто ✓':'Перегляд',()=>reviewItem(item.id));preview.dataset.action='preview';preview.disabled=state.disabled||state.queueBusy;group.appendChild(preview);}if(item.publicationParked&&item.canResumeParked===true){const resume=button('Продовжити відкладену сторінку',()=>queueAction('/autopilot/'+encodeURIComponent(item.runId)+'/resume',{}));resume.dataset.action='resume-parked';resume.disabled=state.disabled||state.queueBusy;group.appendChild(resume);}if(item.publicationParked&&item.canResumeParked!==true)group.appendChild(node('p','ap-fine',item.parkedResumeBlockedReason||'Продовження недоступне. Оновіть стан сторінки.'));if(item.canPark){const park=button('Відкласти й продовжити чергу',()=>queueAction('/project-queue/items/'+encodeURIComponent(item.id)+'/park',{}));park.dataset.action='park';park.title='Зберегти поточний стан і донора. Повернення до цієї сторінки — окремою дією.';park.disabled=state.disabled||state.queueBusy;group.appendChild(park);}if(item.canContinueQueue){const advance=button('Залишити й продовжити чергу',()=>queueAction('/project-queue/items/'+encodeURIComponent(item.id)+'/continue-crawl-blocked',{expectedRevision:item.publication.revision}));advance.disabled=state.disabled||state.queueBusy;group.appendChild(advance);}if(item.canRecheckPublished){const recheck=button('Перевірити опубліковану сторінку',()=>queueAction('/autopilot/'+encodeURIComponent(item.runId)+'/reconcile',{expectedRevision:item.publication.revision}));recheck.dataset.action='recheck-published';recheck.disabled=state.disabled||state.queueBusy;group.appendChild(recheck);}else if(!item.manualReview&&item.runId&&item.publication?.canReconcile){const reconcile=button('Звірити стан',()=>window.dispatchEvent(new CustomEvent('pageposter:reconcile-publication',{detail:{run:{id:item.runId,publication:item.publication}}})));reconcile.dataset.action='reconcile';reconcile.disabled=state.disabled||state.queueBusy;group.appendChild(reconcile);}if(!item.publicationParked&&item.canRetry===true){const retry=button(manual||item.cleanupPhase?'Продовжити':item.publication?.checkpoint==='draft'?'Продовжити публікацію':'Повторити',()=>queueAction('/project-queue/items/'+encodeURIComponent(item.id)+'/retry',{}));retry.dataset.action='retry';retry.disabled=state.disabled||state.queueBusy;group.appendChild(retry);}if(item.pageId&&item.fullUrl&&(!state.overview.manualPublishedReview||item.verification)){const reports=node('details','ap-link-report-action');reports.appendChild(node('summary','','Звіти'));const report=button('Звіт посилань',()=>window.dispatchEvent(new CustomEvent('pageposter:link-report',{detail:{pageId:item.pageId}})));report.dataset.action='link-report';report.disabled=state.disabled||state.queueBusy;reports.appendChild(report);group.appendChild(reports);}actions.appendChild(group);row.appendChild(actions);row._pqSignature=signature;return row;
}
function rememberFocus(section){const active=document.activeElement;if(!section.contains(active))return null;const row=active.closest('[data-queue-item]'),head=active.closest('thead'),scope=row||head||section.querySelector('.pq-project-heading');if(!scope?.contains(active))return null;return {active,rowId:row?.dataset.queueItem,head:!!head,index:[...scope.querySelectorAll('button,input,select,a,summary')].indexOf(active),label:active.getAttribute('aria-label'),action:active.dataset.action};}
function restoreFocus(section,saved){if(!saved||saved.active.isConnected)return;const scope=saved.rowId?[...section.querySelectorAll('[data-queue-item]')].find(row=>row.dataset.queueItem===saved.rowId):section.querySelector(saved.head?'thead':'.pq-project-heading'),controls=[...(scope?.querySelectorAll('button,input,select,a,summary')||[])],target=(saved.label&&controls.find(control=>control.getAttribute('aria-label')===saved.label))||(saved.action&&controls.find(control=>control.dataset.action===saved.action))||controls[saved.index];if(target&&!target.disabled)target.focus({preventScroll:true});}
function renderQueues(){
 $('pq-dashboard-close').disabled=state.disabled||state.queueBusy||!state.overview;$('pq-dashboard-close').title=!state.overview?'Спочатку оновіть список проєктів.':'';
 const data=state.overview||{projects:[]},root=$('pq-projects'),dialog=$('pq-dashboard'),dialogScroll={top:dialog.scrollTop,left:dialog.scrollLeft},existing=new Map([...root.children].filter(section=>section.dataset.queueProject).map(section=>[section.dataset.queueProject,section])),retained=new Set();filterOptions();
 const filtering=['pq-search','pq-filter-state','pq-filter-language','pq-filter-geo'].some(id=>!!$(id).value),visible=new Set(visibleEntries().map(entry=>entry.item.id));for(const id of state.selected)if(!visible.has(id))state.selected.delete(id);if(window.pageposterDesktop)$('pq-reset-filters').hidden=!filtering;
 $('pq-generation').textContent=laneText(data.generation);$('pq-publication').textContent=laneText(data.publication);publicationOwner(data.publication);
 if(!data.projects.length){root.replaceChildren(node('p','pq-empty','Проєктів у чергах ще немає. Імпортуйте таблицю або готові HTML-файли.'));approveButton();return;}
 for(const empty of root.querySelectorAll(':scope > .pq-empty'))empty.remove();let index=0;
 for(const project of data.projects){
  const id=projectId(project);if(state.projectFilter&&id!==state.projectFilter)continue;
  const displayItems=(project.items||[]).filter(item=>visible.has(item.id)),previous=existing.get(id),signature=JSON.stringify([{...project,items:(project.items||[]).map(fingerprint)},displayItems.map(item=>item.id),filtering,state.queueBusy,state.disabled,(project.items||[]).map(item=>[state.selected.has(item.id),validReview(item)])]);retained.add(id);
  if(previous?._pqSignature===signature){if(root.children[index]!==previous)root.insertBefore(previous,root.children[index]||null);index++;continue;}
  const section=node('section','pq-project'),heading=node('div','pq-project-heading'),description=node('div'),counts=project.counts||{},plan=project.publicationPlan;section.dataset.queueProject=projectId(project);
  append(description,node('h3','',project.name),node('p','',(workflow(project)==='html'?'Готовий HTML':'Генерація AI')+(project.paused?' · Призупинено':'')+' · Всього: '+(counts.total??project.items?.length??0)+' · Очікує: '+(counts.waiting||0)+' · Готові: '+(counts.ready||0)+' · Опубліковано: '+(counts.completed||0)+' · Увага: '+(counts.attention||0)));
  const actions=node('div','pq-actions'),start=button('Почати публікацію проєкту'+(plan?.count?' ('+plan.count+')':''),()=>startProject(project),'ap-button ap-primary');start.dataset.action='start-project';start.disabled=state.queueBusy||state.disabled||project.paused||!plan?.token||filtering;actions.appendChild(start);
  const pause=button(project.paused?'Продовжити проєкт':'Пауза після поточної',()=>queueAction('/projects/'+encodeURIComponent(projectId(project))+'/queue',{action:project.paused?'resume':'pause'}));pause.dataset.action=project.paused?'resume':'pause';pause.disabled=state.queueBusy||state.disabled;pause.title='Зупиняє нові завдання. Уже розпочата дія завершується.';actions.appendChild(pause);
  const more=node('details','pq-more'),summary=node('summary','','Дії проєкту'),moreBody=node('div');append(more,summary,moreBody);actions.appendChild(more);moreBody.appendChild(button('Додати одну сторінку',()=>composePage(id)));moreBody.appendChild(button('Змінити мову / GEO / DR / трафік',()=>openRequirements(displayItems.filter(item=>item.canEditRequirements))));if(!state.overview.manualPublishedReview&&(project.items||[]).some(item=>item.fullUrl))moreBody.appendChild(button('Перевірити опубліковані',event=>window.dispatchEvent(new CustomEvent('pageposter:queue-check-project',{detail:{projectId:id,control:event.currentTarget}}))));
  moreBody.appendChild(button('Трафік проксі',()=>{more.open=false;summary.focus({preventScroll:true});openProxyUsage({projectId:id},project.name);}));
  const amp=button(project.ampMode?'Вимкнути AMP (експеримент)':'Увімкнути AMP (експеримент)',async()=>{
   amp.disabled=true;
   try{await request('/projects/'+encodeURIComponent(id)+'/amp-mode',{enabled:!project.ampMode});await refreshQueues();note('pq-dashboard-note',project.ampMode?'AMP вимкнено. Проєкт використовує звичайний HTML.':'AMP увімкнено для цього проєкту. Перегляньте HTML перед запуском. Потрібен доступ установити Clean Links 1.2.1.');}
   catch(error){note('pq-dashboard-note',error?.code==='CONFLICT'?'Режим AMP можна змінювати до початку публікації проєкту.':errorMessage(error),true);}
   finally{amp.disabled=false;}
  });
  amp.title='Окремий режим. Не створює другу сторінку WordPress. Не змінює вже опубліковані сторінки.';amp.disabled=state.queueBusy||state.disabled;moreBody.appendChild(amp);
  const priorityLabel=node('label','pq-priority','Пріоритет'),priority=node('select');priority.setAttribute('aria-label','Пріоритет проєкту '+project.name);for(let value=0;value<=10;value++){const option=node('option','',value);option.value=value;priority.appendChild(option);}priority.value=Number.isFinite(project.priority)?project.priority:5;priority.disabled=state.queueBusy||state.disabled;priority.addEventListener('change',()=>queueAction('/projects/'+encodeURIComponent(projectId(project))+'/queue',{action:project.paused?'pause':'resume',priority:Number(priority.value)}));append(priorityLabel,priority);moreBody.appendChild(priorityLabel);append(heading,description,actions);section.appendChild(heading);
  section.appendChild(node('p','pq-project-plan','Підібрано сайтів: '+(project.items||[]).filter(item=>item.selectedSite).length+' / '+(counts.total??project.items?.length??0)+'. '+(filtering?'Показано за фільтрами: '+displayItems.length+'. Для запуску всього проєкту скиньте фільтри.':plan?.blockedReason||plan?.notice||'Запуск схвалює показаний список готових сторінок. Публікація йде по одній; нові рядки потребують окремого запуску.')));
  const wrap=node('div','pq-table-wrap'),table=node('table','pq-table'),head=node('thead'),header=node('tr'),selectAll=node('input');selectAll.type='checkbox';selectAll.setAttribute('aria-label','Вибрати всі показані сторінки проєкту '+project.name);selectAll.checked=!!displayItems.length&&displayItems.every(item=>state.selected.has(item.id));selectAll.indeterminate=displayItems.some(item=>state.selected.has(item.id))&&!selectAll.checked;selectAll.disabled=state.queueBusy||state.disabled||!displayItems.length;selectAll.addEventListener('change',()=>{for(const item of displayItems){if(selectAll.checked)state.selected.add(item.id);else state.selected.delete(item.id);}renderQueues();});const selectionHead=node('th');selectionHead.appendChild(selectAll);header.appendChild(selectionHead);for(const text of ['Сторінка','Мова / гео','Сайт для публікації','Стан','Дії'])header.appendChild(node('th','',text));head.appendChild(header);table.appendChild(head);
  const oldTable=previous?.querySelector('.pq-table');
  const body=oldTable?.tBodies[0]||node('tbody');
  const oldRows=new Map([...body.rows].map(row=>[row.dataset.queueItem,row]));
  const rows=displayItems.map(item=>{
   const signature=rowSignature(item),old=oldRows.get(item.id);
   return old?._pqSignature===signature?old:rowFor(item,signature);
  });
  if(!rows.length){
   const empty=oldRows.get(undefined)||node('tr');
   if(!empty.firstChild){
    const cell=node('td','pq-empty','За цими фільтрами сторінок немає.');cell.colSpan=6;empty.appendChild(cell);
   }
   rows.push(empty);
  }
  const target=previous||section;
  if(previous){
   const scroller=oldTable.parentElement,scroll={top:scroller.scrollTop,left:scroller.scrollLeft};
   const focused=rememberFocus(previous);
   more.open=!!previous.querySelector('.pq-more')?.open;
   previous.querySelector('.pq-project-heading').replaceWith(heading);
   previous.querySelector('.pq-project-plan').replaceWith(section.querySelector('.pq-project-plan'));
   oldTable.tHead.replaceWith(head);
   // Remove filtered and replaced rows first so a filter cannot move every retained row.
   const retainedRows=new Set(rows);
   for(const row of [...body.rows])if(!retainedRows.has(row))row.remove();
   let next=body.firstElementChild;
   for(const row of rows){
    if(row!==next)body.insertBefore(row,next);
    next=row.nextElementSibling;
   }
   restoreFocus(previous,focused);
   if(scroller.scrollTop!==scroll.top)scroller.scrollTop=scroll.top;
   if(scroller.scrollLeft!==scroll.left)scroller.scrollLeft=scroll.left;
  }else{
   for(const row of rows)body.appendChild(row);
   table.appendChild(body);wrap.appendChild(table);section.appendChild(wrap);
  }
  target._pqSignature=signature;if(root.children[index]!==target)root.insertBefore(target,root.children[index]||null);index++;
 }
 for(const [id,section] of existing)if(!retained.has(id))section.remove();dialog.scrollTop=dialogScroll.top;dialog.scrollLeft=dialogScroll.left;approveButton();
}
async function startProject(project){
 if(state.queueBusy||state.disabled||!project.publicationPlan?.token||project.paused)return;const planToken=project.publicationPlan.token;state.queueBusy=true;renderQueues();
 try{const result=await request('/projects/'+encodeURIComponent(projectId(project))+'/queue/start',{planToken});await refreshQueues();note('pq-dashboard-note','Проєкт запущено. Сторінок у черзі публікації: '+result.queued+'. Розміщення виконується по одній сторінці.');window.dispatchEvent(new CustomEvent('pageposter:queue-updated'));}
 catch(error){note('pq-dashboard-note',errorMessage(error),true);await refreshQueues().catch(()=>{});}
 finally{state.queueBusy=false;renderQueues();}
}
function schedule(){clearTimeout(state.timer);if($('pq-dashboard').open&&!state.disabled){const active=(state.overview?.projects||[]).some(p=>!p.paused&&(p.counts?.waiting||p.counts?.generating||p.counts?.publishing));state.timer=setTimeout(()=>refreshQueues().catch(()=>{}),document.hidden?15000:active?3000:10000);}}
let queueRefresh=null,queueRefreshAgain=false;
function refreshQueues(){if(queueRefresh){queueRefreshAgain=true;return queueRefresh;}queueRefresh=(async()=>{let error;do{queueRefreshAgain=false;try{await readQueues();error=null;}catch(failure){error=failure;}}while(queueRefreshAgain);if(error)throw error;})().finally(()=>{queueRefresh=null;});return queueRefresh;}
async function readQueues(){if(state.disabled)return;const serial=++state.refreshSerial;$('pq-refresh').disabled=true;try{const data=await request('/project-queue');if(serial!==state.refreshSerial)return;if(!Array.isArray(data.projects))throw Error('Сервер не підтвердив стан черг.');state.overview=data;syncReviews();renderQueues();}catch(error){if(serial===state.refreshSerial)note('pq-dashboard-note',errorMessage(error),true);throw error;}finally{if(serial===state.refreshSerial)$('pq-refresh').disabled=false;schedule();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('pq-dashboard')?.open)void refreshQueues().catch(()=>{});});
async function openDashboard(id){if(state.disabled)return;if(typeof id==='string'){state.projectFilter=id;state.selected.clear();}closeReview();open('pq-dashboard');note('pq-dashboard-note','');try{await refreshQueues();}catch{}}
async function queueAction(endpoint,payload){if(state.queueBusy||state.disabled)return;state.queueBusy=true;renderQueues();try{await request(endpoint,payload);await refreshQueues();note('pq-dashboard-note','Стан проєкту оновлено.');}catch(error){note('pq-dashboard-note',errorMessage(error),true);}finally{state.queueBusy=false;renderQueues();}}
function closeReview(){state.review=null;state.reviewSerial++;$('pq-review-frame').removeAttribute('srcdoc');$('pq-mark-reviewed').disabled=true;for(const id of ['pq-review-copy','pq-review-download','pq-review-manual','pq-mark-next'])if($(id))$(id).disabled=true;if($('pq-review-code'))$('pq-review-code').value='';if($('pq-inspector-details'))$('pq-inspector-details').replaceChildren();if($('pq-review').open)close('pq-review');window.dispatchEvent(new CustomEvent('pageposter:inspector-invalidated'));}
async function reviewItem(id){
 const item=findItem(id);if(!item||state.disabled)return;
 const serial=++state.reviewSerial;state.review={id,fingerprint:fingerprint(item),token:null,loaded:false};
 const project=(state.overview?.projects||[]).find(project=>(project.items||[]).some(row=>row.id===id));
 $('pq-review-context').textContent=[project?.name,item.key,item.language,Array.isArray(item.geo)?item.geo.join(', '):item.geo,item.selectedSite?.baseUrl||'Донор ще не підібрано'].filter(Boolean).join(' · ');
 $('pq-inspector-details').replaceChildren();const origin=provenanceDetails(item.provenance);if(origin)$('pq-inspector-details').appendChild(origin);$('pq-review-code-wrap').hidden=true;$('pq-review-code').value='';for(const controlId of ['pq-review-copy','pq-review-download','pq-review-manual','pq-mark-next'])$(controlId).disabled=true;
 if(item.runId&&project)$('pq-inspector-details').appendChild(button('Трафік проксі',()=>openProxyUsage({projectId:projectId(project),runId:item.runId},item.title)));
 const actions=node('div');$('pq-inspector-details').appendChild(actions);
 window.dispatchEvent(new CustomEvent('pageposter:queue-item-details',{detail:{projectId:projectId(project||{}),runId:item.runId,pageId:item.pageId,target:actions,isCurrent:()=>serial===state.reviewSerial&&$('pq-review').open}}));
 $('pq-review-title').textContent=item.title||'Перегляд сторінки';$('pq-mark-reviewed').disabled=true;$('pq-review-frame').hidden=true;
 $('pq-review-warnings').replaceChildren();for(const warning of item.warnings||[])$('pq-review-warnings').appendChild(node('li','',warning));$('pq-review-warnings').hidden=!item.warnings?.length;
 note('pq-review-note','Завантажуємо збережений HTML…');open('pq-review');
 if(!item.runId&&!item.pageId){note('pq-review-note','Сторінка очікує підготовки. Готовий HTML з’явиться тут автоматично після обробки.');return;}
 try{
  let result;if(item.runId)result=await request('/autopilot/'+encodeURIComponent(item.runId)+'/html');else{const saved=await request('/pages/'+encodeURIComponent(item.pageId));result={html:saved.page?.remoteSnapshot?.content};}
  if(serial!==state.reviewSerial||!$('pq-review').open)return;
  const current=findItem(id);if(!current||fingerprint(current)!==state.review.fingerprint)throw Error('Сторінка змінилась. Відкрийте актуальний перегляд ще раз.');
  if(typeof result.html!=='string'||!result.html)throw Error(item.fullUrl?'У цієї старої сторінки немає збереженої копії HTML. Оригінал і дії доступні нижче.':'У сторінки ще немає готового HTML.');
  state.review.token=typeof result.reviewToken==='string'?result.reviewToken:null;
  const frame=node('iframe');frame.id='pq-review-frame';frame.title='Перегляд сторінки з черги';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
  frame.addEventListener('load',()=>{if(serial!==state.reviewSerial||!state.review)return;state.review.loaded=true;state.review.html=result.html;for(const controlId of ['pq-review-copy','pq-review-download','pq-review-manual'])$(controlId).disabled=controlId==='pq-review-manual'&&!item.runId;$('pq-mark-reviewed').disabled=!state.review.token||!reviewable(findItem(id));$('pq-mark-next').disabled=$('pq-mark-reviewed').disabled;fitReview();note('pq-review-note',state.review.token&&reviewable(findItem(id))?'Перевірте сторінку перед підтвердженням.':'HTML доступний для перегляду. Схвалення цієї сторінки зараз недоступне.');},{once:true});
  frame.srcdoc=result.html;$('pq-review-frame').replaceWith(frame);
 }catch(error){if(serial===state.reviewSerial)note('pq-review-note',errorMessage(error),true);}
}
function markReviewed(){const review=state.review,item=review&&findItem(review.id);if(!review?.loaded||!review.token||!item||!reviewable(item)||fingerprint(item)!==review.fingerprint)return;state.reviews.set(review.id,{token:review.token,fingerprint:review.fingerprint});closeReview();renderQueues();}
async function approveSelected(){if(state.queueBusy||state.disabled)return;const items=[];for(const id of state.selected){const item=findItem(id),review=item&&validReview(item);if(review)items.push({id,reviewToken:review.token});}if(!items.length)return;state.queueBusy=true;renderQueues();try{await request('/project-queue/approve',{items});for(const item of items){state.reviews.delete(item.id);state.selected.delete(item.id);}await refreshQueues();note('pq-dashboard-note','Передано на публікацію: '+items.length+'.');window.dispatchEvent(new CustomEvent('pageposter:queue-updated'));}catch(error){if(['REVIEW_REQUIRED','HTML_REVIEW_REQUIRED','CONFLICT'].includes(error.code))for(const item of items){state.reviews.delete(item.id);state.selected.delete(item.id);}note('pq-dashboard-note',errorMessage(error),true);}finally{state.queueBusy=false;renderQueues();}}
function device(mobile){$('pq-review-frame').parentElement.classList.toggle('is-mobile',mobile);$('pq-review-mobile').setAttribute('aria-pressed',String(mobile));$('pq-review-desktop').setAttribute('aria-pressed',String(!mobile));fitReview();}
function fitReview(){const frame=$('pq-review-frame'),canvas=frame?.parentElement;if(!canvas||frame.hidden)return;const width=canvas.classList.contains('is-mobile')?390:1280,available=Math.max(1,canvas.clientWidth-20),scale=Math.min(1,available/width),height=Math.max(220,canvas.clientHeight-20);Object.assign(frame.style,{width:width+'px',height:Math.ceil(height/scale)+'px',left:Math.max(10,(canvas.clientWidth-width*scale)/2)+'px',top:'10px',transform:'scale('+scale+')'});}
function composePage(id=state.projectFilter){if(state.disabled||state.queueBusy)return;if(!state.overview){note('pq-dashboard-note','Список проєктів ще не завантажено. Натисніть «Оновити зараз».',true);return;}note('pq-dashboard-note','');if(!id){window.dispatchEvent(new Event('pageposter:queue-project-create'));return;}closeReview();window.dispatchEvent(new CustomEvent('pageposter:queue-project-open',{detail:{projectId:id,newPage:true}}));}
function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
async function exportPrepared(control){
 if(state.disabled||control.disabled)return;
 const ready=item=>item.runId&&item.pageId&&item.pageRevision>0&&item.state!=='deleted';
 const visible=visibleEntries().map(entry=>entry.item),selected=visible.filter(item=>state.selected.has(item.id));
 const pages=selected.length?selected:visible.filter(ready);
 if(!pages.length||pages.some(item=>!ready(item))){note('pq-dashboard-note','Оберіть готові сторінки з доступним передпереглядом.',true);return;}
 if(pages.length>100){note('pq-dashboard-note','Виберіть до 100 готових сторінок для одного ZIP.',true);return;}
 const items=pages.map(({id,pageId,pageRevision})=>({id,pageId,pageRevision}));
 control.disabled=true;
 try{
  const archive=await request('/project-queue/export-prepared',{items},{zip:true});
  if(state.disabled)return;
  download(archive,'pageposter-prepared.zip','application/zip');
  note('pq-dashboard-note','Готовий ZIP · сторінок: '+items.length+'. Перевірте audit.json перед ручною публікацією.');
 }catch(error){if(!state.disabled)note('pq-dashboard-note',errorMessage(error),true);}
 finally{control.disabled=false;}
}
function exportList(){const quote=value=>{let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';},rows=[['Проєкт','Ключ','Сторінка','Мова','Гео','Мін. DR','Мін. трафік','Донор','DR донора','Трафік донора','Стан','URL','Помилка'],...visibleEntries().map(({project,item})=>[project.name,item.key,item.title,item.language,Array.isArray(item.geo)?item.geo.join(', '):item.geo,item.siteSelection?.minDr,item.siteSelection?.minTraffic,item.selectedSite?.baseUrl,item.selectedSite?.dr,item.selectedSite?.traffic,itemStatusLabel(item),item.fullUrl,item.error?.message||item.error?.code||''])];download('\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n'),'pageposter-pages.csv','text/csv;charset=utf-8');}
let proxyUsageSerial=0;
async function openProxyUsage(scope,title){
 if(state.disabled)return;
 const serial=++proxyUsageSerial,dialog=$('pq-proxy-usage'),result=$('pq-proxy-usage-result');
 $('pq-proxy-usage-name').textContent=title;
 result.textContent='Читаємо лічильники…';open(dialog.id);
 const current=()=>serial===proxyUsageSerial&&dialog.open&&!state.disabled;
 const number=new Intl.NumberFormat('uk-UA'),describe=counts=>
  'Надіслано '+number.format(counts.bytesSent)+' Б · отримано '+number.format(counts.bytesReceived)+' Б · запитів '+number.format(counts.requests)+' · спроб з’єднання '+number.format(counts.connections);
 try{
  const {usage,route}=await request('/proxy/usage',scope);
  if(!current())return;
  result.replaceChildren(node('p','','Усього · '+describe(usage.total)),
   node('p','ap-fine','Браузер · '+describe(usage.byScope.browser)),
   node('p','ap-fine','Перевірка сторінки · '+describe(usage.byScope.verification)));
  if(route){
   result.appendChild(node('p','','Закріплено · '+route.label));
   result.appendChild(node('p','ap-fine',route.ip?'Остання перевірка · '+route.ip+' · '+(route.country||'країна невідома')+' · '+new Date(route.checkedAt).toLocaleString():'IP поточної сесії не виміряно.'));
  }
  if(scope.runId&&usage.attempts.length){
   const list=node('ol');
   for(const [index,attempt] of usage.attempts.entries())list.appendChild(node('li','ap-fine','Спроба '+(index+1)+' · '+describe(attempt.total)));
   result.appendChild(list);
  }
  if(usage.incomplete)result.appendChild(node('p','ap-fine','Частину лічильників не вдалося записати.'));
 }catch(error){if(current())result.textContent=errorMessage(error);}
}
function openRequirements(items){
 if(state.disabled||state.queueBusy)return;
 if(!items.length||items.some(item=>!item.canEditRequirements)){note('pq-dashboard-note','Оберіть сторінки, для яких WordPress ще не запускався.',true);return;}
 state.requirements=items.map(item=>({id:item.id,expectedRevision:item.requirementsRevision}));
 $('pq-requirements-form').reset();
 for(const name of ['dr','traffic','geo','language'])$('pq-requirements-'+name).disabled=true;
 const languageLocked=items.some(item=>item.canEditLanguage!==true);
 $('pq-requirements-language-change').disabled=languageLocked;
 $('pq-requirements-language').value=items.every(item=>item.language===items[0].language)?items[0].language||'':'';
 $('pq-requirements-language-help').textContent=languageLocked?'У групі є AI-сторінки, для яких зміна мови потребує нової генерації. Їхні GEO, DR і трафік можна змінити.':'Для готового HTML змінюється тільки позначка мови. Текст і оформлення зберігаються.';
 $('pq-requirements-count').textContent='Сторінок: '+items.length+'. Зміняться лише позначені поля. Для змінених сторінок потрібно знову підібрати донора й підтвердити перегляд.';
 note('pq-requirements-note','');open('pq-requirements');
}
async function applyRequirements(event){event.preventDefault();const items=state.requirements;if(!items||state.queueBusy||state.disabled)return;const changes={};for(const [name,key] of [['dr','minDr'],['traffic','minTraffic']]){if($('pq-requirements-'+name+'-change').checked){const raw=$('pq-requirements-'+name).value.trim();changes[key]=raw===''?null:Number(raw);}}if($('pq-requirements-geo-change').checked)changes.geo=$('pq-requirements-geo').value.trim();if($('pq-requirements-language-change').checked)changes.language=$('pq-requirements-language').value.trim();if(!Object.keys(changes).length){note('pq-requirements-note','Позначте показник, який потрібно змінити.',true);return;}const control=$('pq-requirements-apply');control.disabled=true;state.queueBusy=true;try{const result=await request('/project-queue/requirements',{items,changes});if(state.requirements!==items)return;state.requirements=null;state.selected.clear();closeReview();close('pq-requirements');await refreshQueues();note('pq-dashboard-note','Вимоги оновлено для '+result.updated+' сторінок. Донори підбиратимуться заново.');window.dispatchEvent(new CustomEvent('pageposter:queue-updated'));}catch(error){note('pq-requirements-note',errorMessage(error),true);}finally{state.queueBusy=false;control.disabled=false;renderQueues();}}
function freezeAfterRecovery(event){
 const unconfirmed=event.type==='pageposter:recovery-restart-required';
 state.disabled=true;
 state.disabledReason=(unconfirmed?'Відновлення не підтверджено.':'Копію відновлено.')+' Перезапустіть PagePoster перед продовженням роботи.';
 state.previewSerial++;state.refreshSerial++;clearTimeout(state.timer);closeReview();controls();renderQueues();
 $('pq-refresh').disabled=true;
 note('pq-dashboard-note',state.disabledReason,unconfirmed);
 if($('pq-import-dialog').open)note('pq-import-note',state.disabledReason,unconfirmed);
}
function init(){if(!$('pq-import-open'))return;$('pq-auto-file').addEventListener('change',automaticImport);$('pq-auto-retry').addEventListener('click',retryAutomaticImport);$('pq-import-open').addEventListener('click',openImport);$('pq-import-more').addEventListener('click',openImport);$('pq-dashboard-open').addEventListener('click',openDashboard);$('pq-refresh').addEventListener('click',()=>refreshQueues().catch(()=>{}));$('pq-import-close').addEventListener('click',()=>close('pq-import-dialog'));$('pq-dashboard-close').addEventListener('click',()=>close('pq-dashboard'));$('pq-review-close').addEventListener('click',closeReview);$('pq-preview-import').addEventListener('click',previewImport);$('pq-commit-import').addEventListener('click',commitImport);$('pq-template').addEventListener('click',template);$('pq-approve-selected').addEventListener('click',approveSelected);$('pq-mark-reviewed').addEventListener('click',markReviewed);$('pq-review-desktop').addEventListener('click',()=>device(false));$('pq-review-mobile').addEventListener('click',()=>device(true));$('pq-review').addEventListener('cancel',event=>{event.preventDefault();closeReview();});$('pq-review').addEventListener('close',()=>{if(!$('pq-review').open&&state.review)closeReview();});$('pq-dashboard').addEventListener('close',()=>clearTimeout(state.timer));for(const id of ['pq-import-dialog','pq-dashboard','pq-review'])$(id).addEventListener('close',()=>{const target=$(id)._pqFocus;if(target?.isConnected&&!target.disabled)target.focus({preventScroll:true});});$('pq-type').addEventListener('change',()=>{invalidate();$('pq-source').value='';sourceOptions();targetOptions();});$('pq-source').addEventListener('change',()=>{invalidate();renderSources();});$('pq-target').addEventListener('change',()=>{invalidate();renderTarget();});$('pq-default-topic').addEventListener('change',renderSources);$('pq-html-attachment').addEventListener('change',renderSources);$('pq-import-form').addEventListener('submit',event=>{event.preventDefault();previewImport();});for(const control of $('pq-import-form').querySelectorAll('input:not([type=file]),textarea,select')){if(['pq-type','pq-source','pq-target'].includes(control.id))continue;control.addEventListener(control.tagName==='SELECT'?'change':'input',invalidate);}$('pq-project-file').addEventListener('change',readProjectFile);$('pq-csv-file').addEventListener('change',readCsv);$('pq-html-files').addEventListener('change',readHtmlFiles);window.addEventListener('pageposter:recovery-restored',freezeAfterRecovery);window.addEventListener('pageposter:recovery-restart-required',freezeAfterRecovery);sourceOptions();controls();}
function initRegionControls(){
 if(!$('pq-row-form'))return;
 // ISO 3166-1 alpha-2: keep native code + country-name suggestions available
 // immediately, including for a single letter or an empty input.
 const countries='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
 const options=$('pq-country-options');options.replaceChildren(...countries.map(code=>{const option=node('option');option.value=code;option.textContent=countryName(code);return option;}));
 for(const id of ['pq-default-geo','pq-row-geo','pq-requirements-geo'])$(id).setAttribute('list',options.id);
 $('pq-bulk-form').addEventListener('submit',applyBulkSettings);
 $('pq-row-form').addEventListener('submit',applyRowSettings);
 $('pq-row-close').addEventListener('click',()=>close('pq-row-settings'));
 $('pq-row-settings').addEventListener('close',()=>{state.regionEdit=null;const target=$('pq-row-settings')._pqFocus;if(target?.isConnected&&!target.disabled)target.focus({preventScroll:true});});
 for(const id of ['pq-row-language','pq-row-geo','pq-row-dr','pq-row-traffic'])$(id).addEventListener(id==='pq-row-language'?'change':'input',()=>state.regionEdit?.touched.add(id));
}
function installWorkspace(){
 const stylesheet=node('link');stylesheet.rel='stylesheet';stylesheet.href='workspace.css';document.head.appendChild(stylesheet);
 $('ap-main').appendChild($('pq-dashboard'));$('pq-review').classList.add('pq-inspector');
 const context=node('p');context.id='pq-review-context';$('pq-review').querySelector('.ap-dialog-heading').after(context);
 const tools=node('div','pq-inspector-tools'),copy=button('Копіювати HTML',async()=>{const review=state.review;if(!review?.html)return;try{await navigator.clipboard.writeText(review.html);if(state.review===review)note('pq-review-note','Готовий HTML скопійовано.');}catch{if(state.review!==review)return;$('pq-review-code').value=review.html;$('pq-review-code-wrap').hidden=false;$('pq-review-code').focus();$('pq-review-code').select();note('pq-review-note','Код виділено. Натисніть Ctrl+C.');}}),save=button('Завантажити HTML',()=>{if(state.review?.html)download(state.review.html,'pageposter-'+(findItem(state.review.id)?.key||'page').replace(/[^\p{L}\p{N}._-]/gu,'-')+'.html','text/html;charset=utf-8');});copy.id='pq-review-copy';save.id='pq-review-download';copy.disabled=save.disabled=true;append(tools,copy,save);$('pq-review').querySelector('.pq-actions').appendChild(tools);
 const code=node('label','ap-field');code.id='pq-review-code-wrap';code.hidden=true;code.textContent='Готовий HTML — для ручного копіювання';const textarea=node('textarea');textarea.id='pq-review-code';textarea.readOnly=true;textarea.rows=8;textarea.spellcheck=false;code.appendChild(textarea);$('pq-review').appendChild(code);
 const manual=button('Ручне розміщення',()=>{const review=state.review,item=review&&findItem(review.id);if(!review?.loaded||!item?.runId||fingerprint(item)!==review.fingerprint)return;window.PagePosterManualExport?.open({runId:item.runId,pageId:item.pageId,pageRevision:item.pageRevision,isCurrent:()=>state.review===review&&$('pq-review').open&&fingerprint(findItem(item.id)||{})===review.fingerprint});});manual.id='pq-review-manual';manual.disabled=true;tools.appendChild(manual);
 const expand=button('На весь екран',()=>{const full=$('pq-review').classList.toggle('is-full');expand.textContent=full?'Звичайний розмір':'На весь екран';fitReview();});tools.appendChild(expand);
 const next=button('Переглянув → далі',()=>{const review=state.review,item=review&&findItem(review.id);if(!review?.loaded||!review.token||!reviewable(item)||fingerprint(item)!==review.fingerprint)return;const entries=visibleEntries().map(entry=>entry.item),index=entries.findIndex(entry=>entry.id===item.id),following=entries.slice(index+1).find(entry=>entry.runId);markReviewed();if(following)reviewItem(following.id);});next.id='pq-mark-next';next.disabled=true;$('pq-mark-reviewed').after(next);
 const details=node('div');details.id='pq-inspector-details';$('pq-review').appendChild(details);
 const proxyUsage=node('dialog','ap-dialog ap-small');proxyUsage.id='pq-proxy-usage';proxyUsage.setAttribute('aria-labelledby','pq-proxy-usage-title');
 proxyUsage.innerHTML='<div class="ap-dialog-heading"><h2 id="pq-proxy-usage-title">Трафік проксі</h2><button id="pq-proxy-usage-close" class="ap-icon" type="button" aria-label="Закрити">×</button></div><p id="pq-proxy-usage-name" class="ap-muted"></p><div id="pq-proxy-usage-result" role="status"></div><p class="ap-fine">Лічимо тіла HTTP-запитів і відповідей. Тариф і обсяг за рахунком провайдера невідомі. Останній вимір IP може відрізнятися від IP поточної сесії.</p>';
 document.body.appendChild(proxyUsage);
 $('pq-proxy-usage-close').addEventListener('click',()=>close(proxyUsage.id));
 proxyUsage.addEventListener('close',()=>{proxyUsageSerial++;const target=proxyUsage._pqFocus;if(target?.isConnected)target.focus({preventScroll:true});});
 const requirements=node('dialog','ap-dialog ap-small');requirements.id='pq-requirements';requirements.setAttribute('aria-labelledby','pq-requirements-title');requirements.innerHTML='<div class="ap-dialog-heading"><h2 id="pq-requirements-title">GEO, DR і трафік</h2><button id="pq-requirements-close" class="ap-icon" type="button" aria-label="Скасувати зміну вимог">×</button></div><p id="pq-requirements-count" class="ap-muted"></p><form id="pq-requirements-form"><div class="ap-selection-grid"><div class="pq-requirement-field"><label class="ap-check-label"><input id="pq-requirements-dr-change" type="checkbox"> Змінити DR</label><label class="ap-field">Мінімальний DR<input id="pq-requirements-dr" type="number" min="0" max="100" step="any" placeholder="Порожньо — без обмеження" disabled></label></div><div class="pq-requirement-field"><label class="ap-check-label"><input id="pq-requirements-traffic-change" type="checkbox"> Змінити трафік</label><label class="ap-field">Мінімальний трафік<input id="pq-requirements-traffic" type="number" min="0" max="9007199254740991" step="1" placeholder="Порожньо — без обмеження" disabled></label></div></div><div class="pq-requirement-field"><label class="ap-check-label"><input id="pq-requirements-geo-change" type="checkbox"> Змінити GEO</label><label class="ap-field">Країни через кому<input id="pq-requirements-geo" maxlength="200" placeholder="PL, DE; порожньо — без обмеження" disabled></label></div><p class="ap-fine">Позначений показник і порожнє поле знімуть обмеження. Непозначений показник залишиться без змін.</p><div id="pq-requirements-note" class="ap-notice" role="status" hidden></div><button id="pq-requirements-apply" class="ap-button ap-primary" type="submit">Застосувати й підібрати заново</button></form>';document.body.appendChild(requirements);
 const localeField=node('div','pq-requirement-field');
 localeField.innerHTML='<label class="ap-check-label"><input id="pq-requirements-language-change" type="checkbox"> Змінити мову</label><label class="ap-field">Код мови<input id="pq-requirements-language" maxlength="35" placeholder="pl, en-NZ" required disabled></label><p id="pq-requirements-language-help" class="ap-fine"></p>';
 $('pq-requirements-form').prepend(localeField);$('pq-requirements-title').textContent='Мова, GEO, DR і трафік';
 $('pq-requirements-close').addEventListener('click',()=>close('pq-requirements'));requirements.addEventListener('close',()=>{state.requirements=null;const target=requirements._pqFocus;if(target?.isConnected)target.focus({preventScroll:true});});$('pq-requirements-form').addEventListener('submit',applyRequirements);for(const name of ['dr','traffic','geo','language'])$('pq-requirements-'+name+'-change').addEventListener('change',()=>{$('pq-requirements-'+name).disabled=!$('pq-requirements-'+name+'-change').checked;});
 $('pq-edit-requirements').textContent='Мова / GEO / DR / трафік';$('pq-edit-requirements').addEventListener('click',()=>openRequirements([...state.selected].map(findItem).filter(Boolean)));
 $('pq-search').addEventListener('input',filtersChanged);for(const id of ['pq-project-filter','pq-filter-state','pq-filter-language','pq-filter-geo'])$(id).addEventListener('change',filtersChanged);
 $('pq-reset-filters').addEventListener('click',()=>{for(const id of ['pq-search','pq-filter-state','pq-filter-language','pq-filter-geo'])$(id).value='';filtersChanged();});
 $('pq-clear-selection').addEventListener('click',()=>{state.selected.clear();renderQueues();});$('pq-export').addEventListener('click',exportList);
 try{$('pq-density').value=localStorage.getItem('pageposter:row-density')==='compact'?'compact':'comfortable';}catch{}$('pq-dashboard').dataset.density=$('pq-density').value;$('pq-density').addEventListener('change',()=>{$('pq-dashboard').dataset.density=$('pq-density').value;try{localStorage.setItem('pageposter:row-density',$('pq-density').value);}catch{}});
 const preparedExport=button('ZIP готових HTML',event=>exportPrepared(event.currentTarget));preparedExport.id='pq-export-prepared';$('pq-export').after(preparedExport);
 for(const control of [$('pq-refresh'),$('pq-export'),preparedExport])control.addEventListener('click',()=>{const menu=control.closest('details');if(menu)menu.open=false;});
 $('pq-dashboard-close').disabled=!state.overview;$('pq-dashboard-open').addEventListener('click',()=>{state.projectFilter='';},true);$('pq-dashboard-close').addEventListener('click',event=>{event.stopImmediatePropagation();composePage();},true);
 window.addEventListener('pageposter:project-selected',event=>{if(window.pageposterDesktop||document.body.dataset.workspaceView==='queue'){state.projectFilter=event.detail?.projectId||'';state.selected.clear();if(!event.detail?.composer)openDashboard();}});
 window.addEventListener('pageposter:queue-review-open',event=>{const item=visibleEntries().find(entry=>entry.item.runId===event.detail?.runId)?.item;if(item)reviewItem(item.id);});
 window.addEventListener('pageposter:queue-updated',()=>{if($('pq-dashboard').open)refreshQueues().catch(()=>{});});
 window.addEventListener('pageposter:projects-changed',()=>{state.projectFilter='';if($('pq-dashboard').open)refreshQueues().catch(()=>{});});
 window.addEventListener('resize',fitReview);window.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('pq-review').open&&!document.querySelector('dialog:modal')){event.preventDefault();closeReview();}});
 if(window.pageposterDesktop)openDashboard();
}
function initialize(){installWorkspace();init();initRegionControls();
 $('pq-published-review-close')?.addEventListener('click',()=>close('pq-published-review'));
 $('pq-published-review-editor')?.addEventListener('click',event=>{const dialog=$('pq-published-review');if(dialog.open)void openWordPressEditor(dialog.item,event.currentTarget,dialog);});
 $('pq-published-review-approve')?.addEventListener('click',()=>savePublishedReview('approved'));
 $('pq-published-review-decline')?.addEventListener('click',()=>savePublishedReview('declined'));
 for(const event of ['pageposter:google-account-changed','pageposter:settings-opened'])window.addEventListener(event,()=>{if(!state.pending&&(googleNeeds().sheets||googleNeeds().drive))invalidate();void loadImportCapabilities();});$('ap-settings')?.addEventListener('close',()=>{if($('pq-import-dialog').open)void loadImportCapabilities();});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize);else initialize();
})();
