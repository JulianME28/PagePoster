// Private LOCAL read-only evidence. Never merge this artifact into a check,
// publication, backup or support DTO. Parsing is inert and never fetches URLs.
import path from 'node:path';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {JSDOM} from './dom-runtime.mjs';
import {expectedHtmlFor} from './published-content.mjs';
const MAX_ROWS=200,MAX_BYTES=131072,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function safeReportHref(value){
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f\\]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))return null;
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?value:null;}catch{return null;}
}
const unavailable=code=>({state:'unavailable',code,source:'stored-public-verification',verificationState:'unknown',linksState:'unknown',rows:[],totalRows:0,truncated:false});
export function buildPublishedLinkReport({expectedHtml,actualHtml,expectedMarker='pp-landing',expectedUrls=[]}={}){
 if(typeof expectedHtml!=='string'||typeof actualHtml!=='string')return unavailable('captured_content_unavailable');
 const expected=new JSDOM(expectedHtml),actual=new JSDOM(actualHtml);
 try{
  const e=expected.window.document,a=actual.window.document,id=String(expectedMarker||'pp-landing').replace(/^#/,''),expectedRoots=[...e.querySelectorAll('[id]')].filter(n=>n.id===id),er=expectedRoots[0]||e.body;
  const actualRoots=[...a.querySelectorAll('[id]')].filter(n=>n.id===id),root=expectedRoots.length?actualRoots[0]:a.body,groups=new Map();
  const group=(scope,url)=>{const key=scope+'\n'+url;if(!groups.has(key))groups.set(key,{scope,url,safeHref:safeReportHref(url),expected:false,expectedNativeHrefs:0,expectedRepeatedControls:0,nativeHrefs:0,repeatedControls:0});return groups.get(key);};
  const scan=(document,expectedSide)=>{for(const node of document.querySelectorAll('a[href],[data-pp-url]'))for(const [attribute,key] of [['href','NativeHrefs'],['data-pp-url','RepeatedControls']]){
   if(attribute==='href'&&node.localName!=='a')continue;const value=node.getAttribute(attribute);if(value===null||value.startsWith('#'))continue;
   const scope=expectedSide?'customer':root&&root.contains(node)?'customer':'outside',row=group(scope,value);if(expectedSide){row.expected=true;row['expected'+key]++;}else row[key[0].toLowerCase()+key.slice(1)]++;
  }};
  scan(er,true);scan(a,false);
  for(const url of Array.isArray(expectedUrls)?expectedUrls:[])if(typeof url==='string'){const row=group('customer',url);row.expected=true;if(!row.expectedNativeHrefs&&!row.expectedRepeatedControls)row.expectedNativeHrefs=1;}
  const rows=[],totals={expected:0,missing:0,mismatch:0,unexpected:0,invalid:0};let truncated=false,bytes=2048;
  for(const row of groups.values()){
   row.status=!row.safeHref?'invalid':row.scope==='outside'||!row.expected?'unexpected':!row.nativeHrefs&&!row.repeatedControls?'missing':row.nativeHrefs!==row.expectedNativeHrefs||row.repeatedControls!==row.expectedRepeatedControls?'mismatch':'expected';totals[row.status]++;
   // Oversized addresses remain visibly incomplete, never clickable fragments.
   if(row.url.length>8192){row.url=row.url.slice(0,8192);row.safeHref=null;row.truncated=true;truncated=true;}
   const size=Buffer.byteLength(JSON.stringify(row));if(rows.length>=MAX_ROWS||bytes+size>MAX_BYTES-2048){truncated=true;continue;}bytes+=size;rows.push(row);
  }
  const wrapperMismatch=!!expectedRoots.length&&(expectedRoots.length!==1||actualRoots.length!==1);
  return {state:'available',source:'stored-public-verification',linksState:wrapperMismatch||totals.missing||totals.mismatch||totals.unexpected||totals.invalid?'problem':'ok',rows,totalRows:groups.size,totals,truncated,wrapperMismatch};
 }finally{expected.window.close();actual.window.close();}
}
function binding(page){return {pageId:page.id,pageRevision:page.revision,siteId:page.siteId||null,wpId:page.wpId||null,fullUrl:page.fullUrl||null,contentHash:createHash('sha256').update(expectedHtmlFor(page)||'').digest('hex'),expectedHash:createHash('sha256').update(JSON.stringify([page.expectedMarker||'pp-landing',page.expectedUrls||[]])).digest('hex')};}
function location(dataDir,id){if(!UUID.test(id||''))throw Error('invalid_page_identity');return path.join(dataDir,'local-link-reports',id+'.json');}
function projectReport(report){
 if(report?.state!=='available')return unavailable('captured_content_unavailable');
 const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:0,source=Array.isArray(report.rows)?report.rows:[],rows=[];let truncated=report.truncated===true||source.length>MAX_ROWS,bytes=2048;
 for(const input of source.slice(0,MAX_ROWS)){
  if(!input||typeof input.url!=='string'){truncated=true;continue;}const url=input.url.slice(0,8192),shortened=input.url.length>8192||input.truncated===true,row={scope:input.scope==='outside'?'outside':'customer',url,safeHref:shortened?null:safeReportHref(url),expected:input.expected===true,status:['expected','missing','mismatch','unexpected','invalid'].includes(input.status)?input.status:'invalid'};
  for(const key of ['expectedNativeHrefs','expectedRepeatedControls','nativeHrefs','repeatedControls'])row[key]=count(input[key]);if(shortened){row.truncated=true;truncated=true;}
  const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>MAX_BYTES-12288){truncated=true;continue;}rows.push(row);bytes+=size;
 }
 const totals={};for(const key of ['expected','missing','mismatch','unexpected','invalid'])totals[key]=count(report.totals?.[key]);
 return {state:'available',source:'stored-public-verification',linksState:['ok','problem'].includes(report.linksState)?report.linksState:'unknown',rows,totalRows:Math.max(count(report.totalRows),source.length),totals,truncated,wrapperMismatch:report.wrapperMismatch===true};
}
export async function writeLocalLinkReport(dataDir,page,report,{verificationState='unknown',capturedAt=new Date().toISOString()}={}){
 const target=location(dataDir,page.id),value={binding:binding(page),report:{...projectReport(report),pageId:page.id,pageRevision:page.revision,verificationState:['ok','problem'].includes(verificationState)?verificationState:'unknown',capturedAt}};
 const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>MAX_BYTES)throw Error('local_report_limit');await mkdir(path.dirname(target),{recursive:true});const temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,encoded,{encoding:'utf8',mode:0o600});await rename(temp,target);
}
export async function readLocalLinkReport(dataDir,page){
 try{const target=location(dataDir,page.id);if((await stat(target)).size>MAX_BYTES)return {...unavailable('captured_content_unavailable'),pageId:page.id,pageRevision:page.revision};const encoded=await readFile(target,'utf8');if(Buffer.byteLength(encoded)>MAX_BYTES)throw Error('local_report_limit');const value=JSON.parse(encoded);if(JSON.stringify(value.binding)!==JSON.stringify(binding(page)))return {...unavailable('captured_revision_changed'),pageId:page.id,pageRevision:page.revision};return {...projectReport(value.report),pageId:page.id,pageRevision:page.revision,verificationState:['ok','problem'].includes(value.report?.verificationState)?value.report.verificationState:'unknown',capturedAt:typeof value.report?.capturedAt==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.report.capturedAt)?value.report.capturedAt:null};}
 catch{return {...unavailable('captured_content_unavailable'),pageId:page.id,pageRevision:page.revision};}
}
