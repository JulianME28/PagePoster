// Imports are snapshots. Only Google API endpoints are contacted; source URLs,
// credentials and access tokens are never copied into queue items.
import {createHash,createPrivateKey,sign} from 'node:crypto';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
import {normalizeEditorial,EDITORIAL_LANGUAGES} from './editorial-brief.mjs';
import {normalizeSiteCriteria} from './site-source.mjs';
import {detectImportFileRegions,normalizeHtmlLanguage} from './import-regions.mjs';
import {createGoogleRead} from './google-read.mjs';
import projectTable from '../../dist/project-table.js';

const MAX_ITEMS=1000,MAX_HTML=500000,MAX_TOTAL=20*1024*1024,MAX_JSON=5*1024*1024;
const TOKEN_URL='https://oauth2.googleapis.com/token';
const SCOPES='https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly';
const FOLDER='application/vnd.google-apps.folder';
const DEFAULT_KEYS=['language','geo','minDr','minTraffic','format','topic','customTopic','chromeMode','detectFileRegions'];
const ITEM_KEYS=['key','id','title','source','language','geo','siteSelection','links','editorial','format','topic','customTopic','minDr','minTraffic','html','baseUrl','brand','brandUrl','chromeMode','url','anchor','file','slug','donor','placementUrl','provenance'];
const PARSER_VERSION='pageposter-import/1';
const PROVENANCE_FIELDS=['key','title','language','geo','minDr','minTraffic','chromeMode','links','format','topic','customTopic','html','baseUrl','brand','brandUrl','slug','donor'];
const PROVENANCE_WARNINGS=['LANGUAGE_DEFAULTED','GEO_UNSPECIFIED','FILE_REGION_NOT_DETECTED'];
const messages={
 IMPORT_VALIDATION:'Проверьте строки импорта и выбранный тип проекта.',
 GOOGLE_ACCOUNT_REQUIRED:'Подключите рабочий или сервисный аккаунт Google в настройках с доступом на чтение к таблице или папке.',
 GOOGLE_AUTH_REQUIRED:'Войдите в рабочий аккаунт Google в подключениях и предоставьте доступ на чтение.',
 GOOGLE_BROWSER_IMPORT_UNSUPPORTED:'Вход через Chrome используется для базы сайтов. Для импорта выберите локальные HTML или CSV; доступ к Google Drive требует OAuth или сервисного аккаунта в подключениях.',
 GOOGLE_CLIENT_REQUIRED:'Сначала настройте вход Google в подключениях PagePoster.',
 GOOGLE_AUTH_FAILED:'Google не подтвердил сервисный аккаунт. Проверьте подключение в настройках.',
 GOOGLE_ACCESS_DENIED:'Google не предоставил доступ. Проверьте доступ выбранного аккаунта к таблице или папке.',
 GOOGLE_READ_FAILED:'Не удалось прочитать источник Google. Проверьте доступ и повторите импорт.',
 GOOGLE_RATE_LIMITED:'Google временно ограничил чтение. Повторите импорт позже; строки не были импортированы частично.',
 GOOGLE_READ_ABORTED:'Чтение Google отменено. Импорт не был выполнен.',
 GOOGLE_RESPONSE_INVALID:'Google вернул неподдерживаемые данные. Проверьте источник и диапазон.',
 IMPORT_LIMIT:'Импорт ограничен 1000 страницами, 500 000 байтами на HTML и 20 МБ на весь пакет.'
};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const empty=value=>value===undefined||value===null||value==='';
const inherited=(...values)=>values.find(value=>value!==undefined&&value!==null&&!(typeof value==='string'&&!value.trim()));
function fail(message=messages.IMPORT_VALIDATION,code='IMPORT_VALIDATION'){throw Object.assign(Error(message),{code});}
function fields(value,keys){if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))fail();return value;}
function string(value,max,{optional=false,multiline=false}={}){
 if(value===undefined&&optional)return '';
 if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||new RegExp(multiline?'[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]':'[\\u0000-\\u001f\\u007f]').test(value))fail();
 return value;
}
function keyOf(value,index){
 if(value.key!==undefined&&value.id!==undefined&&value.key!==value.id)fail('ID и key строки должны совпадать.');
 return string(value.key??value.id??'row-'+(index+1),200).trim();
}
function number(value){
 if(empty(value))return null;
 if(typeof value==='string'){value=value.trim();if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))fail('DR и трафик должны быть неотрицательными числами.');value=Number(value);}
 if(typeof value!=='number'||!Number.isFinite(value))fail('DR и трафик должны быть числами.');
 return value;
}
function optionalUrl(value){
 if(empty(value))return '';
 string(value,4000);if(value!==value.trim()||/[\s\\]/.test(value))fail('Проверьте адрес URL.');
 let url;try{url=new URL(value);}catch{fail('Проверьте адрес URL.');}
 if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password)fail('Адрес должен использовать HTTP или HTTPS без данных входа.');
 return value;
}
function links(value){
 if(!Array.isArray(value)||!value.length||value.length>20)fail('Укажите от 1 до 20 пар URL и анкора.');
 return value.map(link=>{
  fields(link,['url','anchor']);const url=optionalUrl(link.url);
  if(!url)fail('Для каждого анкора нужен URL.');
  const anchor=string(link.anchor,300);return {url,anchor};
 });
}
function rowLinks(row){
 const numbered=Object.keys(row).filter(key=>/^(?:url|anchor)(?:[2-9]|1\d|20)?$/.test(key));
 if(row.links!==undefined){
  if(numbered.some(key=>!empty(row[key])))fail('Используйте либо links JSON, либо колонки URL и анкора.');
  let value=row.links;if(typeof value==='string')try{value=JSON.parse(value);}catch{fail('Колонка links должна содержать JSON массив пар URL и анкора.');}
  return links(value);
 }
 const result=[];
 for(let index=1;index<=20;index++){
  const suffix=index===1?'':String(index),url=row['url'+suffix],anchor=row['anchor'+suffix];
  if(empty(url)&&empty(anchor))continue;
  result.push({url,anchor});
 }
 return links(result);
}
function validateDefaults(value={}){
 fields(value,DEFAULT_KEYS);
 if(value.detectFileRegions!==undefined&&typeof value.detectFileRegions!=='boolean')fail('Автоопределение регионов файлов должно быть включено или выключено.');
 return value;
}
function normalizeData(type,row,index,defaults){
 fields(row,[...ITEM_KEYS,...Array.from({length:19},(_,i)=>['url'+(i+2),'anchor'+(i+2)]).flat()]);
 if(row.source!==undefined&&row.source!==type)fail('Тип строки не совпадает с типом проекта.');
 const key=keyOf(row,index),title=string(row.title??'',500,{optional:true,multiline:true}).trim().replace(/\s+/g,' ');
 const rawLanguage=row.language||row.editorial?.language||defaults.language||'en';
 const language=type==='html'?normalizeHtmlLanguage(rawLanguage):String(rawLanguage).trim().toLowerCase();
 if(type==='html'?!language:!Object.hasOwn(EDITORIAL_LANGUAGES,language))fail(type==='html'?'Для HTML укажите код языка, например hu, pl или en-NZ.':'Язык должен быть en, es, pl, de или fr.');
 if(row.editorial?.language!==undefined&&row.editorial.language!==language)fail('Язык строки и редакционного задания должен совпадать.');
 if(row.siteSelection!==undefined)fields(row.siteSelection,['minDr','minTraffic','geo']);
 const rawGeo=inherited(row.geo,row.siteSelection?.geo,defaults.geo)??'';
 if(typeof rawGeo!=='string')fail('География должна содержать коды стран из двух букв через запятую.');
 let siteSelection;
 try{siteSelection=normalizeSiteCriteria({minDr:number(inherited(row.minDr,row.siteSelection?.minDr,defaults.minDr)),minTraffic:number(inherited(row.minTraffic,row.siteSelection?.minTraffic,defaults.minTraffic)),geo:rawGeo});}
 catch{fail('Проверьте DR (0–100), целый трафик и коды стран из двух букв через запятую.');}
 if(inherited(row.geo)!==undefined&&inherited(row.siteSelection?.geo)!==undefined){
  let nested;try{nested=normalizeSiteCriteria(row.siteSelection);}catch{fail();}
  if(nested.geo!==siteSelection.geo)fail('География строки и критериев должна совпадать.');
 }
 const chromeMode=row.chromeMode||defaults.chromeMode||'custom';
 if(!['custom','overlay-only'].includes(chromeMode))fail('Выберите допустимый режим оформления HTML.');
 let slug=row.slug===undefined?'':string(row.slug,200);
 let donor;
 if(row.donor!==undefined){
  const raw=string(row.donor,2000).trim();
  try{const url=validatePublicUrl(raw.includes('://')?raw:'https://'+raw);if(url.search||url.hash)throw Error();donor=url.href.replace(/\/+$/,'')+'/';}
  catch{fail('Проверьте адрес сайта публикации в колонке donor.');}
 }
 if(row.placementUrl!==undefined){
  let destination,path;try{destination=validatePublicUrl(string(row.placementUrl,2000));path=destination.pathname.replace(/\/+$/,'');if(!path||destination.search||destination.hash)throw Error();}
  catch{fail('Укажите полный HTTPS-адрес новой страницы без параметров.');}
  const lastSlash=path.lastIndexOf('/'),requestedSlug=path.slice(lastSlash+1),requestedDonor=destination.origin+path.slice(0,lastSlash+1);
  if((slug&&slug!==requestedSlug)||(donor&&donor!==requestedDonor))fail('Полный адрес публикации не совпадает с указанным донором или slug.');
  slug=requestedSlug;donor=requestedDonor;
 }
 if(slug&&(slug.length>200||!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)))fail('Укажите точный slug страницы без домена и косых черт, например poker-guide.');
 const common={key,title,source:type,language,geo:siteSelection.geo,siteSelection,chromeMode,...(slug?{slug}:{}),...(donor?{donor}:{})};
 if(type==='ai'){
  if(['html','baseUrl','brand','brandUrl','file'].some(name=>row[name]!==undefined))fail('В AI проект нельзя импортировать HTML.');
  let editorial;
  try{editorial=normalizeEditorial({format:row.format||row.editorial?.format||defaults.format||'article',topic:row.topic||row.editorial?.topic||defaults.topic||'casino',customTopic:row.customTopic??row.editorial?.customTopic??defaults.customTopic??'',language});}
  catch{fail('Проверьте формат и тему; для собственной темы укажите текст до 500 символов.');}
  if(row.editorial!==undefined)fields(row.editorial,['format','topic','customTopic','language']);
  return {...common,links:rowLinks(row),editorial};
 }
 if(['links','url','anchor','editorial','format','topic','customTopic',...Array.from({length:19},(_,i)=>['url'+(i+2),'anchor'+(i+2)]).flat()].some(name=>row[name]!==undefined))fail('В HTML проект нельзя импортировать AI задания и пары ссылок.');
 string(row.html,MAX_HTML,{multiline:true});
 if(Buffer.byteLength(row.html,'utf8')>MAX_HTML)fail(messages.IMPORT_LIMIT);
 if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.html))fail('HTML должен быть в кодировке UTF-8.');
 return {...common,html:row.html,baseUrl:optionalUrl(row.baseUrl),brand:string(row.brand??'',200,{optional:true}),brandUrl:optionalUrl(row.brandUrl)};
}
// Provenance describes a snapshot. It never supplies a review token, a source
// credential, a network target, or any permission to publish that snapshot.
function sourceFilename(value,tableOnly=false){
 const name=string(value,255);
 // A country slug such as sk-online-casino-bonuses is not a credential.
 // Generic keys need a long contiguous payload; project/service keys have
 // their explicit prefix. Preserve ordinary hyphen-separated country words.
 if(!/\.(?:csv|tsv|txt|md|xlsx|docx|html?)$/i.test(name)||/[\\/:]/.test(name)||tableOnly&&/\.html?$/i.test(name)||/^\s*(?:bearer\b|sk-(?:[a-z\d_]{32,}|(?:proj-|svcacct-)[a-z\d_-]{32,}))|private[ _-]?key/i.test(name))fail();
 return name;
}
function provenanceSource(value){
 fields(value,['kind','file','row','spreadsheetId','driveId','gid','range']);
 if(!['items','table','files','google-sheets','google-drive'].includes(value.kind))fail();
 const source={kind:value.kind};
 if(value.file!==undefined)source.file=sourceFilename(value.file);
 if(value.row!==undefined){if(!Number.isSafeInteger(value.row)||value.row<1||value.row>10000000)fail();source.row=value.row;}
 for(const key of ['spreadsheetId','driveId'])if(value[key]!==undefined){if(typeof value[key]!=='string'||! /^[a-zA-Z0-9_-]{1,200}$/.test(value[key])||/^(?:sk-|bearer[-_])|(?:private[-_]?key|access[-_]?token|refresh[-_]?token)/i.test(value[key]))fail();source[key]=value[key];}
 if(value.gid!==undefined){if(!Number.isSafeInteger(value.gid)||value.gid<0||value.gid>9999999999)fail();source.gid=value.gid;}
 // Sheet names may contain arbitrary private text. Coordinates plus the safe
 // spreadsheet ID/gid locate a row without copying those names or source URLs.
 if(value.range!==undefined){const range=boundedRange(value.range);if(range.sheet!==null)fail();source.range=range.cells;}
 return source;
}
function validatedProvenance(value){
 if(value===undefined)return null;
 fields(value,['version','parserVersion','source','fields','warnings','fieldHashes']);
 if(value.version!==1||value.parserVersion!==PARSER_VERSION)fail();
 const source=provenanceSource(value.source),origins=fields(value.fields,['explicit','detected','defaulted']),seen=new Set();
 for(const origin of ['explicit','detected','defaulted']){
  if(!Array.isArray(origins[origin])||origins[origin].length>PROVENANCE_FIELDS.length)fail();
  for(const field of origins[origin]){if(!PROVENANCE_FIELDS.includes(field)||seen.has(field))fail();seen.add(field);}
 }
 if(!Array.isArray(value.warnings)||value.warnings.length>PROVENANCE_WARNINGS.length||new Set(value.warnings).size!==value.warnings.length||value.warnings.some(w=>!PROVENANCE_WARNINGS.includes(w)))fail();
 const fieldHashes=value.fieldHashes===undefined?{}:fields(value.fieldHashes,PROVENANCE_FIELDS);
 if(Object.values(fieldHashes).some(hash=>typeof hash!=='string'||! /^[a-f0-9]{64}$/.test(hash)))fail();
 return {source,fields:origins,warnings:value.warnings,fieldHashes};
}
export function publicImportProvenance(value){
 try{const safe=validatedProvenance(value);return safe?{version:1,parserVersion:PARSER_VERSION,source:{...safe.source},fields:Object.fromEntries(Object.entries(safe.fields).map(([origin,names])=>[origin,[...names]])),warnings:[...safe.warnings],fieldHashes:{...safe.fieldHashes}}:null;}catch{return null;}
}
function fieldValues(item){
 return {key:item.key,title:item.title,language:item.language,geo:item.geo,minDr:item.siteSelection.minDr,minTraffic:item.siteSelection.minTraffic,chromeMode:item.chromeMode,...(item.slug?{slug:item.slug}:{}),...(item.donor?{donor:item.donor}:{}),...(item.source==='ai'?{links:item.links,format:item.editorial.format,topic:item.editorial.topic,customTopic:item.editorial.customTopic}:{html:item.html,baseUrl:item.baseUrl,brand:item.brand,brandUrl:item.brandUrl})};
}
function explicitField(row,field){
 const present=value=>inherited(value)!==undefined;
 if(field==='key')return present(row.key)||present(row.id);
 if(field==='slug'||field==='donor')return present(row[field])||present(row.placementUrl);
 if(['geo','minDr','minTraffic'].includes(field))return present(row[field])||present(row.siteSelection?.[field]);
 if(['language','format','topic','customTopic'].includes(field))return present(row[field])||present(row.editorial?.[field]);
 if(field==='links')return row.links!==undefined||Object.keys(row).some(key=>/^url(?:[2-9]|1\d|20)?$/.test(key)&&present(row[key]));
 return present(row[field]);
}
function normalizeRow(type,row,index,defaults,context={}){
 const item=normalizeData(type,row,index,defaults),prior=validatedProvenance(row.provenance),origins={explicit:[],detected:[],defaulted:[]},fieldHashes={};
 for(const [field,value] of Object.entries(fieldValues(item))){
  const hash=createHash('sha256').update(JSON.stringify(value)).digest('hex');fieldHashes[field]=hash;
  const unchanged=prior?.fieldHashes[field]===hash,previous=unchanged&&['explicit','detected','defaulted'].find(origin=>prior.fields[origin].includes(field));
  const origin=previous||(prior?.fieldHashes[field]&&!unchanged?'explicit':context.detected?.includes(field)?'detected':explicitField(row,field)?'explicit':'defaulted');
  origins[origin].push(field);
 }
 const source=prior?.source||provenanceSource(context.source||{kind:'items',row:index+1}),warnings=[];
 if(origins.defaulted.includes('language'))warnings.push('LANGUAGE_DEFAULTED');
 if(!item.geo)warnings.push('GEO_UNSPECIFIED');
 if(context.regionDetectionMissing||prior?.warnings.includes('FILE_REGION_NOT_DETECTED')&&!origins.explicit.includes('language')&&!origins.explicit.includes('geo'))warnings.push('FILE_REGION_NOT_DETECTED');
 return {...item,provenance:{version:1,parserVersion:PARSER_VERSION,source,fields:origins,warnings,fieldHashes}};
}
/** Pure validation, used again when accepting a preview for durable import. */
export function normalizeImportItems(type,items,{defaults={}}={}){
 if(!['ai','html'].includes(type))fail('Выберите тип проекта: AI или HTML.');
 validateDefaults(defaults);
 if(!Array.isArray(items)||!items.length)fail('В источнике нет строк для импорта.');
 if(items.length>MAX_ITEMS)fail(messages.IMPORT_LIMIT);
 const keys=new Set();let bytes=0;
 return items.map((row,index)=>{
  let item;try{item=normalizeRow(type,row,index,defaults);}catch(error){if(error?.code==='IMPORT_VALIDATION')throw error;fail();}
  if(keys.has(item.key))fail('ID строк должны быть уникальны.');keys.add(item.key);
  bytes+=Buffer.byteLength(JSON.stringify(item),'utf8');if(bytes>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
  return item;
 });
}

// Delimiters and quoted fields follow the CSV double-quote rules; pasted tables
// use tabs. Trailing empty cells are valid, extra nonempty cells are errors.
function delimited(text){
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
 try{return projectTable.read(text,{maxRows:MAX_ITEMS+2,onLimit:()=>fail(messages.IMPORT_LIMIT)});}
 catch(error){if(error.code==='IMPORT_VALIDATION')throw error;fail(error.message);}
}
const HEADERS=Object.fromEntries(['id','key','title','url','anchor','language','geo','minDr','minTraffic','format','topic','customTopic','file','links','html','baseUrl','brand','brandUrl','chromeMode','slug','donor','placementUrl'].map(key=>[key.toLowerCase(),key]));
function tableRows(matrix,mapping){
 if(!Array.isArray(matrix)||!matrix.length||matrix.length>MAX_ITEMS+2)fail(messages.IMPORT_LIMIT);
 if(!Array.isArray(matrix[0]))fail();
 if(mapping!==undefined&&(!Array.isArray(mapping)||mapping.length!==matrix[0].length||mapping.length>128))fail('Неверная схема колонок.');
 const headers=(mapping??matrix[0]).map(value=>{
  if(typeof value!=='string')fail('Первая строка должна содержать названия колонок.');
  if(mapping&&value==='')return null;
  const name=value.replace(/^\uFEFF/,'').trim().toLowerCase();
  if(Object.hasOwn(HEADERS,name))return HEADERS[name];
  if(/^(url|anchor)([2-9]|1\d|20)$/.test(name))return name;
  fail('Неизвестная колонка. Используйте ID, title, url, anchor, language, geo, minDr, minTraffic, format, topic, customTopic или file.');
 });
 const used=headers.filter(Boolean);
 if(!used.length||new Set(used).size!==used.length||used.includes('id')&&used.includes('key'))fail('Названия колонок не должны повторяться.');
 const rows=[];
 for(let index=1;index<matrix.length;index++){
  const cells=matrix[index];if(!Array.isArray(cells)||cells.length>headers.length||cells.some(value=>!['string','number'].includes(typeof value)&&value!==null))fail('Количество ячеек не совпадает с заголовками таблицы.');
  if(cells.every(value=>value===null||String(value).trim()===''))continue;
  if(mapping&&cells.some((value,column)=>value!=null&&String(value).trim()&&!String(matrix[0][column]??'').trim()))fail('В таблице есть данные без заголовка колонки.');
  const data={};headers.forEach((key,column)=>{const raw=cells[column];if(key&&raw!==undefined&&raw!==null&&raw!=='')data[key]=raw;});
  if(!Object.keys(data).length)continue;
  rows.push({row:index+1,data});
 }
 if(rows.length>MAX_ITEMS)fail(messages.IMPORT_LIMIT);
 return rows;
}
function googleReference(value,kind){
 if(typeof value!=='string'||value.length>2000||/[\u0000-\u0020\u007f\\]/.test(value))fail('Проверьте адрес источника Google.');
 if(/^[a-zA-Z0-9_-]{1,200}$/.test(value))return {id:value,gid:null,range:null};
 let url;try{url=new URL(value);}catch{fail('Проверьте адрес источника Google.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port)fail('Укажите HTTPS адрес Google.');
 let match;
 if(kind==='sheets'&&url.hostname==='docs.google.com')match=/^\/spreadsheets\/d\/([\w-]{1,200})(?:\/|$)/.exec(url.pathname);
 if(kind==='drive'&&['drive.google.com','docs.google.com'].includes(url.hostname))match=/^\/(?:file\/d|drive\/(?:u\/\d+\/)?folders)\/([\w-]{1,200})(?:\/|$)/.exec(url.pathname)||(/^\/(?:open|uc)$/.test(url.pathname)&&[null,url.searchParams.get('id')]);
 if(!match||!/^[\w-]{1,200}$/.test(match[1]))fail('Укажите адрес Google Sheets или Google Drive нужного типа.');
 const hash=new URLSearchParams(url.hash.slice(1)),gid=url.searchParams.get('gid')??hash.get('gid');
 if(gid!==null&&!/^\d{1,10}$/.test(gid))fail('Проверьте gid вкладки Google Sheets.');
 return {id:match[1],gid:gid===null?null:Number(gid),range:url.searchParams.get('range')};
}
function boundedRange(value){
 const text=value||'A1:AZ1002';
 if(typeof text!=='string'||text.length>300)fail('Укажите конечный диапазон, например A1:AZ1002.');
 const match=/^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?([A-Z]{1,2})([1-9]\d{0,6}):([A-Z]{1,2})([1-9]\d{0,6})$/i.exec(text);
 const column=name=>[...name.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
 if(!match||column(match[3])>column(match[5])||column(match[5])>52||Number(match[6])<Number(match[4])||Number(match[6])-Number(match[4])>1001)fail('Укажите конечный диапазон до 1002 строк и колонки AZ, например A1:AZ1002.');
 const name=match[1]!==undefined?match[1].replace(/''/g,"'"):match[2]??null;
 if(name!==null&&/[\u0000-\u001f\u007f]/.test(name))fail();
 return {sheet:name,cells:match[3].toUpperCase()+match[4]+':'+match[5].toUpperCase()+match[6],firstRow:Number(match[4]),rowCount:Number(match[6])-Number(match[4])+1};
}
function localFiles(files){
 if(!Array.isArray(files)||!files.length||files.length>MAX_ITEMS)fail(messages.IMPORT_LIMIT);
 const names=new Set();let total=0;
 return files.map(file=>{
  fields(file,['name','html','path']);const name=string(file.name,255);
  if(!/\.html?$/i.test(name)||/[\\/]/.test(name))fail('Выберите локальные файлы .html или .htm.');
  if(names.has(name))fail('Имена HTML файлов должны быть уникальны.');names.add(name);
  if(typeof file.html!=='string'||!file.html.trim())fail('HTML файл пуст или имеет неподдерживаемую кодировку.');
  const size=Buffer.byteLength(file.html,'utf8');total+=size;if(size>MAX_HTML||total>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
  const path=file.path===undefined?'':string(file.path,1024);
  if(path&&(/[\\:]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')||path.split('/').at(-1)!==name))fail('Некорректный путь HTML в архиве.');
  return {name,html:file.html,...(path?{path}:{})};
 });
}
function fileRows(rows,files,detectFileRegions=false){
 // A file's identity must survive reordered uploads and separate batches. Keep
 // content out of the key so changed content still conflicts with its snapshot.
 const fileKey=file=>file.id||'local-file-'+createHash('sha256').update(file.name.normalize('NFC').toLowerCase()).digest('hex');
 const metadata=(file,data,detected)=>{
  const inferred=detectFileRegions?detectImportFileRegions(file.name,file.html):{};
  const language=inherited(data.language)===undefined&&inferred.language,geo=inherited(data.geo,data.siteSelection?.geo)===undefined&&inferred.geo;
  return {data:{...data,...(language?{language}:{}),...(geo?{geo}:{})},detected:[...detected,...(language?['language']:[]),...(geo?['geo']:[])],regionDetectionMissing:detectFileRegions&&!inferred.language&&!inferred.geo,provenanceSource:{file:sourceFilename(file.name),...(file.id?{driveId:file.id}:{})}};
 };
 if(!rows)return files.map((file,index)=>({row:index+1,...metadata(file,{key:fileKey(file),title:file.name.replace(/\.html?$/i,''),html:file.html},['key','title'])}));
 const used=new Set(),identifiers=new Map();
 files.forEach(file=>{for(const value of new Set([file.name,file.id,file.path].filter(Boolean)))identifiers.set(value,identifiers.has(value)?null:file);});
 const result=rows.map(entry=>{
  try{
  const name=entry.data.file;
  if(typeof name!=='string'||!name.trim())fail('В каждой строке HTML таблицы нужна колонка file с именем файла или Drive ID.');
  const file=identifiers.get(name.trim());if(!file)fail('HTML файл строки не найден или имя неоднозначно.');
  if(used.has(file))fail('HTML файл сопоставлен нескольким строкам.');used.add(file);
  if(entry.data.html!==undefined)fail('Используйте либо HTML в таблице, либо файлы.');
  const {file:ignored,...data}=entry.data;
  return {...entry,...metadata(file,{...(data.key===undefined&&data.id===undefined?{key:fileKey(file)}:{}),...data,title:data.title||file.name.replace(/\.html?$/i,''),html:file.html},[...(data.key===undefined&&data.id===undefined?['key']:[]),...(!data.title?['title']:[])])};
  }catch(error){error.row=entry.row;try{error.key=keyOf(entry.data,entry.row-2);}catch{}throw error;}
 });
 if(used.size!==files.length)fail('Для каждого HTML файла должна быть строка в таблице.');
 return result;
}
function issue(error,row=error?.row??null,key=error?.key??''){
 const known=error?.code==='IMPORT_VALIDATION'||Object.hasOwn(messages,error?.code||'');
 return {row,key,code:known?error.code:'IMPORT_VALIDATION',message:known?error.message:messages.IMPORT_VALIDATION};
}

export function createProjectImporter({getAccount=()=>null,getAccessToken,transport=createSafeTransport({allowWrites:true,maxBytes:MAX_JSON}),clock=Date.now,readRetry={}}={}){
 const read=createGoogleRead({clock,...readRetry,transport});
 async function request(url,options={}){
  let response;try{response=await ((options.method??'GET')==='GET'?read:transport)(url,{method:'GET',...options,followRedirects:false});}catch(error){if(options.signal?.aborted||error?.code==='google_read_aborted')fail(messages.GOOGLE_READ_ABORTED,'GOOGLE_READ_ABORTED');if(error?.code==='google_read_rate_limited')fail(messages.GOOGLE_RATE_LIMITED,'GOOGLE_RATE_LIMITED');if(error?.code==='response_too_large')fail(messages.IMPORT_LIMIT);fail(messages.GOOGLE_READ_FAILED,'GOOGLE_READ_FAILED');}
  if(response?.status===401||response?.status===403||response?.status===404)fail(messages.GOOGLE_ACCESS_DENIED,'GOOGLE_ACCESS_DENIED');
  if(!response||response.status<200||response.status>=300||response.url&&response.url!==url||typeof response.text!=='string'||Buffer.byteLength(response.text)>MAX_JSON)fail(messages.GOOGLE_READ_FAILED,'GOOGLE_READ_FAILED');
  return response;
 }
 async function json(url,options){
  const response=await request(url,options);
  try{return JSON.parse(response.text);}catch{fail(messages.GOOGLE_RESPONSE_INVALID,'GOOGLE_RESPONSE_INVALID');}
 }
 async function accessToken(signal){
  if(signal?.aborted)fail(messages.GOOGLE_READ_ABORTED,'GOOGLE_READ_ABORTED');
  if(getAccessToken){let token;try{token=await getAccessToken();}catch(error){const code=['GOOGLE_AUTH_REQUIRED','GOOGLE_CLIENT_REQUIRED','GOOGLE_BROWSER_IMPORT_UNSUPPORTED'].includes(error?.code)?error.code:'GOOGLE_AUTH_FAILED';fail(messages[code],code);}if(token!==undefined&&token!==null){if(typeof token!=='string'||!token||token.length>8192||/[\u0000-\u0020\u007f]/.test(token))fail(messages.GOOGLE_AUTH_FAILED,'GOOGLE_AUTH_FAILED');return token;}}
  const account=await getAccount();if(!account)fail(messages.GOOGLE_ACCOUNT_REQUIRED,'GOOGLE_ACCOUNT_REQUIRED');
  let assertion;
  try{
   if(typeof account.clientEmail!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.clientEmail))throw Error();
   const now=Math.floor(clock()/1000),b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
   const unsigned=b64({alg:'RS256',typ:'JWT'})+'.'+b64({iss:account.clientEmail,scope:SCOPES,aud:TOKEN_URL,iat:now,exp:now+3600});
   const key=createPrivateKey(account.privateKey);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength||0)<2048)throw Error();
   assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),key).toString('base64url');
  }catch{fail(messages.GOOGLE_AUTH_FAILED,'GOOGLE_AUTH_FAILED');}
  let token;
  try{token=await json(TOKEN_URL,{method:'POST',signal,headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()});}
  catch(error){if(error?.code==='GOOGLE_READ_ABORTED')throw error;fail(messages.GOOGLE_AUTH_FAILED,'GOOGLE_AUTH_FAILED');}
  if(!plain(token)||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||/[\u0000-\u0020\u007f]/.test(token.access_token)||String(token.token_type).toLowerCase()!=='bearer')fail(messages.GOOGLE_AUTH_FAILED,'GOOGLE_AUTH_FAILED');
  return token.access_token;
 }
 async function sheets(reference,range,token,signal){
  const root='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(reference.id),headers={authorization:'Bearer '+token,accept:'application/json'};
  const bounded=boundedRange(range??reference.range);let name=bounded.sheet;
  if(reference.gid!==null){
   const data=await json(root+'?fields='+encodeURIComponent('sheets(properties(sheetId,title))'),{headers,signal});
   if(!Array.isArray(data?.sheets)||data.sheets.length>1000)fail(messages.GOOGLE_RESPONSE_INVALID,'GOOGLE_RESPONSE_INVALID');
   const selected=data.sheets.find(sheet=>sheet?.properties?.sheetId===reference.gid)?.properties;
   if(!selected||typeof selected.title!=='string'||!selected.title||selected.title.length>200||/[\u0000-\u001f\u007f]/.test(selected.title))fail('Вкладка с указанным gid не найдена.');
   if(name!==null&&name!==selected.title)fail('Название вкладки диапазона не совпадает с gid ссылки.');
   name=selected.title;
  }
  const a1=(name===null?'':"'"+name.replace(/'/g,"''")+"'!")+bounded.cells;
  const data=await json(root+'/values/'+encodeURIComponent(a1)+'?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE',{headers,signal});
  if(!plain(data)||!Array.isArray(data.values)||data.values.length>bounded.rowCount)fail(messages.GOOGLE_RESPONSE_INVALID,'GOOGLE_RESPONSE_INVALID');
  return {rows:tableRows(data.values).map(entry=>({...entry,row:entry.row+bounded.firstRow-1})),range:a1};
 }
 async function drive(reference,token,preserveBom=false,signal){
  const root='https://www.googleapis.com/drive/v3/files',headers={authorization:'Bearer '+token,accept:'application/json'};
  const fields='id,name,mimeType,size,trashed';
  const metadata=await json(root+'/'+encodeURIComponent(reference.id)+'?fields='+encodeURIComponent(fields)+'&supportsAllDrives=true',{headers,signal});
  let files=[];
  if(metadata?.mimeType===FOLDER){
   let pageToken='';const seen=new Set();
   do{
    const query=new URLSearchParams({q:"'"+reference.id+"' in parents and trashed = false and mimeType != '"+FOLDER+"'",pageSize:'1000',fields:'nextPageToken,incompleteSearch,files('+fields+')',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
    if(pageToken)query.set('pageToken',pageToken);
    const page=await json(root+'?'+query.toString(),{headers,signal});
    if(!plain(page)||!Array.isArray(page.files)||page.files.length>1000||page.incompleteSearch)fail(messages.GOOGLE_RESPONSE_INVALID,'GOOGLE_RESPONSE_INVALID');
    files.push(...page.files);if(files.length>MAX_ITEMS)fail(messages.IMPORT_LIMIT);
    pageToken=page.nextPageToken??'';
    if(typeof pageToken!=='string'||pageToken.length>4000||pageToken&&seen.has(pageToken)||seen.size>100)fail('Google Drive вернул повторяющуюся или незавершённую страницу списка.');
    if(pageToken)seen.add(pageToken);
   }while(pageToken);
  }else files=[metadata];
  if(!files.length)fail('В папке Google Drive нет HTML файлов.');
  const ids=new Set();let total=0;
  // Validate the entire list before downloading any media.
  for(const file of files){
   if(!plain(file)||typeof file.id!=='string'||!/^[\w-]{1,200}$/.test(file.id)||typeof file.name!=='string'||!file.name||file.name.length>255||file.trashed||!['text/html','application/xhtml+xml'].includes(file.mimeType)||!/\.html?$/i.test(file.name))fail('Google Drive: разрешены только HTML файлы; ярлыки и другие типы не поддерживаются.');
   if(ids.has(file.id))fail('Google Drive вернул повторяющийся файл.');ids.add(file.id);
   if(file.size!==undefined&&(!/^\d+$/.test(String(file.size))||!Number.isSafeInteger(Number(file.size))||Number(file.size)>MAX_HTML))fail(messages.IMPORT_LIMIT);
   total+=Number(file.size||0);if(total>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
  }
  total=0;const result=[];
  for(const file of files){
   const response=await request(root+'/'+encodeURIComponent(file.id)+'?alt=media&supportsAllDrives=true',{headers:{...headers,accept:'text/html'},signal});
   const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(String(response.headers?.['content-type']||''))?.[1];
   if(charset&&!/^(?:utf-8|utf8|us-ascii)$/i.test(charset))fail('HTML должен быть в кодировке UTF-8.');
   let html;try{html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:preserveBom}).decode(response.body??Buffer.from(response.text,'utf8'));}catch{fail('HTML должен быть в кодировке UTF-8.');}
   const bytes=Buffer.byteLength(html,'utf8');total+=bytes;
   if(bytes>MAX_HTML||total>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
   if(!response.body&&html.includes('\uFFFD'))fail('HTML должен быть в кодировке UTF-8.');
   result.push({id:file.id,name:file.name,html});
  }
  return result;
 }
 return {async preview(body,{signal}={}){
  let source={kind:'items'};
  try{
   if(signal?.aborted)fail(messages.GOOGLE_READ_ABORTED,'GOOGLE_READ_ABORTED');
   fields(body,['type','text','spreadsheetUrl','range','driveUrl','files','defaults','items','sourceFile','sourceRows','columnMapping']);
   if(!['ai','html'].includes(body.type))fail('Выберите тип проекта: AI или HTML.');
   const defaults=validateDefaults(body.defaults??{}),hasText=typeof body.text==='string'&&!!body.text.trim(),hasItems=body.items!==undefined,hasSheet=!empty(body.spreadsheetUrl),hasDrive=!empty(body.driveUrl),hasFiles=body.files!==undefined;
   const sourceFile=body.sourceFile===undefined?undefined:sourceFilename(body.sourceFile,true);if(sourceFile!==undefined&&!hasText)fail();
   if(body.text!==undefined&&typeof body.text!=='string'||body.range!==undefined&&!hasSheet)fail();
   if(Number(hasText)+Number(hasItems)+Number(hasSheet)>1||hasDrive&&hasFiles||body.type==='ai'&&(hasDrive||hasFiles)||hasItems&&(hasDrive||hasFiles))fail('Выберите один источник таблицы и один источник HTML файлов.');
   const sheetRef=hasSheet?googleReference(body.spreadsheetUrl,'sheets'):null,driveRef=hasDrive?googleReference(body.driveUrl,'drive'):null;
   if(sheetRef)boundedRange(body.range??sheetRef.range);
   if(body.columnMapping!==undefined&&(!hasText||!sourceFile))fail('Схема колонок допустима только для загруженного файла.');
   let rows=hasText?tableRows(delimited(body.text),body.columnMapping):hasItems?(Array.isArray(body.items)?body.items.map((data,index)=>({row:index+1,data})):fail()):null;
   if(body.sourceRows!==undefined){
    if(!sourceFile||!/\.(?:txt|md|docx)$/i.test(sourceFile)||!Array.isArray(body.sourceRows)||body.sourceRows.length!==rows?.length||
      body.sourceRows.some((row,index)=>!Number.isSafeInteger(row)||row<1||row>10000000||index>0&&row<=body.sourceRows[index-1]))fail('Неверные номера строк исходного задания.');
    rows=rows.map((entry,index)=>({...entry,row:body.sourceRows[index]}));
   }
   if(hasText)source={kind:'table',...(sourceFile?{file:sourceFile}:{})};
   let token;if(hasSheet||hasDrive)token=await accessToken(signal);
   if(hasSheet){const sheet=await sheets(sheetRef,body.range,token,signal);rows=sheet.rows;source={kind:'google-sheets',spreadsheetId:sheetRef.id,...(sheetRef.gid!==null?{gid:sheetRef.gid}:{}),range:boundedRange(sheet.range).cells};}
   if(hasFiles||hasDrive){
    const files=hasFiles?localFiles(body.files):await drive(driveRef,token,defaults.detectFileRegions===true,signal);
    rows=fileRows(rows,files,defaults.detectFileRegions===true);
    source={...source,kind:hasDrive?'google-drive':'files',...(hasDrive?{driveId:driveRef.id}:{}),fileCount:files.length};
   }
   if(!rows?.length)fail('В источнике нет строк для импорта.');
   if(rows.length>MAX_ITEMS)fail(messages.IMPORT_LIMIT);
   const issues=[],items=[],seen=new Set();let total=0;
   for(let index=0;index<rows.length;index++){
    const entry=rows[index];let key='';
    try{
     if(plain(entry.data))key=keyOf(entry.data,index);
     const {fileCount,...sourceReference}=source;
     const item=normalizeRow(body.type,entry.data,index,defaults,{source:{...sourceReference,...entry.provenanceSource,row:entry.row},detected:entry.detected,regionDetectionMissing:entry.regionDetectionMissing});
     if(seen.has(item.key))fail('ID строк должны быть уникальны.');seen.add(item.key);
     total+=Buffer.byteLength(JSON.stringify(item),'utf8');if(total>MAX_TOTAL)fail(messages.IMPORT_LIMIT);
     items.push(item);
    }catch(error){issues.push(issue(error,entry.row,key));}
   }
   return {items:issues.length?[]:items,issues,source:{...source,rowCount:rows.length}};
  }catch(error){return {items:[],issues:[issue(error)],source};}
 }};
}
