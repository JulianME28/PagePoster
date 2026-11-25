// Private Google Sheets source. Tokens and row credentials remain inside this
// reader and its private candidate; public status must only expose safe metadata.
import {createHash,createPrivateKey,sign} from 'node:crypto';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
import {parseSheetReference,buildSourceUrl} from './sheet-reference.mjs';
import {describeSiteSelection} from './site-selection.mjs';
import {createGoogleRead} from './google-read.mjs';
import {donorDomainKey} from './donor-domain.mjs';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const READ_SCOPE='https://www.googleapis.com/auth/spreadsheets.readonly';
const MAX_ROWS=100000,PAGE_ROWS=2000,MAX_ISSUES=1000;
const COLUMN_KEYS=['url','username','password','alternateUsername','alternatePassword','dr','traffic','geo','enabled'];
const messages={source_validation:'Перевір налаштування приватної таблиці та критерії вибору.',source_auth_failed:'Google не підтвердив доступ сервісного облікового запису.',source_read_failed:'Не вдалося прочитати приватну таблицю.',source_response_invalid:'Таблиця повернула непідтримувані дані.',source_limit_exceeded:'Діапазон перевищує ліміт 100 000 рядків. Звузь діапазон таблиці; частковий вибір не виконується.'};
export class SiteSourceError extends Error{constructor(code){super(messages[code]||messages.source_read_failed);this.name='SiteSourceError';this.code=code;}}
messages.source_access_denied='Обраний Google-акаунт не має доступу до таблиці (403). Надайте доступ на читання або оберіть інший акаунт.';
messages.source_sheet_not_found='Вкладку з посилання не знайдено в цій Google-таблиці. Перевір посилання та доступ до обраної вкладки.';
messages.source_rate_limited='Google тимчасово обмежив читання таблиці. Спробуй пізніше; частковий вибір сайтів не виконується.';
messages.source_read_aborted='Читання таблиці Google скасовано.';
const fail=code=>{throw new SiteSourceError(code);};
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function column(value){if(typeof value!=='string'||! /^[A-Z]{1,3}$/i.test(value))fail('source_validation');return [...value.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;}
function a1Range(value){
 if(typeof value!=='string'||!value.trim()||value.length>300)fail('source_validation');
 const text=value.trim(),match=/^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?([A-Z]{1,3})([1-9][0-9]*)?(?::([A-Z]{1,3})([1-9][0-9]*)?)?$/i.exec(text);
 if(!match)fail('source_validation');
 const firstColumn=column(match[3]),lastColumn=column(match[5]||match[3]),firstRow=Number(match[4]||1),lastRow=match[6]?Number(match[6]):match[5]?null:match[4]?firstRow:null;
 if(firstColumn>lastColumn||!Number.isSafeInteger(firstRow)||firstRow>10000000||lastRow!==null&&(!Number.isSafeInteger(lastRow)||lastRow<firstRow||lastRow>10000000))fail('source_validation');
 const sheetName=match[1]!==undefined?match[1].replace(/''/g,"'"):match[2]??null;
 if(sheetName!==null&&(!sheetName||/[\r\n\0]/.test(sheetName)))fail('source_validation');
 return {range:text,sheetName,firstColumn,lastColumn,firstColumnName:match[3].toUpperCase(),lastColumnName:(match[5]||match[3]).toUpperCase(),firstRow,lastRow};
}
export function validateSiteSourceConfig(value,{allowMissingAccount=false}={}){
 if(!object(value)||Object.keys(value).some(key=>!['spreadsheetId','spreadsheetUrl','sheetId','range','columns','headerRows','serviceAccount','authMode'].includes(key)))fail('source_validation');
 if(value.authMode!==undefined&&!['service','user','browser'].includes(value.authMode))fail('source_validation');
 const hasReference=value.spreadsheetUrl!==undefined||value.sheetId!==undefined;
 let reference;try{reference=parseSheetReference(value.spreadsheetUrl??value.spreadsheetId);}catch{fail('source_validation');}
 if(value.spreadsheetId!==undefined&&(typeof value.spreadsheetId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(value.spreadsheetId)||value.spreadsheetId!==reference.spreadsheetId))fail('source_validation');
 if(value.sheetId!==undefined&&value.sheetId!==null&&(!Number.isSafeInteger(value.sheetId)||value.sheetId<0||value.sheetId>2147483647))fail('source_validation');
 if(reference.sheetId!==null&&value.sheetId!==undefined&&value.sheetId!==null&&reference.sheetId!==value.sheetId)fail('source_validation');
 const sheetId=reference.sheetId??value.sheetId??null;
 if(value.authMode==='browser'&&sheetId===null)fail('source_validation');
 if(!object(value.columns)||Object.keys(value.columns).some(key=>!COLUMN_KEYS.includes(key)))fail('source_validation');
 const columns={};
 for(const key of COLUMN_KEYS){const raw=value.columns[key];if(raw===undefined||raw===null||raw===''){if(['url','username','password'].includes(key))fail('source_validation');continue;}column(raw);columns[key]=raw.toUpperCase();}
 if(new Set(Object.values(columns)).size!==Object.keys(columns).length||!!columns.alternateUsername!==!!columns.alternatePassword)fail('source_validation');
 const mapped=Object.values(columns).sort((a,b)=>column(a)-column(b));
 const range=a1Range(value.range===undefined||value.range===null||value.range===''?sheetId!==null?mapped[0]+':'+mapped.at(-1):value.range:value.range);
 for(const name of mapped)if(column(name)<range.firstColumn||column(name)>range.lastColumn)fail('source_validation');
 const headerRows=value.headerRows??1;if(!Number.isSafeInteger(headerRows)||headerRows<0||headerRows>20)fail('source_validation');
 const result={spreadsheetId:reference.spreadsheetId,...(hasReference?{spreadsheetUrl:buildSourceUrl({spreadsheetId:reference.spreadsheetId,sheetId}),sheetId}:{}),range:range.range,columns,headerRows,...(value.authMode!==undefined?{authMode:value.authMode}:{})},account=value.serviceAccount;
 if(account===undefined||account===null){if(!allowMissingAccount)fail('source_validation');return result;}
 if(!object(account))fail('source_validation');
 if(account.clientEmail!==undefined&&account.client_email!==undefined&&account.clientEmail!==account.client_email||account.privateKey!==undefined&&account.private_key!==undefined&&account.privateKey!==account.private_key)fail('source_validation');
 const clientEmail=account.clientEmail??account.client_email,privateKey=account.privateKey??account.private_key;
 if(typeof clientEmail!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)||typeof privateKey!=='string'||!privateKey||privateKey.length>16000)fail('source_validation');
 result.serviceAccount={clientEmail,privateKey};return result;
}
const countryCodes=new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
function canonicalCountryCode(raw){
 const code=raw.trim().toUpperCase();
 return code==='UK'?'GB':countryCodes.has(code)?code:null;
}
export function normalizeSiteCriteria(value){
 if(value===undefined||value===null)value={};
 if(!object(value)||Object.keys(value).some(key=>!['minDr','minTraffic','geo'].includes(key)))fail('source_validation');
 const minDr=value.minDr??null,minTraffic=value.minTraffic??null,rawGeo=value.geo??'';
 if(minDr!==null&&(typeof minDr!=='number'||!Number.isFinite(minDr)||minDr<0||minDr>100)||minTraffic!==null&&(!Number.isSafeInteger(minTraffic)||minTraffic<0)||typeof rawGeo!=='string'||rawGeo.length>1000)fail('source_validation');
 const codes=rawGeo.trim()?rawGeo.split(',').map(canonicalCountryCode):[];
 if(codes.includes(null))fail('source_validation');
 return {minDr,minTraffic,geo:[...new Set(codes)].sort().join(',')};
}
function configuration(value,options){const normalized=validateSiteSourceConfig(value,options),range=a1Range(normalized.range);return {...normalized,...range,columns:Object.fromEntries(Object.entries(normalized.columns).map(([key,name])=>[key,column(name)-range.firstColumn])),normalized};}
// Private policy scope only. Never copy credentials, tokens or an account key
// into this descriptor; the runtime supplies the current reader principal.
export function siteSourcePolicyIdentity(input,resolved={}){
 const config=validateSiteSourceConfig(input,{allowMissingAccount:true}),range=a1Range(config.range);
 if(!object(resolved))fail('source_validation');
 const sheetId=resolved.resolvedSheetId??resolved.sheetId??config.sheetId??null,sheetName=resolved.sheetName===undefined?range.sheetName:resolved.sheetName;
 if(sheetId!==null&&(!Number.isSafeInteger(sheetId)||sheetId<0||sheetId>2147483647)||sheetName!==null&&(typeof sheetName!=='string'||!sheetName||sheetName.length>300||/[\r\n\0]/.test(sheetName)))fail('source_validation');
 if(sheetId===null&&sheetName===null)return null;
 const prefix=sheetName===null?'':(/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName)?sheetName:"'"+sheetName.replace(/'/g,"''")+"'")+"!";
 return {spreadsheetId:config.spreadsheetId,resolvedSheetId:sheetId,sheetName,range:prefix+range.firstColumnName+range.firstRow+':'+range.lastColumnName+(range.lastRow??''),columns:{...config.columns},headerRows:config.headerRows,authMode:config.authMode||'service'};
}
function parsed(response,expectedUrl,code){
 if(!response||response.status<200||response.status>=300||typeof response.text!=='string'||Buffer.byteLength(response.text)>2*1024*1024)fail(code);
 try{if(new URL(response.url||expectedUrl).href!==expectedUrl)fail(code);return JSON.parse(response.text);}catch{fail(code);}
}
function metric(value,kind){
 if(typeof value==='string'){value=value.trim();if(!value||!(kind==='dr'?/^(?:\d+(?:\.\d+)?|\.\d+)$/:/^\d+$/).test(value))return null;value=Number(value);}
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||kind==='dr'&&value>100||kind==='traffic'&&!Number.isSafeInteger(value))return null;
 return value;
}
function geoCodes(value){
 if(value===undefined||value===null||value==='')return [];
 if(typeof value!=='string'||value.length>4000)return null;
 const text=value.trim();if(!text)return [];
 const plain=text.split(/[,;\s]+/);if(plain.every(code=>/^[a-z]{2}$/i.test(code))){const codes=plain.map(canonicalCountryCode);return codes.includes(null)?null:[...new Set(codes)].sort();}
 // Sheet exports sometimes store a list of (country, count) tuples. Match the
 // complete representation so "status" never accidentally matches US.
 const codes=[],tuple=/\(\s*(?:'([a-z]{2})'|"([a-z]{2})"|([a-z]{2}))\s*,\s*(?:\d+(?:\.\d+)?|\.\d+)\s*\)/gi;
 const remaining=text.replace(tuple,(_,a,b,c)=>{codes.push(canonicalCountryCode(a||b||c));return '';});
 return codes.length&&!codes.includes(null)&&!remaining.replace(/[,;\s]/g,'')?[...new Set(codes)].sort():null;
}
function credential(username,password){return typeof username==='string'&&username.trim()&&username.length<=256&&!/[\r\n\0:]/.test(username)&&typeof password==='string'&&password.length>0&&password.length<=4096&&!/[\r\n\0]/.test(password)?{username:username.trim(),password}:null;}
function publicBase(value){
 if(typeof value!=='string')throw Error();let text=value.trim();
 // Only a bare host gets an implicit scheme. Paths, userinfo, ports and other
 // URL syntax must already be a complete HTTPS URL and pass the shared guard.
 const bare=text.endsWith('/')?text.slice(0,-1):text;if(bare&&!/[\/\\:@?#\s]/.test(bare))text='https://'+bare;
 const base=validatePublicUrl(text);if(base.search||base.hash)throw Error();if(!base.pathname.endsWith('/'))base.pathname+='/';return base;
}
export function createSiteSource({transport=createSafeTransport({allowWrites:true}),readSheet,getAccessToken,clock=Date.now,readRetry={}}={}){
 const read=createGoogleRead({clock,...readRetry,transport});
 async function accessToken(config,signal){
  if(signal?.aborted)fail('source_read_aborted');
  if(getAccessToken){const token=await getAccessToken(config);if(token!==undefined&&token!==null){if(typeof token!=='string'||!token||token.length>8192||/[\u0000-\u0020\u007f]/.test(token))fail('source_auth_failed');return token;}}
  if(!config.serviceAccount)fail('source_auth_failed');
  const now=Math.floor(clock()/1000);if(!Number.isSafeInteger(now)||now<0)fail('source_validation');
  const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=b64({alg:'RS256',typ:'JWT'})+'.'+b64({iss:config.serviceAccount.clientEmail,scope:READ_SCOPE,aud:TOKEN_URL,iat:now,exp:now+3600});
  let assertion;try{const key=createPrivateKey(config.serviceAccount.privateKey);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength||0)<2048)fail('source_validation');assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),key).toString('base64url');}catch{fail('source_validation');}
  let token;try{token=parsed(await transport(TOKEN_URL,{method:'POST',signal,followRedirects:false,headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()}),TOKEN_URL,'source_auth_failed');}catch{if(signal?.aborted)fail('source_read_aborted');fail('source_auth_failed');}
  if(!object(token)||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||/[\r\n]/.test(token.access_token)||token.token_type?.toLowerCase()!=='bearer')fail('source_auth_failed');
  return token.access_token;
 }
 async function* sheets(config,signal){
  if(readSheet){let data;try{data=await readSheet(config.normalized);}catch(error){if(error instanceof SiteSourceError)throw error;fail({GOOGLE_BROWSER_AUTH_REQUIRED:'source_auth_failed',GOOGLE_BROWSER_ACCESS_DENIED:'source_access_denied',GOOGLE_BROWSER_LIMIT:'source_limit_exceeded'}[error?.code]||'source_read_failed');}yield {data,firstRow:config.firstRow,rowLimit:MAX_ROWS,sourceIdentity:siteSourcePolicyIdentity(config.normalized)};return;}
  const token=await accessToken(config,signal),root='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(config.spreadsheetId);
  const get=async url=>{try{const response=await read(url,{signal,headers:{authorization:'Bearer '+token,accept:'application/json'}});if(response?.status===403)fail('source_access_denied');return parsed(response,url,'source_read_failed');}catch(error){if(signal?.aborted||error?.code==='google_read_aborted')fail('source_read_aborted');if(error?.code==='google_read_rate_limited')fail('source_rate_limited');if(error instanceof SiteSourceError)throw error;fail('source_read_failed');}};
  let lastRow=config.lastRow,sheetName=config.sheetName,resolvedSheetId=config.sheetId??null;
  if(config.sheetId!==undefined&&config.sheetId!==null||sheetName===null||lastRow===null||lastRow-config.firstRow+1>PAGE_ROWS){
   const metadata=await get(root+'?fields='+encodeURIComponent('sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))'));
   if(!object(metadata)||!Array.isArray(metadata.sheets)||metadata.sheets.length>1000)fail('source_response_invalid');
   const properties=metadata.sheets.map(sheet=>sheet?.properties).filter(object);
   const selected=config.sheetId!==undefined&&config.sheetId!==null?properties.find(sheet=>sheet.sheetId===config.sheetId):sheetName!==null?properties.find(sheet=>sheet.title===sheetName):properties.filter(sheet=>!sheet.hidden).sort((a,b)=>(a.index??0)-(b.index??0))[0];
   if(!selected&&config.sheetId!==undefined&&config.sheetId!==null)fail('source_sheet_not_found');
   const rows=selected?.gridProperties?.rowCount,columns=selected?.gridProperties?.columnCount;
   if(!selected||typeof selected.title!=='string'||!Number.isSafeInteger(rows)||rows<1||!Number.isSafeInteger(columns)||columns<=config.lastColumn)fail('source_response_invalid');
   lastRow=Math.min(lastRow??rows,rows);sheetName=selected.title;resolvedSheetId=selected.sheetId??null;
  }
  if(lastRow-config.firstRow+1>MAX_ROWS)fail('source_limit_exceeded');
  const sourceIdentity=siteSourcePolicyIdentity(config.normalized,{sheetId:resolvedSheetId,sheetName});
  if(lastRow<config.firstRow){yield {data:{values:[]},firstRow:config.firstRow,rowLimit:0,sourceIdentity};return;}
  for(let firstRow=config.firstRow;firstRow<=lastRow;firstRow+=PAGE_ROWS){
   const end=Math.min(firstRow+PAGE_ROWS-1,lastRow);
   const range=(config.sheetId===undefined||config.sheetId===null)&&firstRow===config.firstRow&&end===config.lastRow&&lastRow-config.firstRow+1<=PAGE_ROWS?config.range:(sheetName===null?'':"'"+sheetName.replace(/'/g,"''")+"'!")+config.firstColumnName+firstRow+':'+config.lastColumnName+end;
   yield {data:await get(root+'/values/'+encodeURIComponent(range)+'?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE'),firstRow,rowLimit:end-firstRow+1,sourceIdentity};
  }
 }
 async function readCandidates(input,{usedOrigins=[],usedRowIds=[],criteria:rawCriteria,preserveOrigins=false,includeSelectionPool=false,unavailability,signal}={}){
  if(signal?.aborted)fail('source_read_aborted');
  const config=configuration(input,{allowMissingAccount:!!readSheet||!!getAccessToken}),criteria=normalizeSiteCriteria(rawCriteria);
  if(criteria.minDr!==null&&config.columns.dr===undefined||criteria.minTraffic!==null&&config.columns.traffic===undefined||criteria.geo&&config.columns.geo===undefined)fail('source_validation');
  if(!Array.isArray(usedOrigins)||!Array.isArray(usedRowIds)||usedOrigins.length>MAX_ROWS||usedRowIds.length>MAX_ROWS||usedRowIds.some(id=>typeof id!=='string'||id.length>500))fail('source_validation');
  const used=new Set();for(const value of usedOrigins){try{used.add(donorDomainKey(value));}catch{fail('source_validation');}}
  const rowIds=new Set(usedRowIds),byOrigin=new Map(),pool=[],diagnosticPool=[],issues=[],requestedGeo=criteria.geo?criteria.geo.split(','):[],inputDiagnostics={unit:'rows',nonempty:0,disabled:0,invalidUrl:0,invalidRow:0,missingCredentials:0};let issueCount=0,sourceIdentity=null;
  const issue=(rowNumber,code)=>{issueCount++;if(issues.length<MAX_ISSUES)issues.push({rowNumber,code});};
  const rankMetrics=config.columns.dr!==undefined||config.columns.traffic!==undefined;
  const compare=(a,b)=>rankMetrics?(b.metrics.dr??-1)-(a.metrics.dr??-1)||(b.metrics.traffic??-1)-(a.metrics.traffic??-1)||a.rowNumber-b.rowNumber:a.rowNumber-b.rowNumber;
  for await(const {data,firstRow,rowLimit,sourceIdentity:resolvedIdentity} of sheets(config,signal)){
   if(signal?.aborted)fail('source_read_aborted');
   if(!object(data)||data.values!==undefined&&!Array.isArray(data.values))fail('source_response_invalid');
   if((data.values?.length||0)>MAX_ROWS)fail('source_limit_exceeded');
   if((data.values?.length||0)>rowLimit)fail('source_response_invalid');
   sourceIdentity=resolvedIdentity;
   for(const [index,row] of (data.values||[]).entries()){
    const rowNumber=firstRow+index;if(rowNumber<config.firstRow+config.headerRows)continue;
    if(!Array.isArray(row)){inputDiagnostics.nonempty++;inputDiagnostics.invalidRow++;issue(rowNumber,'invalid_row');continue;}
    if(row.every(cell=>cell===null||cell===undefined||cell===''))continue;
    inputDiagnostics.nonempty++;
    if(config.columns.enabled!==undefined){const flag=String(row[config.columns.enabled]??'').trim().toLowerCase();if(!['1','true','yes','on','так'].includes(flag)){if(!['','0','false','no','off','ні'].includes(flag)){inputDiagnostics.invalidRow++;issue(rowNumber,'invalid_enabled');}else inputDiagnostics.disabled++;continue;}}
    let base;try{base=publicBase(row[config.columns.url]);}catch{inputDiagnostics.invalidUrl++;issue(rowNumber,'invalid_url');continue;}
    const id='sheet-origin-'+createHash('sha256').update(base.origin).digest('hex');
    const primary=credential(row[config.columns.username],row[config.columns.password]),alternate=config.columns.alternateUsername===undefined?null:credential(row[config.columns.alternateUsername],row[config.columns.alternatePassword]),chosen=primary||alternate;
    if(!chosen){inputDiagnostics.missingCredentials++;issue(rowNumber,'missing_credentials');continue;}
    const metrics={dr:config.columns.dr===undefined?null:metric(row[config.columns.dr],'dr'),traffic:config.columns.traffic===undefined?null:metric(row[config.columns.traffic],'traffic'),geo:config.columns.geo===undefined?[]:geoCodes(row[config.columns.geo])};
    for(const key of ['dr','traffic'])if(config.columns[key]!==undefined&&row[config.columns[key]]!==undefined&&row[config.columns[key]]!==null&&row[config.columns[key]]!==''&&metrics[key]===null)issue(rowNumber,'invalid_'+key);
    if(metrics.geo===null){issue(rowNumber,'invalid_geo');metrics.geo=[];}
    const candidate={id,baseUrl:base.href,...chosen,rowNumber,metrics};
    diagnosticPool.push(candidate);
    if(used.has(donorDomainKey(base))||rowIds.has(id)||criteria.minDr!==null&&(metrics.dr===null||metrics.dr<criteria.minDr)||criteria.minTraffic!==null&&(metrics.traffic===null||metrics.traffic<criteria.minTraffic)||requestedGeo.length&&!requestedGeo.some(code=>metrics.geo.includes(code)))continue;
    if(primary&&alternate&&(primary.username!==alternate.username||primary.password!==alternate.password))candidate.alternateCredentials=alternate;
    if(preserveOrigins)pool.push(candidate);else{const previous=byOrigin.get(base.origin);if(!previous||compare(candidate,previous)<0)byOrigin.set(base.origin,candidate);}
   }
  }
  return {candidates:(preserveOrigins?pool:[...byOrigin.values()]).sort(compare),issues,sourceIdentity,...(includeSelectionPool?{selectionPool:diagnosticPool}:{}),inputDiagnostics,diagnostics:describeSiteSelection(diagnosticPool,{criteria,usedOrigins,usedRowIds,unavailability,inputDiagnostics}),...(issueCount>issues.length?{issuesTruncated:true,issueCount}:{})};
 }
 async function pickUnused(config,options){const result=await readCandidates(config,options);options?.onSourceIdentity?.(result.sourceIdentity);return result.candidates[0]||null;}
 return{readCandidates,pickUnused};
}
