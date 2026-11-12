import path from 'node:path';
import {createRequire} from 'node:module';
import {mkdir,lstat,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {parseSheetReference} from './sheet-reference.mjs';
import {findBrowserExecutable} from './browser-executable.cjs';

const require=createRequire(import.meta.url);

const MAX_BYTES=25*1024*1024,MAX_ROWS=100000,CACHE_MS=20000,PROBE_MS=5000;
const MESSAGES={
 GOOGLE_BROWSER_REQUIRED:'Відкрийте Google-таблицю у вікні підключення PagePoster.',
 GOOGLE_BROWSER_AUTH_REQUIRED:'Увійдіть у Google у відкритому вікні Chrome та відкрийте обрану таблицю.',
 GOOGLE_BROWSER_UNAVAILABLE:'Не вдалося відкрити або продовжити сеанс Chrome для Google-таблиці.',
 GOOGLE_BROWSER_READ_FAILED:'Не вдалося безпечно прочитати обрану Google-таблицю.',
 GOOGLE_BROWSER_ACCESS_DENIED:'Цей Google-акаунт не має доступу до обраної таблиці. Надайте йому доступ на читання.',
 GOOGLE_BROWSER_LIMIT:'Google-таблиця перевищує ліміт 100 000 рядків або 25 МБ. Частковий вибір не виконується.',
 GOOGLE_SHEET_TAB_REQUIRED:'Вставте повне посилання на обрану вкладку Google-таблиці з gid.'
};
const error=code=>Object.assign(new Error(MESSAGES[code]||MESSAGES.GOOGLE_BROWSER_READ_FAILED),{code:Object.hasOwn(MESSAGES,code)?code:'GOOGLE_BROWSER_READ_FAILED'});
const fail=code=>{throw error(code);};
const safeError=value=>error(value&&Object.hasOwn(MESSAGES,value.code)?value.code:'GOOGLE_BROWSER_READ_FAILED');
export const googleSheetData={sheetReference,parseCsv,rangeBounds,column,normalizedMetric};

function sheetReference(value){
 if(typeof value!=='string'||!value.trim().startsWith('https://'))fail('GOOGLE_BROWSER_READ_FAILED');
 let url;try{url=new URL(value);}catch{fail('GOOGLE_BROWSER_READ_FAILED');}
 if(url.protocol!=='https:'||url.hostname!=='docs.google.com'||url.port||url.username||url.password)fail('GOOGLE_BROWSER_READ_FAILED');
 const hash=new URLSearchParams(url.hash.slice(1)),query=url.searchParams;
 if(hash.getAll('gid').length>1||query.getAll('gid').length>1)fail('GOOGLE_SHEET_TAB_REQUIRED');
 const raw=hash.get('gid')??query.get('gid');
 if(raw!==null&&(! /^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647))fail('GOOGLE_SHEET_TAB_REQUIRED');
 let reference;try{reference=parseSheetReference(value);}catch{fail('GOOGLE_BROWSER_READ_FAILED');}
 if(reference.sheetId===null)fail('GOOGLE_SHEET_TAB_REQUIRED');
 return reference;
}

function exportUrl(value,base){
 let url;try{url=new URL(value,base);}catch{fail('GOOGLE_BROWSER_READ_FAILED');}
 const host=url.hostname;
 if(url.protocol!=='https:'||url.port||url.username||url.password||!(host==='docs.google.com'||host==='accounts.google.com'||/^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(host)))fail('GOOGLE_BROWSER_READ_FAILED');
 return url;
}

function column(value){if(typeof value!=='string'||! /^[A-Z]{1,3}$/i.test(value))fail('GOOGLE_BROWSER_READ_FAILED');return [...value.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;}
function rangeBounds(value){
 if(typeof value!=='string'||value.length>300)fail('GOOGLE_BROWSER_READ_FAILED');
 const m=/^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?([A-Z]{1,3})([1-9]\d*)?(?::([A-Z]{1,3})([1-9]\d*)?)?$/i.exec(value.trim());
 if(!m||/[\r\n\0]/.test(value))fail('GOOGLE_BROWSER_READ_FAILED');
 const firstColumn=column(m[3]),lastColumn=column(m[5]||m[3]),firstRow=Number(m[4]||1),lastRow=m[6]?Number(m[6]):m[5]?null:m[4]?firstRow:null;
 if(firstColumn>lastColumn||!Number.isSafeInteger(firstRow)||firstRow>10000000||lastRow!==null&&(!Number.isSafeInteger(lastRow)||lastRow<firstRow||lastRow>10000000))fail('GOOGLE_BROWSER_READ_FAILED');
 if(lastRow!==null&&lastRow-firstRow+1>MAX_ROWS)fail('GOOGLE_BROWSER_LIMIT');
 return {firstColumn,lastColumn,firstRow,lastRow};
}

// Keep every field exact. In particular, credentials must not be trimmed or
// locale-normalized; only the two explicitly mapped metric columns are numeric.
function parseCsv(buffer){
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{fail('GOOGLE_BROWSER_READ_FAILED');}
 if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
 if(!text)return [];
 const rows=[];let row=[],field='',quoted=false,afterQuote=false,fieldStarted=false;
 const cell=()=>{row.push(field);field='';afterQuote=false;fieldStarted=false;};
 const finish=()=>{cell();rows.push(row);row=[];if(rows.length>MAX_ROWS)fail('GOOGLE_BROWSER_LIMIT');};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;}}else field+=c;continue;}
  if(c===','){cell();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;finish();continue;}
  if(afterQuote)fail('GOOGLE_BROWSER_READ_FAILED');
  if(c==='"'){if(fieldStarted)fail('GOOGLE_BROWSER_READ_FAILED');quoted=true;fieldStarted=true;continue;}
  field+=c;fieldStarted=true;
 }
 if(quoted)fail('GOOGLE_BROWSER_READ_FAILED');
 if(fieldStarted||afterQuote||field||row.length)finish();
 return rows;
}

function normalizedMetric(value,kind){
 if(typeof value!=='string')return value;
 const text=value.trim();
 if(kind==='dr'&&/^(?:\d{1,2}|100),\d{1,2}$/.test(text)){const n=Number(text.replace(',','.'));if(n<=100)return n;}
 if(kind==='traffic'&&/^\d{1,3}([ ,.\u00a0\u202f])\d{3}(?:\1\d{3})*$/.test(text)){const n=Number(text.replace(/[ ,.\u00a0\u202f]/g,''));if(Number.isSafeInteger(n))return n;}
 return value;
}

function browserRuntime(){
 const base=path.resolve(path.dirname(process.execPath),'..','node_modules');
 for(const name of [process.env.PAGEPOSTER_PLAYWRIGHT_MODULE,'playwright-core','playwright',path.join(base,'playwright-core'),path.join(base,'playwright')].filter(Boolean))try{return require(name).chromium;}catch{}
 return null;
}
function browserExecutable(chromium){
 return findBrowserExecutable({chromium,preferBundled:false});
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForExit(child,timeout){
 if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)return;
 await new Promise(resolve=>{
  let timer;const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve();};
  timer=setTimeout(done,timeout);child.once('exit',done);
 });
}

// Chrome owns its native profile and all Google authentication. The adapter only
// connects to the debugging port of the process it just started; it never imports
// another Chrome profile, inspects cookies, or handles a Google login form.
export function createGoogleChromeLauncher({chromium,executablePath,spawnProcess=spawn,startupTimeout=20000}={}){
 return async function launch({profileDir,spreadsheetUrl,signal}){
  const reference=sheetReference(spreadsheetUrl),runtime=chromium||browserRuntime(),executable=executablePath||browserExecutable(runtime);
  if(!runtime?.connectOverCDP||!executable||!path.isAbsolute(profileDir)||path.basename(profileDir)!=='google-browser-profile')fail('GOOGLE_BROWSER_UNAVAILABLE');
  let child,browser,spawnError=null;
  const abort=()=>{if(child&&child.exitCode===null&&!child.signalCode&&!child.killed)child.kill();};
  try{
   if(signal?.aborted)fail('GOOGLE_BROWSER_UNAVAILABLE');
   await mkdir(profileDir,{recursive:true,mode:0o700});
   const info=await lstat(profileDir);if(!info.isDirectory()||info.isSymbolicLink())fail('GOOGLE_BROWSER_UNAVAILABLE');
   const portFile=path.join(profileDir,'DevToolsActivePort');
   await rm(portFile,{force:true});
   child=spawnProcess(executable,['--user-data-dir='+profileDir,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--new-window',reference.spreadsheetUrl],{stdio:'ignore',windowsHide:false,shell:false});
   child.on('error',value=>{spawnError=value;});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const deadline=Date.now()+startupTimeout;let port=null;
   while(Date.now()<deadline){
    if(signal?.aborted||spawnError||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)fail('GOOGLE_BROWSER_UNAVAILABLE');
    try{
     const text=await readFile(portFile,'utf8'),lines=text.trim().split(/\r?\n/);
     if(/^[1-9]\d{0,4}$/.test(lines[0]||'')&&Number(lines[0])<=65535&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]||'')){port=Number(lines[0]);break;}
    }catch{}
    await pause(Math.min(100,Math.max(1,deadline-Date.now())));
   }
   if(!port)fail('GOOGLE_BROWSER_UNAVAILABLE');
   browser=await runtime.connectOverCDP('http://127.0.0.1:'+port,{timeout:Math.max(1,deadline-Date.now())});
   if(signal?.aborted)fail('GOOGLE_BROWSER_UNAVAILABLE');
   const context=browser.contexts()[0];if(!context)fail('GOOGLE_BROWSER_UNAVAILABLE');
   let closed=false;
   const close=async()=>{
    if(closed)return;closed=true;
    // Browser.close on an attached Playwright client can detach without closing
    // Chrome. Send the native CDP command so the owned profile is flushed first.
    try{const cdp=await browser.newBrowserCDPSession();await cdp.send('Browser.close');}catch{}
    await browser.close().catch(()=>{});
    await waitForExit(child,2000);
    if(child.exitCode===null&&!child.signalCode&&!child.killed)child.kill();
   };
   return {browser,context,page:context.pages()[0]||null,close};
  }catch{
   if(browser){try{const cdp=await browser.newBrowserCDPSession();await cdp.send('Browser.close');}catch{}await browser.close().catch(()=>{});}
   if(child&&child.exitCode===null&&!child.signalCode&&!child.killed)child.kill();
   fail('GOOGLE_BROWSER_UNAVAILABLE');
  }finally{signal?.removeEventListener('abort',abort);}
 };
}
async function launchChrome(options){return createGoogleChromeLauncher()(options);}

function asSession(value){
 const context=value?.context||value;
 if(!context?.request?.get)fail('GOOGLE_BROWSER_UNAVAILABLE');
 const browser=value?.browser&&typeof value.browser!=='function'?value.browser:context.browser?.();
 const page=value?.page||context.pages?.()[0]||null;
 return {context,browser,page,close:typeof value?.close==='function'?()=>value.close():async()=>{await context.close?.();await browser?.close?.();}};
}

export async function createGoogleBrowser({dataDir,clock=Date.now,launch=launchChrome}={}){
 if(typeof dataDir!=='string'||!dataDir)fail('GOOGLE_BROWSER_UNAVAILABLE');
 const profileDir=path.join(path.resolve(dataDir),'google-browser-profile');
 let target=null,session=null,phase='idle',lastError=null,timer=null,version=0,cache=null,opening=null,launchAbort=null;
 const pending=new Map();
 const clearTimer=()=>{if(timer)clearTimeout(timer);timer=null;};
 function available(){return !!session&&(!session.browser?.isConnected||session.browser.isConnected())&&(!session.page?.isClosed||!session.page.isClosed());}
 function status(){
  if(session&&!available()){phase='error';lastError='GOOGLE_BROWSER_UNAVAILABLE';cache=null;clearTimer();}
  return {connected:phase==='connected',phase,email:'',clientConfigured:true,method:'browser',...(lastError?{error:{code:lastError,message:MESSAGES[lastError]}}:{}),...(target?{spreadsheetUrl:target.spreadsheetUrl}:{})};
 }
 function assertCurrent(epoch){if(epoch!==version||!session)fail('GOOGLE_BROWSER_REQUIRED');if(!available())fail('GOOGLE_BROWSER_UNAVAILABLE');}
 function pageReady(){
  if(!session?.page?.url)return true;
  try{const url=new URL(session.page.url()),match=/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{1,200})(?:\/(?:edit|view|htmlview))?\/?$/.exec(url.pathname);return url.protocol==='https:'&&url.hostname==='docs.google.com'&&!url.port&&!url.username&&!url.password&&match?.[1]===target?.spreadsheetId;}catch{return false;}
 }
 function recordFailure(value,epoch){if(epoch!==version)return;lastError=value.code;phase=value.code==='GOOGLE_BROWSER_AUTH_REQUIRED'?'waiting':'error';cache=null;}
 async function download(reference,epoch){
  assertCurrent(epoch);
  if(!pageReady())fail('GOOGLE_BROWSER_AUTH_REQUIRED');
  let url=new URL('https://docs.google.com/spreadsheets/d/'+reference.spreadsheetId+'/export?format=csv&gid='+reference.sheetId);
  for(let redirects=0;redirects<=5;redirects++){
   assertCurrent(epoch);
   if(url.hostname==='accounts.google.com')fail('GOOGLE_BROWSER_AUTH_REQUIRED');
   let reply;
   try{
    reply=await session.context.request.get(url.href,{maxRedirects:0,timeout:15000,failOnStatusCode:false,headers:{accept:'text/csv'}});
    assertCurrent(epoch);
    const replyUrl=typeof reply.url==='function'?reply.url():null;
    if(replyUrl&&exportUrl(replyUrl).href!==url.href)fail('GOOGLE_BROWSER_READ_FAILED');
    const code=reply.status(),headers=reply.headers(),header=name=>Object.entries(headers).find(([key])=>key.toLowerCase()===name)?.[1];
    if([301,302,303,307,308].includes(code)){
     if(redirects===5||!header('location'))fail('GOOGLE_BROWSER_READ_FAILED');
     url=exportUrl(header('location'),url);continue;
    }
    if(code===401)fail('GOOGLE_BROWSER_AUTH_REQUIRED');
    if(code===403||code===404)fail('GOOGLE_BROWSER_ACCESS_DENIED');
    if(code<200||code>=300)fail('GOOGLE_BROWSER_READ_FAILED');
    if(/(?:text\/html|application\/xhtml\+xml)/i.test(header('content-type')||''))fail('GOOGLE_BROWSER_AUTH_REQUIRED');
    const length=header('content-length');if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>MAX_BYTES))fail('GOOGLE_BROWSER_LIMIT');
    const buffer=await reply.body();assertCurrent(epoch);
    if(!Buffer.isBuffer(buffer)||buffer.length>MAX_BYTES)fail('GOOGLE_BROWSER_LIMIT');
    if(/^\s*(?:\ufeff)?\s*<(?:!doctype\s+html|html\b|head\b|body\b|form\b|script\b)/i.test(buffer.subarray(0,512).toString('utf8')))fail('GOOGLE_BROWSER_AUTH_REQUIRED');
    return parseCsv(buffer);
   }finally{if(reply?.dispose)await reply.dispose().catch(()=>{});}
  }
  fail('GOOGLE_BROWSER_READ_FAILED');
 }
 async function rowsFor(reference){
  const epoch=version,key=reference.spreadsheetId+':'+reference.sheetId;
  assertCurrent(epoch);
  if(cache?.key===key&&clock()-cache.at>=0&&clock()-cache.at<CACHE_MS)return cache.rows;
  if(pending.has(key))return pending.get(key);
  const job=(async()=>{
   try{
    const rows=await download(reference,epoch);assertCurrent(epoch);
    cache={key,at:clock(),rows};phase='connected';lastError=null;return rows;
   }catch(value){const safe=epoch!==version?error('GOOGLE_BROWSER_REQUIRED'):safeError(value);recordFailure(safe,epoch);throw safe;}
  })();
  pending.set(key,job);
  try{return await job;}finally{if(pending.get(key)===job)pending.delete(key);}
 }
 async function monitor(epoch){
  if(epoch!==version||!session)return;
  if(!pageReady())recordFailure(error('GOOGLE_BROWSER_AUTH_REQUIRED'),epoch);
  else try{await rowsFor(target);}catch{}
  if(epoch===version&&session&&available()){timer=setTimeout(()=>{timer=null;void monitor(epoch);},PROBE_MS);timer.unref?.();}
 }
 async function stop(clearCookies=false){
  ++version;clearTimer();pending.clear();cache=null;
  const starting=opening;launchAbort?.abort();launchAbort=null;
  const previous=session;session=null;target=null;phase='idle';lastError=null;
  let cookiesFailed=false;
  if(previous){
   try{if(clearCookies)await previous.context.clearCookies();}catch{cookiesFailed=true;}
   try{await previous.context.request.dispose?.({reason:'PagePoster Google browser session closed'});}catch{}
   await previous.close().catch(()=>{});
  }
  if(starting)await starting.promise.catch(()=>{});
  if(cookiesFailed){phase='error';lastError='GOOGLE_BROWSER_UNAVAILABLE';throw error(lastError);}
  return status();
 }
 async function connect(spreadsheetUrl){
  const next=sheetReference(spreadsheetUrl);
  while(opening){if(opening.url===next.spreadsheetUrl)return opening.promise;await opening.promise.catch(()=>{});}
  if(target?.spreadsheetUrl===next.spreadsheetUrl&&available()){await session.page?.bringToFront?.().catch(()=>{});return status();}
  const closing=stop(),epoch=version,controller=new AbortController();launchAbort=controller;
  const job=(async()=>{
   await closing;if(epoch!==version)return status();target=next;phase='waiting';
   try{
    const opened=asSession(await launch({profileDir,spreadsheetUrl:next.spreadsheetUrl,signal:controller.signal}));
    if(epoch!==version){await opened.close().catch(()=>{});return status();}
    session=opened;void monitor(epoch);return status();
   }catch{if(epoch!==version)return status();phase='error';lastError='GOOGLE_BROWSER_UNAVAILABLE';throw error(lastError);}
   finally{if(launchAbort===controller)launchAbort=null;}
  })();
  opening={url:next.spreadsheetUrl,promise:job};
  try{return await job;}finally{if(opening?.promise===job)opening=null;}
 }
 async function readSheet(config){
  if(!session)fail('GOOGLE_BROWSER_REQUIRED');
  if(!config||typeof config!=='object')fail('GOOGLE_BROWSER_READ_FAILED');
  const reference=sheetReference(config.spreadsheetUrl||target.spreadsheetUrl);
  if(config.spreadsheetId!==reference.spreadsheetId||reference.spreadsheetId!==target.spreadsheetId||config.sheetId!==undefined&&config.sheetId!==null&&config.sheetId!==reference.sheetId)fail('GOOGLE_BROWSER_READ_FAILED');
  const bounds=rangeBounds(config.range),rows=await rowsFor(reference);
  const metrics=Object.entries(config.columns||{}).filter(([kind])=>kind==='dr'||kind==='traffic').map(([kind,name])=>({kind,index:column(name)-bounds.firstColumn}));
  const values=rows.slice(bounds.firstRow-1,bounds.lastRow??rows.length).map(row=>{
   const sliced=row.slice(bounds.firstColumn,bounds.lastColumn+1);
   for(const {kind,index}of metrics)if(index>=0&&index<sliced.length)sliced[index]=normalizedMetric(sliced[index],kind);
   return sliced;
  });
  return {values};
 }
 return {status,connect,readSheet,disconnect:()=>stop(true),close:()=>stop()};
}
