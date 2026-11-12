import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setMaxListeners} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
import {findBrowserExecutable} from './browser-executable.cjs';
import {createBrowserAssetCache} from './browser-assets.mjs';
import {readNativeDraftId} from './native-editor-draft.mjs';
import {createBrowserRequestQueue} from './browser-requests.mjs';
import {retryBrowserAssetRead,isBrowserStaticRead} from './browser-asset-read.mjs';
import {attachBrowserStaticRouting} from './browser-static-routing.mjs';
import {canonicalLoginBase,redirectedLoginBase} from './wordpress-canonical-login.mjs';
import {isWordPressPermissionDenial} from './wordpress-permission.mjs';
import {emitNativeObservation,observeNativePhase} from './native-telemetry.mjs';

const require=createRequire(import.meta.url);
const cleaner='pageposter-clean-links/pageposter-clean-links.php';
const cleanerName='pageposter-clean-links-1.1.3.zip';
const cleanerHash='a9547a104a65a7dd8abc6331220ea22ce8fd7604441d357f212552d8ee736b59';
const fail=(code,uncertain=false)=>{throw Object.assign(Error(code),{code,uncertain,state:uncertain?'uncertain':'needs_attention'});};
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const plain=value=>String(value||'').replace(/\r\n/g,'\n');
const sameContent=(actual,expected)=>plain(actual)===plain(expected)||plain(actual)==='<!-- wp:html -->\n'+plain(expected)+'\n<!-- /wp:html -->';
function runtime(){for(const name of ['playwright','playwright-core',path.resolve(path.dirname(process.execPath),'..','node_modules/playwright'),path.resolve(path.dirname(process.execPath),'..','node_modules/playwright-core')])try{return require(name).chromium;}catch{}return null;}
function executable(chromium){return findBrowserExecutable({chromium});}
const getHeader=(reply,name)=>Object.entries(reply.headers||{}).find(([key])=>key.toLowerCase()===name)?.[1];
const manualInstructions={BROWSER_CAPTCHA_REQUIRED:'PagePoster · Пройдіть CAPTCHA вручну в цьому приватному вікні. Потім натисніть «Продовжити» у PagePoster. Сторінку збережено.',BROWSER_LOGIN_REQUIRED:'PagePoster · Завершіть додатковий вхід або введіть код підтвердження вручну в цьому приватному вікні. Потім натисніть «Продовжити» у PagePoster.'};
const cloudflarePath=path=>/^\/cdn-cgi\/challenge-platform\/[A-Za-z0-9/_.:-]{1,990}$/.test(path);
// Evaluate only DOM state. A populated provider response means the human has
// completed that widget; WordPress/provider still validates it on submission.
function challengeState(){
 const visible=node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return !node.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;};
 const otp=[...document.querySelectorAll('input[name*=otp i],input[name*=two_factor i],input[autocomplete="one-time-code"],input[name=authcode],input[name=verification_code]')].some(visible);
 if(otp)return 'login';
 const responses=[...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"],#g-recaptcha-response')];
 const solved=responses.some(node=>typeof node.value==='string'&&node.value.trim().length>0);
 const widget=[...document.querySelectorAll('.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*="/recaptcha/"],iframe[src*="hcaptcha.com"],iframe[src*="challenges.cloudflare.com"],#challenge-form,#cf-challenge-running,form[action*="challenge"]')].some(node=>{
  // A provider's attribution badge is not a challenge. The actual popup frame
  // is separate and remains visible to this check when human action is needed.
  if(node.closest('.grecaptcha-badge')||node.matches('.g-recaptcha[data-size="invisible"],.h-captcha[data-size="invisible"]'))return false;
  try{if(node.localName==='iframe'){const url=new URL(node.src,location.href);if(url.pathname.endsWith('/anchor')&&url.searchParams.get('size')==='invisible')return false;}}catch{}
  return visible(node);
 });
 return widget&&!solved?'captcha':null;
}
function captchaEndpoint(url,method){
 if(url.protocol!=='https:'||url.port)return false;
 const host=url.hostname,path=url.pathname;
 if(['www.google.com','www.recaptcha.net','recaptcha.google.com'].includes(host))return method==='GET'?/^\/recaptcha\/(?:api\.js|enterprise\.js|(?:api2|enterprise)\/(?:anchor|bframe|webworker\.js|payload))$/.test(path):method==='POST'&&/^\/recaptcha\/(?:api2|enterprise)\/(?:reload|userverify|replaceimage|clrc)$/.test(path);
 if(host==='www.gstatic.com')return method==='GET'&&path.startsWith('/recaptcha/releases/');
 // hCaptcha documents regional/variable asset subdomains. Keep their vendor
 // boundary, the shared DNS-pinned transport and session budgets; writes stay
 // restricted to the widget protocol and the existing manual-challenge state.
 if(host==='hcaptcha.com'||host.endsWith('.hcaptcha.com'))return method==='GET'||method==='POST'&&/^\/(?:checksiteconfig|(?:getcaptcha|checkcaptcha)\/[a-zA-Z0-9-]{1,100})$/.test(path);
 return host==='challenges.cloudflare.com'&&['GET','POST'].includes(method)&&(/^\/turnstile\/[A-Za-z0-9/_.:-]{1,990}$/.test(path)||cloudflarePath(path));
}

// A real WordPress UI session. The only supplied plugin is Clean Links. No Bridge,
// application password, injected save handler or programmatic editor save is used.
// Requests still pass through the existing public-address/DNS-pinned transport.
export function createWordPressUI({chromium,executablePath,headless=false,transport=createSafeTransport({allowWrites:true,maxBytes:5*1024*1024}),sessionTransportFactory,manualEditor=false}={}){
 const sessions=new Map(),openings=new Map();let owner=null,sharedBrowser=null,browserMode=null,lifecycle=Promise.resolve(),closing=false;
 const serialize=action=>{const pending=lifecycle.then(action);lifecycle=pending.catch(()=>{});return pending;};
 async function open(id,baseUrl,options={}){
  if(closing)fail('BROWSER_CLOSED');
  if(openings.has(id)){const session=await openings.get(id);if(baseUrl)session.bind(baseUrl);return session;}
  const existing=sessions.get(id);if(existing){existing.assertOpen();if(baseUrl)existing.bind(baseUrl);return existing;}
  if(!manualEditor&&owner&&owner!==id&&!sessions.get(owner)?.finished)fail('BROWSER_BUSY');
  if(!manualEditor)owner=id;
  const pending=serialize(async()=>{
   if(closing)fail('BROWSER_CLOSED');
   if(!manualEditor)for(const [key,session]of sessions){if(key===id)continue;if(!session.finished)fail('BROWSER_BUSY');await session.close();sessions.delete(key);}
   return createSession(id,baseUrl,options);
  });openings.set(id,pending);
  try{return await pending;}catch(error){if(owner===id&&!sessions.has(id))owner=null;throw error;}finally{if(openings.get(id)===pending)openings.delete(id);}
 }
 async function createSession(id,baseUrl,options){
  if(chromium===undefined)chromium=runtime();if(executablePath===undefined)executablePath=executable(chromium);
  if(!chromium||!executablePath)fail('BROWSER_UNAVAILABLE');
  let base=baseUrl?validatePublicUrl(baseUrl):null,requestedBase=base?.href||null,canonicalLogin=null,loginSubmitted=false,pathChanged=false;const loginSteps=[],requestedMode=options.headless??headless;
  if(sharedBrowser&&(!sharedBrowser.isConnected()||browserMode!==requestedMode)){await sharedBrowser.close().catch(()=>{});sharedBrowser=null;}
  if(!sharedBrowser){try{sharedBrowser=await chromium.launch({executablePath,headless:requestedMode,timeout:20000,args:['--incognito','--no-first-run','--disable-background-networking','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});browserMode=requestedMode;}catch{fail('BROWSER_UNAVAILABLE');}}
  const browser=sharedBrowser;if(closing){await browser.close().catch(()=>{});fail('BROWSER_CLOSED');}
  const context=await browser.newContext({viewport:requestedMode?{width:1280,height:900}:null,serviceWorkers:'block',acceptDownloads:false});
  let networkSession=null,staticRouting=null,cleanupPromise=null,cleanup=async()=>{await context.close().catch(()=>{});await staticRouting?.close();await networkSession?.close();};
  try{
  if(sessionTransportFactory){networkSession=await sessionTransportFactory({id,baseUrl:base?.href||null,...(manualEditor?{binding:options.binding}:{})});if(typeof networkSession?.transport!=='function'||typeof networkSession?.close!=='function')fail('PROXY_ADAPTER_INVALID');}
  await context.addInitScript(()=>Object.defineProperty(window,'open',{value:()=>null,writable:false,configurable:false}));
  const networkController=()=>{const value=new AbortController();setMaxListeners(1024,value.signal);return value;};
  const page=await context.newPage(),assets=createBrowserAssetCache(),queuedRequest=createBrowserRequestQueue(networkSession?networkSession.transport:transport);let operationObserve=options.observe,checkingCleanLinks=false;
  const request=async(url,init,urgent,beforeStart,requestClass='browser',actualSend=false)=>{
   const observe=operationObserve,enqueued=performance.now();let dequeued=null,started=null,httpStatus=null,error;
   try{return await queuedRequest(url,init,urgent,()=>{dequeued=performance.now();beforeStart?.();started=performance.now();if(actualSend)emitNativeObservation(observe,{kind:'phase',phase:'send',state:'start',at:Date.now()});}).then(reply=>{httpStatus=reply.status;return reply;});}
   catch(caught){error=caught;throw caught;}
   finally{const ended=performance.now(),networkMs=started===null?null:Math.round(ended-started),queueMs=Math.round((dequeued??ended)-enqueued);emitNativeObservation(observe,{kind:'network',networkMs,queueMs,httpStatus,method:init.method,requestClass});if(actualSend&&started!==null)emitNativeObservation(observe,{kind:'phase',phase:'send',state:'end',at:Date.now(),elapsedMs:networkMs,httpStatus,method:init.method,requestClass,checkpoint:'dispatching',code:error?'UNKNOWN':httpStatus>=400?'network_failed':'OK'});}
  };
  page.setDefaultTimeout(20000);let closed=false,mode='read',manualChallenge=null,captchaRequests=0,captchaBytes=0,armedUrl=null,expected=null,dispatch=null,dispatchError=null,authenticated=false,navigationError=null,navigationStatus=null,redirects=0,draftCheckpoint=null,pendingDraftId=null,pendingCreation=false,accountEpoch=0,switchingAccount=false,cookieWork=Promise.resolve(),accountController=networkController();
  context.on('page',other=>{if(other!==page)void other.close().catch(()=>{});});
  page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
  const disconnected=()=>{closed=true;accountController.abort();void cleanup().catch(()=>{}).then(()=>{if(manualEditor&&sessions.get(id)?.page===page)sessions.delete(id);});};page.on('close',disconnected);browser.on('disconnected',disconnected);
  cleanup=()=>cleanupPromise||(cleanupPromise=(async()=>{closed=true;accountEpoch++;accountController.abort();assets.clear();draftCheckpoint=null;page.off('close',disconnected);browser.off('disconnected',disconnected);await context.close().catch(()=>{});await staticRouting?.close();await networkSession?.close();})());
  const assertOpen=()=>{if(closed||page.isClosed()||!browser.isConnected())fail('BROWSER_CLOSED');};
  const same=value=>{if(!base)fail('BROWSER_SITE_REQUIRED');const url=validatePublicUrl(value);if(url.origin!==base.origin)fail('BROWSER_ORIGIN_BLOCKED');return url;};
  const address=value=>new URL(value,base).href;
  const currentAccount=epoch=>!closed&&epoch===accountEpoch;
  async function cookies(reply,url,epoch){
   const pending=cookieWork.then(async()=>{if(!currentAccount(epoch))return;const raw=getHeader(reply,'set-cookie');for(const value of raw?(Array.isArray(raw)?raw:[raw]):[]){if(!currentAccount(epoch))return;const parts=value.split(';'),pair=parts.shift(),i=pair.indexOf('=');if(i<1)continue;const attrs=new Map(parts.map(p=>{const i=p.indexOf('=');return i<0?[p.trim().toLowerCase(),'']:[p.slice(0,i).trim().toLowerCase(),p.slice(i+1).trim()];}));const domain=(attrs.get('domain')||url.hostname).replace(/^\./,'').toLowerCase();if(domain!==url.hostname&&!url.hostname.endsWith('.'+domain))continue;const expires=attrs.has('max-age')?Math.floor(Date.now()/1000)+Number(attrs.get('max-age')):attrs.has('expires')?Math.floor(Date.parse(attrs.get('expires'))/1000):undefined;await context.addCookies([{name:pair.slice(0,i).trim(),value:pair.slice(i+1).trim(),domain:url.hostname,path:attrs.get('path')||'/',secure:true,httpOnly:attrs.has('httponly'),...(Number.isFinite(expires)?{expires:Math.max(1,expires)}:{})}]);}});
   cookieWork=pending.catch(()=>{});await pending;
  }
  async function adoptLoginBase(target,{kind='form',from=page.url()}={}){
   const canonical=base&&(kind==='redirect'?redirectedLoginBase(base.href,from,target):canonicalLoginBase(base.href,target));
   if(!canonical||kind!=='redirect'&&canonicalLogin||loginSteps.length>=8||authenticated||loginSubmitted||expected||pendingDraftId||pendingCreation||dispatch?.sent)fail('BROWSER_ORIGIN_BLOCKED');
   switchingAccount=true;accountEpoch++;accountController.abort();assets.clear();
   try{await cookieWork;await context.clearCookies();pathChanged||=new URL(canonical).pathname!==base.pathname;loginSteps.push({kind,from,to:target});base=new URL(canonical);accountController=networkController();canonicalLogin={requestedBaseUrl:requestedBase,baseUrl:base.href};}
   finally{switchingAccount=false;}
  }
   const updateOperations=new Map();let updateTarget=null,updateBaseline=null;
   const methodOverride=url=>[...url.searchParams.keys()].some(key=>['_method','_http_method','http_method'].includes(key.toLowerCase()));
   function updateRestRoute(url){
    const root=new URL('wp-json/',base).pathname,front=[base.pathname,new URL('index.php',base).pathname].includes(url.pathname);
    if(url.pathname.startsWith(root)&&!url.searchParams.has('rest_route'))return url.pathname.slice(root.length-1);
    if(front&&url.searchParams.getAll('rest_route').length===1)return url.searchParams.get('rest_route');
    return null;
   }
   function safePageRest(url,read=false){
    if(updateRestRoute(url)!=='/wp/v2/pages/'+expected?.postId)return false;
    const keys=[...url.searchParams.keys()];return new Set(keys).size===keys.length&&keys.every(key=>key==='rest_route'||key==='_locale'&&url.searchParams.get(key)==='user'||read&&(key==='context'&&['edit','view'].includes(url.searchParams.get(key))||['_fields','_embed'].includes(key)));
   }
   function manualEditorWrite(url,method,headers,body,req){
    if(mode!=='manual-editor'||!body||req.frame()!==page.mainFrame())return false;
    if(safePageRest(url)&&['POST','PUT'].includes(method)&&/^application\/json(?:\s*;|$)/i.test(headers['content-type']||'')){
     try{const fields=JSON.parse(body.toString());return fields&&typeof fields==='object'&&!Array.isArray(fields)&&(!Object.hasOwn(fields,'id')||fields.id===expected.postId);}
     catch{return false;}
    }
    if(method!=='POST'||url.href!==address('wp-admin/post.php')||!req.isNavigationRequest()||!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(headers['content-type']||''))return false;
    const form=new URLSearchParams(body.toString());
    return ['action','post_ID','post_type','_wpnonce'].every(key=>form.getAll(key).length===1)&&form.get('action')==='editpost'&&form.get('post_ID')===String(expected.postId)&&form.get('post_type')==='page'&&!!form.get('_wpnonce');
   }
   function sameClassicUpdate(body){
    if(!updateBaseline)return false;
    const entries=[...new URLSearchParams(body.toString())],wanted=updateBaseline.entries.map(([key,value])=>[key,key==='content'?expected.html:value]);
    if(updateBaseline.button)wanted.push(updateBaseline.button);
    if(entries.length!==wanted.length)return false;
    // FormData preserves repeated successful controls. Compare the complete
    // multimap so an appended identity/slug or a changed hidden field cannot
    // become an unreviewed WordPress mutation.
    const remaining=wanted.map(([key,value])=>[key,plain(value)]);
    return entries.every(([key,value])=>{const index=remaining.findIndex(([name,want])=>name===key&&want===plain(value));if(index<0)return false;remaining.splice(index,1);return true;});
   }
   function readAllowed(url,req){
    if(methodOverride(url))return false;
    if(mode==='trash'||mode==='inspect'||mode==='update'||mode==='manual-editor'||updateTarget&&mode==='read'){
    const suffix=url.pathname.slice(base.pathname.length),action=url.searchParams.get('action');
    if(url.searchParams.has('action2'))return false;
    if(action){
     if(action==='trash')return req?.isNavigationRequest()&&req.frame?.()===page.mainFrame()&&!!coreTrashUrl(url.href,'trash')&&(mode==='manual-editor'||url.href===armedUrl&&dispatch?.operation==='trash'&&!dispatch.reserved);
      return action==='edit'&&suffix==='wp-admin/post.php'&&url.searchParams.get('post')===String(updateTarget?.postId||expected?.postId)&&[...url.searchParams.keys()].every(key=>['post','action','message'].includes(key));
    }
    if([...url.searchParams.keys()].some(key=>['_wpnonce','_ajax_nonce','delete_all','delete_all2','delete','force','doaction','doaction2','bulk_edit','bulk_edit2'].includes(key)))return false;
     if(updateTarget&&url.searchParams.has('rest_route')&&!updateRestRoute(url))return false;
    if(suffix==='wp-admin/edit.php')return url.searchParams.get('post_type')==='page'&&[...url.searchParams.keys()].every(key=>['post_type','post_status','s','trashed','ids','message','paged'].includes(key));
    if(suffix.startsWith('wp-admin/'))return ['wp-admin/','wp-admin/index.php','wp-admin/load-scripts.php','wp-admin/load-styles.php'].includes(suffix);
    if(suffix==='wp-login.php')return !url.search;
     if(suffix.startsWith('wp-json/')||url.searchParams.has('rest_route')){
      const route=updateTarget?updateRestRoute(url):url.searchParams.get('rest_route')||'/'+suffix.slice('wp-json/'.length);
      if(!/^\/wp\/v2\//.test(route||''))return false;
      if(updateTarget&&(url.searchParams.has('id')||/^\/wp\/v2\/pages(?:\/|$)/.test(route)&&!safePageRest(url,true)))return false;
      return true;
     }
     if(updateTarget&&url.href===updateTarget.url&&req?.isNavigationRequest())return true;
    return !req?.isNavigationRequest()&&/^(?:wp-includes|wp-content)\//.test(suffix)&&!/(?:^|\/)\w+\.php(?:\/|$)/i.test(suffix);
   }
   if(url.href===armedUrl)return true;
   const suffix=url.pathname.slice(base.pathname.length),action=url.searchParams.get('action');
   if(url.searchParams.has('action2'))return false;
   if(action&&!(suffix==='wp-admin/post.php'&&action==='edit'&&Number(url.searchParams.get('post'))===expected?.postId)&&!(suffix==='wp-login.php'&&action==='confirm_admin_email'))return false;
   if(req?.isNavigationRequest())return !action&&(!suffix.startsWith('wp-admin/')||['wp-admin/','wp-admin/index.php','wp-admin/plugins.php','wp-admin/plugin-install.php','wp-admin/edit.php'].includes(suffix))||suffix==='wp-admin/post.php'&&action==='edit'&&Number(url.searchParams.get('post'))===expected?.postId||suffix==='wp-login.php'&&action==='confirm_admin_email';
   return !action;
  }
  const handleRoute=async route=>{
   const epoch=accountEpoch,signal=accountController.signal,req=route.request();if(switchingAccount||closed)return route.abort().catch(()=>{});let url;try{url=validatePublicUrl(req.url());}catch{return route.abort();}
   if(base&&url.origin!==base.origin){
    const method=req.method();if(!captchaEndpoint(url,method)||++captchaRequests>128)return route.abort();
    if(method==='POST'&&manualChallenge!=='captcha'){try{if(await page.evaluate(challengeState)==='captcha')manualChallenge='captcha';}catch{}if(manualChallenge!=='captcha')return route.abort();}
    try{
     const headers=await req.allHeaders();for(const name of ['host','content-length','accept-encoding','connection','authorization','proxy-authorization','referer'])delete headers[name];headers.referer=base.origin+'/';
     const body=req.postDataBuffer();if(body&&body.length>128*1024)return route.abort();
     if(!currentAccount(epoch))return route.abort().catch(()=>{});const reply=await request(url.href,{method,headers,...(method==='POST'?{body:body||Buffer.alloc(0)}:{}),followRedirects:false,signal},req.isNavigationRequest()||method!=='GET');if(!currentAccount(epoch))return route.abort().catch(()=>{});
     const bytes=reply.body||Buffer.from(reply.text||'');captchaBytes+=bytes.length;if(captchaBytes>20*1024*1024||reply.status>=300&&reply.status<400||reply.url&&new URL(reply.url).origin!==url.origin)return route.abort();
     await cookies(reply,url,epoch);if(!currentAccount(epoch))return route.abort().catch(()=>{});const clean={};for(const [key,value]of Object.entries(reply.headers||{}))if(!['set-cookie','content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase()))clean[key]=Array.isArray(value)?value.join(', '):String(value);
     return route.fulfill({status:reply.status,headers:clean,body:bytes});
    }catch{return route.abort().catch(()=>{});}
   }
   try{url=same(req.url());}catch{return route.abort();}
    let method=req.method(),body=req.postDataBuffer(),headers=await req.allHeaders(),isPublish=false,manualVerification=false;
    const overrideHeaders=Object.keys(headers).filter(key=>['x-http-method-override','x-http-method','x-method-override'].includes(key));
    const updating=mode==='update'&&dispatch?.operation==='update';
    const editorWrite=dispatch&&!dispatch.reserved&&expected&&(updating||mode==='publish'&&!updateTarget);
    const updateEndpoint=updating&&editorWrite&&(
     url.pathname===new URL('wp-admin/post.php',base).pathname||
     url.pathname===new URL('wp-json/wp/v2/pages/'+expected.postId,base).pathname||
     updateRestRoute(url)==='/wp/v2/pages/'+expected.postId);
    const jsonBody=/^application\/json(?:\s*;|$)/i.test(headers['content-type']||'');
    // Core apiFetch wraps Gutenberg's PUT as POST. The exact page endpoint
    // and the same payload guard apply to either form, before dispatch.
    const manualWrite=method!=='GET'&&manualEditorWrite(url,method,headers,body,req);
    const nativePut=(editorWrite||manualWrite)&&method==='POST'&&jsonBody&&safePageRest(url)&&overrideHeaders.length===1&&headers['x-http-method-override']?.toUpperCase()==='PUT';
    if(methodOverride(url)||overrideHeaders.length&&!nativePut){if(updateEndpoint&&method!=='GET')dispatchError=Object.assign(Error('NATIVE_CONTENT_CHANGED'),{code:'NATIVE_CONTENT_CHANGED'});return route.abort();}
   const isTrash=method==='GET'&&mode==='trash'&&dispatch?.operation==='trash'&&!dispatch.reserved&&url.href===armedUrl&&req.isNavigationRequest()&&req.frame()===page.mainFrame()&&!!coreTrashUrl(url.href,'trash');
   delete headers.host;delete headers['content-length'];delete headers['accept-encoding'];delete headers.connection;
   if(method==='GET'){if(!readAllowed(url,req))return route.abort();}
   else {
    manualVerification=manualChallenge==='captcha'&&method==='POST'&&cloudflarePath(url.pathname);
    if(manualVerification&&(++captchaRequests>128||body&&body.length>128*1024))return route.abort();
    const login=(mode==='login'||manualChallenge)&&method==='POST'&&url.pathname===new URL('wp-login.php',base).pathname;
    const upload=mode==='upload'&&method==='POST'&&url.href===armedUrl;
     if(editorWrite){
     let fields;try{fields=/json/i.test(headers['content-type']||'')?JSON.parse(body.toString()):Object.fromEntries(new URLSearchParams(body.toString()));}catch{}
      const classic=method==='POST'&&url.pathname===new URL('wp-admin/post.php',base).pathname&&(!updating||!url.search)&&fields?.action==='editpost'&&Number(fields.post_ID)===expected.postId&&fields.post_type==='page'&&(Object.hasOwn(fields,'publish')||updating&&Object.hasOwn(fields,'save'));
      const block=jsonBody&&['POST','PUT'].includes(method)&&updateRestRoute(url)==='/wp/v2/pages/'+expected.postId&&fields&&typeof fields==='object'&&!Array.isArray(fields)&&(updating||fields.status==='publish');
       if(classic||block){const title=classic?fields.post_title:updating&&!Object.hasOwn(fields,'title')?expected.title:fields.title,html=fields.content;
        // Gutenberg sends edited attributes only. Omitted title/status retain
        // the freshly verified immutable title and published status; an
        // explicitly supplied value still has to match the reviewed snapshot.
        const guardedIdentity=!block||safePageRest(url)&&(!Object.hasOwn(fields,'id')||fields.id===expected.postId);
        const guardedUpdate=!updating||(classic?sameClassicUpdate(body)&&(fields.post_status===undefined||fields.post_status==='publish'):Object.hasOwn(fields,'content')&&Object.keys(fields).every(key=>['id','title','content','status'].includes(key))&&(!Object.hasOwn(fields,'status')||fields.status==='publish'));
       if(expected.slug){
        const slugs=classic?new URLSearchParams(body.toString()).getAll('post_name'):[fields.slug];
        if(slugs.length!==1||slugs[0]!==expected.slug){dispatchError=Object.assign(Error('NATIVE_SLUG_MISMATCH'),{code:'NATIVE_SLUG_MISMATCH'});return route.abort();}
       }
       if(plain(title)!==plain(expected.title)||!sameContent(html,expected.html)||!guardedIdentity||!guardedUpdate){dispatchError=Object.assign(Error('NATIVE_CONTENT_CHANGED'),{code:'NATIVE_CONTENT_CHANGED'});return route.abort();}isPublish=true;}
    }
     if(!login&&!upload&&!isPublish&&!manualVerification&&!manualWrite){if(updateEndpoint)dispatchError=Object.assign(Error('NATIVE_CONTENT_CHANGED'),{code:'NATIVE_CONTENT_CHANGED'});return route.abort();}
   }
   // Capture this operation before awaiting the response. Navigation can time
   // out while WordPress has already created the auto-draft remotely.
   const createCheckpoint=draftCheckpoint&&method==='GET'&&req.isNavigationRequest()&&req.frame()===page.mainFrame()&&url.href===armedUrl&&url.pathname===new URL('wp-admin/post-new.php',base).pathname&&url.searchParams.get('post_type')==='page'?draftCheckpoint:null;
   try{
    if(!currentAccount(epoch))return route.abort().catch(()=>{});
    if(createCheckpoint){await createCheckpoint({postId:null,phase:'creating'});pendingCreation=true;}
     if(isPublish||isTrash){dispatch.reserved=true;await dispatch.checkpoint({postId:expected.postId,phase:'dispatching'});}
    // WordPress supports the normal REST method override for browser PUT requests;
    // the shared transport deliberately permits only GET/POST at its boundary.
    if(method==='PUT'){headers['x-http-method-override']='PUT';method='POST';}
    const resourceType=req.resourceType(),cached=assets.get(url.href,resourceType,method);
    const requestClass=isPublish||isTrash?'publication':mode==='login'?'authentication':mode==='upload'?'plugin':req.isNavigationRequest()?'editor_read':'browser';
    let reply=cached||await retryBrowserAssetRead(()=>request(url.href,{method,headers,...(method==='POST'?{body:body||Buffer.alloc(0)}:{}),followRedirects:false,signal},req.isNavigationRequest()||method!=='GET',isPublish||isTrash?()=>{dispatch.beforeSend();assertOpen();dispatch.sent=true;}:undefined,requestClass,isPublish||isTrash),{url:url.href,baseUrl:base.href,method,resourceType,signal});
    if(!currentAccount(epoch))return route.abort().catch(()=>{});
    if(!cached)assets.put(url.href,resourceType,method,reply);
    if(manualVerification){captchaBytes+=(reply.body||Buffer.from(reply.text||'')).length;if(captchaBytes>20*1024*1024)return route.abort();}
    await cookies(reply,url,epoch);if(!currentAccount(epoch))return route.abort().catch(()=>{});
    // The static Fetch interceptor pauses each browser redirect before any
    // socket opens. Return real redirects only there: exact final bytes and
    // the final URL must both survive for relative CSS and module imports.
    if(method==='GET'&&!req.isNavigationRequest()&&[301,302,303,307,308].includes(reply.status)){
     if(!route.staticResource||!isBrowserStaticRead({url:url.href,baseUrl:base.href,method,resourceType}))fail('BROWSER_ASSET_REDIRECT_BLOCKED');
     const location=getHeader(reply,'location');if(typeof location!=='string'||!location||/[\u0000-\u0020\u007f\\]/.test(location))fail('BROWSER_ASSET_REDIRECT_INVALID');
     const next=same(new URL(location,url).href);
     if(!readAllowed(next,req)||!isBrowserStaticRead({url:next.href,baseUrl:base.href,method,resourceType}))fail('BROWSER_ASSET_REDIRECT_BLOCKED');
     route.redirect(next.href);
     const clean={};for(const [key,value]of Object.entries(reply.headers||{}))if(!['set-cookie','content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase()))clean[key]=Array.isArray(value)?value.join(', '):String(value);
     return await route.fulfill({status:reply.status,headers:clean,body:reply.body||Buffer.from(reply.text||'')});
    }
    if(req.isNavigationRequest()&&req.frame()===page.mainFrame())navigationStatus=reply.status;
    if(createCheckpoint&&reply.status===200&&/text\/html/i.test(getHeader(reply,'content-type')||'')){
     const id=readNativeDraftId(reply.text??reply.body?.toString('utf8')??'');if(id){if(pendingDraftId&&pendingDraftId!==id)fail('NATIVE_RESULT_UNCERTAIN',true);pendingDraftId=id;await createCheckpoint({postId:id,phase:'draft'});pendingCreation=false;}
    }
    if([301,302,303,307,308].includes(reply.status)){
     const target=validatePublicUrl(new URL(getHeader(reply,'location'),url).href);
     if(method==='GET'&&req.isNavigationRequest()&&req.frame()===page.mainFrame()&&url.pathname===new URL('wp-login.php',base).pathname&&(target.origin!==base.origin||target.pathname.endsWith('/wp-login.php')&&target.pathname!==url.pathname))await adoptLoginBase(target.href,{kind:'redirect',from:url.href});
     const next=same(target.href);if(!readAllowed(next,{isNavigationRequest:()=>true})||[307,308].includes(reply.status)&&method!=='GET')fail('BROWSER_ORIGIN_BLOCKED');
     if(req.isNavigationRequest()&&++redirects>8)fail('BROWSER_PAGE_UNAVAILABLE');
     // Chromium can follow fulfilled HTTP redirects outside route interception.
     // A zero-delay refresh keeps every request guarded, without a synthetic UI.
     await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta data-pp-redirect http-equiv="refresh" content="0;url='+escape(next.href)+'">'});
    }else{const clean={};for(const [key,value]of Object.entries(reply.headers||{}))if(!['set-cookie','content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase()))clean[key]=Array.isArray(value)?value.join(', '):String(value);await route.fulfill({status:reply.status,headers:clean,body:reply.body||Buffer.from(reply.text||'')});}
    if(isPublish||isTrash)dispatch.finished=true;
   }catch(error){if(!currentAccount(epoch))return route.abort().catch(()=>{});if(createCheckpoint&&pendingCreation&&!pendingDraftId&&error.requestNotStarted===true){try{await createCheckpoint({postId:null,phase:'not_started',requestNotStarted:true});pendingCreation=false;authenticated=false;}catch(rollbackError){error=rollbackError;}}if(req.isNavigationRequest()&&req.frame()===page.mainFrame())navigationError=error;if(isPublish||isTrash){dispatchError=error;await route.fulfill({status:502,contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><h1>Ответ WordPress не подтверждён</h1><p>Готовый HTML сохранён. Продолжите запуск в PagePoster: сначала будет проверена уже созданная страница.</p>'}).catch(()=>{});}else await route.abort().catch(()=>{});}
  };
  await context.route('**/*',handleRoute);
  staticRouting=await attachBrowserStaticRouting({context,page,handle:handleRoute,epoch:()=>accountEpoch,isCurrent:currentAccount});
  if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
  // Progress and manual-action instructions belong in the desktop queue. Keep
  // the WordPress document untouched so controls and notices stay unobstructed.
  async function status(){assertOpen();}
  async function documentValue(predicate,argument){const until=Date.now()+20000;while(Date.now()<until){assertOpen();try{return await page.evaluate(predicate,argument);}catch(error){if(!/Execution context was destroyed|Cannot find context with specified id/.test(error.message||''))throw error;await new Promise(resolve=>setTimeout(resolve,100));}}fail('BROWSER_TIMEOUT');}
  async function waitForState(predicate,{timeoutMs=20000,code='BROWSER_TIMEOUT',argument}={}){const until=Date.now()+timeoutMs;while(Date.now()<until){assertOpen();await guard();if(navigationError)throw navigationError;const result=await documentValue(predicate,argument);if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}fail(code);}
  function loginScreen(){
   if(document.querySelector('meta[data-pp-redirect]'))return false;
   if(document.querySelector('#login_error'))return 'rejected';
   if(document.querySelector('.admin-email-confirm-form'))return 'confirmation';
   if(document.querySelector('#adminmenu,#wpadminbar,.wp-die-message,body#error-page'))return 'wordpress';
   if(document.readyState==='loading')return false;
   return document.querySelector('form#loginform')?'form':'unknown';
  }
  function adminDocumentReady(kind){
   if(document.querySelector('meta[data-pp-redirect]'))return false;
   if(document.querySelector('.wp-die-message,body#error-page')?.innerText?.trim()||document.querySelector('#loginform,.admin-email-confirm-form'))return true;
   if(kind==='login')return !!document.querySelector('#adminmenu,#wpadminbar');
   if(kind==='plugins'){
    const cleanerRow=document.querySelector('tr[data-plugin="pageposter-clean-links/pageposter-clean-links.php"]');
    if(/\b\d+(?:\.\d+){2,}(?:[-+][\w.-]+)?\b/.test(cleanerRow?.querySelector('.plugin-version-author-uri')?.textContent||''))return true;
    // A table can precede its rows while a notice script is still parsing.
    // Core's bottom navigation/no-items row, or completed parsing, proves that
    // an absent cleaner is really absent. A container alone is insufficient.
    return !!document.querySelector('.tablenav.bottom,#the-list .no-items')||document.readyState!=='loading'&&!!document.querySelector('tr[data-plugin],#the-list,table.plugins,.no-items');
   }
   return !!document.querySelector('input[type=file][name=pluginzip],input[name=hostname],input[name=connection_type]');
  }
  async function visit(url,allowHttpError=false,waitUntil='domcontentloaded'){
   assertOpen();await guard();armedUrl=same(url).href;navigationError=null;navigationStatus=null;redirects=0;
   const pathname=new URL(armedUrl).pathname,kind=pathname.endsWith('/wp-login.php')?'login':pathname.endsWith('/wp-admin/plugins.php')?'plugins':pathname.endsWith('/wp-admin/plugin-install.php')?'installer':null;
   try{const reply=await page.goto(armedUrl,{waitUntil:kind?'commit':waitUntil});
     if(kind){
      const status=navigationStatus??reply?.status()??200;
      if(status>=400&&!allowHttpError){
       if(kind==='login'&&[403,429,503].includes(status)){
        // A challenge is sometimes the error document itself. Inspect its DOM
        // before treating the status as an unavailable donor.
        await page.waitForLoadState('domcontentloaded',{timeout:1500}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
        await guard();
       }
       fail('BROWSER_PAGE_UNAVAILABLE');
      }
      await waitForState(adminDocumentReady,{argument:kind});
     }
    else if(waitUntil!=='commit')await waitForState(()=>document.readyState!=='loading'&&!document.querySelector('meta[data-pp-redirect]'));
    if(navigationError)throw navigationError;const status=navigationStatus??reply?.status()??200;
    if(!allowHttpError&&status>=400)fail('BROWSER_PAGE_UNAVAILABLE');return {status:()=>status};
   }catch(error){throw Object.assign(navigationError||error,{code:(navigationError||error).code||(error.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_PAGE_UNAVAILABLE'),...(Number.isInteger(navigationStatus)?{httpStatus:navigationStatus}:{})});}
  }
  async function guard(){manualChallenge=await documentValue(challengeState);if(manualChallenge){const code=manualChallenge==='captcha'?'BROWSER_CAPTCHA_REQUIRED':'BROWSER_LOGIN_REQUIRED';await status(manualInstructions[code]).catch(()=>{});fail(code);}if(checkingCleanLinks&&await page.locator('input[name=hostname],input[name=connection_type]').count())throw Object.assign(Error('CLEAN_LINKS_FILESYSTEM_REQUIRED'),{code:'CLEAN_LINKS_FILESYSTEM_REQUIRED',state:'needs_attention',beforePageCreation:true});}
  async function pluginScreen(url){
   const reply=await visit(url,true);await guard();
   const notices=page.locator('.wp-die-message'),notice=await notices.count()?notices:page.locator('body#error-page'),text=(await notice.allInnerTexts()).join(' ').trim();
   // wp_die is also used for fatal errors/nonces. Only a permission response is
   // evidence that this donor cannot install; core can return it with HTTP 500.
   const permission=isWordPressPermissionDenial(text);
   if(permission)throw Object.assign(Error('CLEAN_LINKS_INSTALL_FORBIDDEN'),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',state:'needs_attention',beforePageCreation:true,httpStatus:reply.status()});
   if(text||reply?.status()>=400)throw Object.assign(Error('BROWSER_PAGE_UNAVAILABLE'),{code:'BROWSER_PAGE_UNAVAILABLE',state:'needs_attention',httpStatus:reply.status()});
   if(await page.locator('#loginform').count())fail('BROWSER_LOGIN_REQUIRED');
  }
  async function clickAdminLink(selector,relative,{readFallback=false}={}){
   assertOpen();await guard();const target=same(address(relative)),links=page.locator(selector);let chosen;
   for(let i=0;i<await links.count();i++){
    const link=links.nth(i),value=await link.getAttribute('href');if(!value)continue;let candidate;try{candidate=new URL(value,page.url());}catch{continue;}
    if(candidate.pathname!==target.pathname||candidate.searchParams.get('post_type')!=='page')continue;
    same(candidate.href);if(candidate.href!==target.href||!await link.isVisible())continue;chosen=link;break;
   }
   if(!chosen){
    if(readFallback){await visit(target.href,false,'commit');return;}
    fail('NATIVE_NAVIGATION_UNAVAILABLE');
   }
   armedUrl=target.href;navigationError=null;navigationStatus=null;redirects=0;
   try{await Promise.all([page.waitForURL(target.href,{waitUntil:'commit'}),chosen.click({noWaitAfter:true})]);await guard();if(navigationError)throw navigationError;if(navigationStatus>=400)fail('BROWSER_PAGE_UNAVAILABLE');}
   catch(error){const failure=navigationError||error;if(!failure.code)failure.code=error.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_PAGE_UNAVAILABLE';throw failure;}
  }
  async function openNewPage(){
   const menu='#menu-pages > a[href],#adminmenu a[href]';
   // Custom dashboards may hide Pages. The list is safe to open directly;
   // the draft-creating navigation still requires its native Add New link.
   await clickAdminLink(menu,'wp-admin/edit.php?post_type=page',{readFallback:true});
   await waitForState(()=>!document.querySelector('meta[data-pp-redirect]')&&(!!document.querySelector('a.page-title-action[href],.wp-die-message,body#error-page,#loginform')||document.readyState!=='loading'&&!!document.querySelector('#posts-filter,#the-list,body.edit-php')));
   if(await page.locator('#loginform').count())fail('BROWSER_LOGIN_REQUIRED');if(await page.locator('.wp-die-message,body#error-page').count())fail('BROWSER_PAGE_UNAVAILABLE');
   await clickAdminLink('a.page-title-action[href]','wp-admin/post-new.php?post_type=page');
  }
  async function editorState(){
   await waitForState(()=>{if(document.querySelector('form#post #content'))return Number(document.querySelector('form#post [name=post_ID]')?.value)>0&&!!document.querySelector('#original_post_status,[name=original_post_status]')?.value;const editor=window.wp?.data?.select('core/editor');return Number(editor?.getCurrentPostId?.())>0&&typeof editor?.getCurrentPost?.()?.status==='string';},{timeoutMs:120000,code:'NATIVE_EDITOR_UNAVAILABLE'});
   if(await page.locator('form#post #content').count())return page.locator('form#post').evaluate(form=>({kind:'classic',postId:Number(form.querySelector('[name=post_ID]')?.value),title:form.querySelector('#title')?.value,content:form.querySelector('#content')?.value,status:document.querySelector('#original_post_status')?.value||document.querySelector('[name=original_post_status]')?.value,url:document.querySelector('#sample-permalink')?.href||document.querySelector('#wp-admin-bar-view a')?.href||''}));
   return page.evaluate(()=>{const s=wp.data.select('core/editor'),p=s.getCurrentPost();return {kind:'block',postId:Number(s.getCurrentPostId()),title:s.getEditedPostAttribute('title'),content:s.getEditedPostContent(),status:p.status,url:p.link||s.getPermalink?.()||''};});
  }
  async function inspect(input){return observeNativePhase(operationObserve,'reconcile',()=>inspectEditor(input));}
  async function inspectEditor({saved,title,html,slug,readMode='inspect'}){
   if(!Number.isSafeInteger(saved?.postId)||saved.postId<1)fail('NATIVE_RESULT_UNCERTAIN',true);
   expected={postId:saved.postId,title,html};mode=readMode;await visit(address('wp-admin/post.php?post='+saved.postId+'&action=edit'),false,'commit');
   const actual=await editorState();if(actual.postId!==saved.postId)fail('NATIVE_RESULT_UNCERTAIN',true);
   if(actual.status!=='publish'){if(['auto-draft','draft'].includes(actual.status))fail('NATIVE_NOT_PUBLISHED');fail('NATIVE_RESULT_UNCERTAIN',true);}
   if(plain(actual.title)!==plain(title)||!sameContent(actual.content,html))fail('NATIVE_CONTENT_CHANGED',true);
   const url=same(actual.url);if(url.pathname.startsWith(new URL('wp-admin/',base).pathname))fail('NATIVE_RESULT_UNCERTAIN',true);
   if(slug&&url.pathname.split('/').filter(Boolean).at(-1)!==slug)fail('NATIVE_SLUG_MISMATCH',true);
   return {postId:actual.postId,url:url.href,title:actual.title,content:html,status:'publish'};
  }
  function validateUpdate(input){
   const {saved,before,after,operationId,checkpoint,beforeSend}=input;
   if(typeof checkpoint!=='function'||typeof beforeSend!=='function')fail('NATIVE_CHECKPOINT_REQUIRED');
   if(typeof operationId!=='string'||!operationId||operationId.length>160||!Number.isSafeInteger(saved?.postId)||saved.postId<1||typeof saved.url!=='string')fail('NATIVE_UPDATE_CONFLICT');
   const url=same(saved.url);if(url.href!==saved.url||url.pathname.startsWith(new URL('wp-admin/',base).pathname))fail('NATIVE_UPDATE_CONFLICT');
   for(const value of [before,after])if(!value||value.postId!==saved.postId||value.url!==saved.url||value.status!=='publish'||typeof value.title!=='string'||typeof value.content!=='string')fail('NATIVE_UPDATE_CONFLICT');
   if(before.title!==after.title)fail('NATIVE_UPDATE_CONFLICT');
   return {saved,before,after,operationId,checkpoint,beforeSend};
  }
  const matchesUpdate=(actual,value)=>actual.postId===value.postId&&actual.title===value.title&&sameContent(actual.content,value.content)&&actual.status===value.status&&actual.url===value.url;
  function updateMismatch(actual,uncertain=false){
   const error=Object.assign(Error('NATIVE_UPDATE_CONFLICT'),{code:'NATIVE_UPDATE_CONFLICT',comparison:{actual:{title:String(actual.title||'').slice(0,300),status:/^[a-z_-]{1,32}$/.test(actual.status||'')?actual.status:'unknown',contentHash:createHash('sha256').update(String(actual.content||'')).digest('hex')}}});
   if(uncertain){error.uncertain=true;error.state='uncertain';}throw error;
  }
  async function readUpdate(input){
   if(updateTarget&&(updateTarget.postId!==input.saved.postId||updateTarget.url!==input.saved.url))fail('NATIVE_UPDATE_CONFLICT');
   updateTarget={postId:input.saved.postId,url:input.saved.url};
   expected={postId:input.saved.postId,title:input.before.title,html:input.before.content};mode='inspect';armedUrl=null;dispatch=null;dispatchError=null;
   await visit(address('wp-admin/post.php?post='+input.saved.postId+'&action=edit'),false,'commit');
   return editorState();
  }
  const updateCheckpoint=(input,phase)=>input.checkpoint({postId:input.saved.postId,url:input.saved.url,operationId:input.operationId,phase});
  async function reconcileUpdate(input){
   input=validateUpdate(input);try{
    updateOperations.set(input.operationId,'dispatching');
    const actual=await observeNativePhase(operationObserve,'reconcile',()=>readUpdate(input));
    if(matchesUpdate(actual,input.after)){await updateCheckpoint(input,'published');updateOperations.set(input.operationId,'published');return {...input.after};}
    if(!matchesUpdate(actual,input.before))updateMismatch(actual,true);fail('NATIVE_UPDATE_UNCERTAIN',true);
   }catch(error){error.uncertain=true;error.state='uncertain';delete error.writeNotAttempted;throw error;}finally{mode='inspect';armedUrl=null;dispatch=null;}
  }
  async function updatePublished(input){
   let sent=false;
   try{
    input=validateUpdate(input);
    if(updateOperations.has(input.operationId))return await reconcileUpdate(input);
    let actual=await readUpdate(input);if(!matchesUpdate(actual,input.before))updateMismatch(actual);
    await updateCheckpoint(input,'prepared');
    // The checkpoint may yield to another editor. Read WordPress again before
    // changing any visible fields, then allow only the exact reviewed body.
    actual=await readUpdate(input);if(!matchesUpdate(actual,input.before))updateMismatch(actual);
    const {after}=input;expected={postId:after.postId,title:after.title,html:after.content};
    if(actual.kind==='classic'){
     updateBaseline=await page.locator('form#post').evaluate(form=>{const button=form.querySelector('#publish');return {entries:[...new FormData(form)].map(([key,value])=>[key,String(value)]),button:button?.name?[button.name,button.value]:null};});
     const tab=page.locator('#content-html');if(await tab.count())await tab.click();await page.locator('#content').fill(after.content);
    }else{
     const welcome=page.locator('.components-modal__header button[aria-label],.edit-post-welcome-guide button[aria-label]');if(await welcome.count())await welcome.first().click();
     if(!await page.locator('textarea.editor-post-text-editor').isVisible())await page.keyboard.press('Control+Shift+Alt+m');
     const text=page.locator('textarea.editor-post-text-editor');await text.waitFor();
     await text.fill(plain(actual.content)==='<!-- wp:html -->\n'+plain(input.before.content)+'\n<!-- /wp:html -->'?'<!-- wp:html -->\n'+after.content+'\n<!-- /wp:html -->':after.content);await text.press('Tab');
    }
    await waitForState(({title,content})=>{const normalize=value=>String(value||'').replace(/\r\n/g,'\n');const form=document.querySelector('form#post');if(form)return form.querySelector('#title')?.value===title&&normalize(form.querySelector('#content')?.value)===normalize(content);const editor=window.wp?.data?.select('core/editor'),raw=normalize(editor?.getEditedPostContent?.());return editor?.getEditedPostAttribute?.('title')===title&&(raw===normalize(content)||raw==='<!-- wp:html -->\n'+normalize(content)+'\n<!-- /wp:html -->');},{argument:{title:after.title,content:after.content},code:'NATIVE_EDITOR_CONTENT_PENDING'});
    dispatch={operation:'update',sent:false,finished:false,checkpoint:async value=>{await updateCheckpoint(input,value.phase);},beforeSend:()=>{input.beforeSend();assertOpen();sent=true;updateOperations.set(input.operationId,'dispatching');}};dispatchError=null;mode='update';
    if(actual.kind==='classic')await page.locator('form#post #publish').click({noWaitAfter:true});
    else await page.locator('.editor-post-publish-button,.editor-post-publish-button__button').filter({visible:true}).first().click();
    const until=Date.now()+25000;while(!dispatch.finished&&!dispatchError&&Date.now()<until){assertOpen();await new Promise(resolve=>setTimeout(resolve,100));}
    if(dispatchError)throw dispatchError;if(!dispatch.finished)fail('NATIVE_UPDATE_UNCERTAIN',sent);
    return await reconcileUpdate(input);
   }catch(error){if(sent){error.uncertain=true;error.state='uncertain';delete error.writeNotAttempted;}else if(!error.uncertain)error.writeNotAttempted=true;if(!error.code)error.code=sent?'NATIVE_UPDATE_UNCERTAIN':'NATIVE_EDITOR_UNAVAILABLE';throw error;}
   finally{mode='inspect';armedUrl=null;dispatch=null;}
  }
  function coreTrashUrl(value,action){
   let url;try{url=same(new URL(value,page.url()).href);}catch{return null;}
   const entries=[...url.searchParams];
   return url.pathname===new URL('wp-admin/post.php',base).pathname&&!url.hash&&entries.length===3&&new Set(entries.map(([key])=>key)).size===3&&entries.every(([key])=>['post','action','_wpnonce'].includes(key))&&url.searchParams.get('post')===String(expected?.postId)&&url.searchParams.get('action')===action&&/^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get('_wpnonce')||'')?url:null;
  }
  async function trashListing(title,trash=false){
   const url=new URL('wp-admin/edit.php',base);url.searchParams.set('post_type','page');if(trash)url.searchParams.set('post_status','trash');url.searchParams.set('s',title);
   const reply=await visit(url.href,true);await guard();if(await page.locator('#loginform').count())fail('BROWSER_LOGIN_REQUIRED');if(reply.status()>=400||await page.locator('.wp-die-message,body#error-page').count())fail('NATIVE_TRASH_UNCERTAIN',true);
   return page.locator('tr[id="post-'+expected.postId+'"]');
  }
  async function trashProof(title){
   const row=await trashListing(title,true);if(await row.count()!==1)return false;
   const data=await row.evaluate((node,id)=>{const inline=node.querySelectorAll('[id="inline_'+id+'"]');return {classes:[...node.classList],title:inline.length===1?inline[0].querySelector('.post_title')?.textContent:null,status:inline.length===1?inline[0].querySelector('._status')?.textContent:null,restore:[...node.querySelectorAll('.row-actions .untrash a[href]')].map(link=>link.href)};},expected.postId);
   return data.classes.includes('type-page')&&data.classes.includes('status-trash')&&plain(data.title)===plain(title)&&data.status==='trash'&&data.restore.some(value=>coreTrashUrl(value,'untrash'));
  }
  const session={page,assertOpen,finished:false,networkTransport:networkSession?.transport||transport,get baseUrl(){return base?.href||null;},get canonicalLogin(){return canonicalLogin?{...canonicalLogin,...(pathChanged?{steps:loginSteps.map(step=>({...step}))}:{})}:null;},bind(value){const next=validatePublicUrl(value);if(base&&base.href!==next.href&&requestedBase!==next.href)fail('BROWSER_ORIGIN_BLOCKED');if(!base){base=next;requestedBase=next.href;}},status,
   async login({username,applicationPassword}){
    assertOpen();await guard();if(authenticated&&!await page.locator('form#loginform').count())return;authenticated=false;mode='read';
     const hasLoginCookie=async()=>(await context.cookies(base.href)).some(c=>c.name.startsWith('wordpress_logged_in_'));
     const loggedIn=await hasLoginCookie()&&await page.locator('#adminmenu,#wpadminbar').count();
    if(!loggedIn&&!await page.locator('form#loginform').count())await visit(address('wp-login.php'));await guard();
    if(await page.locator('form#loginform').count()){
     const formTarget=async()=>validatePublicUrl(new URL(await page.locator('form#loginform').getAttribute('action')||page.url(),page.url()).href);
     let action=await formTarget();
     if(action.origin!==base.origin){await adoptLoginBase(action.href);await visit(address('wp-login.php'));await guard();if(await page.locator('form#loginform').count()!==1)fail('BROWSER_LOGIN_REQUIRED');action=await formTarget();}
     if(action.origin!==base.origin||action.pathname!==new URL('wp-login.php',base).pathname||action.hash||action.searchParams.has('action')||action.searchParams.has('action2'))fail('BROWSER_ORIGIN_BLOCKED');
     loginSubmitted=true;
     // WordPress can shake the rejected form and clear/refocus its password
     // after rendering the error. Wait for the button before filling again:
     // otherwise click's actionability wait gives that script time to erase it.
     const submit=page.locator('#loginform input[type=submit],#loginform button[type=submit]').first();
     await submit.click({trial:true});await guard();
     await status('PagePoster · Входим в WordPress');await page.locator('#loginform [name=log]').fill(username);await page.locator('#loginform [name=pwd]').fill(applicationPassword);mode='login';
      await page.locator('#loginform').evaluate((form,target)=>{let field=form.querySelector('[name=redirect_to]');if(!field){field=document.createElement('input');field.type='hidden';field.name='redirect_to';form.append(field);}field.value=target;},address(manualEditor?'wp-admin/':'wp-admin/plugins.php'));
     // An old #login_error can remain until the next POST response commits.
     // Wait for that new document, even when the login URL stays identical.
     navigationError=null;navigationStatus=null;redirects=0;
     try{await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),submit.click({noWaitAfter:true})]);}
     catch(error){await guard();throw navigationError||error;}
    }
     let screen=await waitForState(loginScreen);
     if(screen==='rejected')throw Object.assign(Error('bootstrap_auth_failed'),{code:'bootstrap_auth_failed',state:'needs_attention',loginRejectedBeforeWrites:true});
     // A login hook may serve an interstitial with HTTP 200 after setting a
     // session cookie. Confirm that session with one protected GET, never a
     // second credential submission.
     if(['form','unknown'].includes(screen)&&await hasLoginCookie()){
      mode='read';await visit(address('wp-admin/'),true,'commit');
      screen=await waitForState(loginScreen);
     }
    if(new URL(page.url()).searchParams.get('action')==='confirm_admin_email'){
     const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>n.href));const reminder=links.find(value=>{try{const u=same(value);return u.pathname===new URL('wp-login.php',base).pathname&&u.searchParams.get('action')==='confirm_admin_email'&&/^[\w-]{5,100}$/.test(u.searchParams.get('remind_me_later')||'');}catch{return false;}});if(!reminder)fail('BROWSER_EMAIL_CONFIRMATION_REQUIRED');await visit(reminder);
      screen=await waitForState(loginScreen);
    }
     if(screen==='unknown')fail('BROWSER_LOGIN_UNCONFIRMED');
     if(screen==='form')mode='login';
     if(screen!=='wordpress'||!await hasLoginCookie())fail('BROWSER_LOGIN_REQUIRED');
     mode='read';authenticated=true;await status('PagePoster · Вход выполнен');
   },
    async openEditor(postId,assertCurrent){
     if(!manualEditor||!authenticated||!Number.isSafeInteger(postId)||postId<1)fail('BROWSER_EDITOR_ACCESS');
     const url=address('wp-admin/post.php?post='+postId+'&action=edit');
     const current=new URL(page.url());
     if(mode==='manual-editor'&&expected?.postId===postId&&current.pathname===new URL(url).pathname&&current.searchParams.get('post')===String(postId)&&current.searchParams.get('action')==='edit'){assertCurrent();await page.bringToFront();return;}
     expected={postId};mode='inspect';assertCurrent();
     const response=await visit(url,true,'commit');
     if(response.status()>=400)fail('BROWSER_EDITOR_ACCESS');
     await waitForState(()=>{
      if(document.querySelector('meta[data-pp-redirect]'))return false;
      if(document.querySelector('#loginform,.wp-die-message,body#error-page'))return true;
      const form=document.querySelector('form#post #content')?.closest('form');
      return !!form?.querySelector('[name=post_ID]')?.value||!!window.wp?.data?.select('core/editor')?.getCurrentPost?.()?.id;
     },{code:'BROWSER_EDITOR_ACCESS'});
     const actual=await documentValue(()=>{
      if(document.querySelector('#loginform'))return {login:true};
      const form=document.querySelector('form#post #content')?.closest('form');
      if(form)return {id:Number(form.querySelector('[name=post_ID]')?.value),type:form.querySelector('[name=post_type]')?.value};
      const post=window.wp?.data?.select('core/editor')?.getCurrentPost?.();
      return {id:post?.id,type:post?.type};
     });
     if(actual?.login)fail('BROWSER_LOGIN_REQUIRED');
     if(Number(actual?.id)!==postId||actual?.type!=='page'||page.url()!==url)fail('BROWSER_EDITOR_ACCESS');
     assertCurrent();mode='manual-editor';await page.bringToFront();
    },
    async switchAccount(){assertOpen();await guard();if(dispatch?.sent||expected?.postId||pendingDraftId||pendingCreation)fail('NATIVE_RESULT_UNCERTAIN',true);switchingAccount=true;accountEpoch++;accountController.abort();assets.clear();try{await cookieWork;await context.clearCookies();accountController=networkController();authenticated=false;mode='read';manualChallenge=null;switchingAccount=false;await visit(address('wp-login.php'));}finally{switchingAccount=false;}},
   async ensureCleanLinks({ampMode=false}={}){
    const ampVersion='1.2.1',requiredVersion=ampMode?ampVersion:'1.1.3';
    const compatible=version=>ampMode?version===ampVersion:['1.1.3','1.2.0',ampVersion].includes(version);
    const listing=address('wp-admin/plugins.php?plugin_status=all&s=PagePoster%20Clean%20Links');
    let row=page.locator('tr[data-plugin="'+cleaner+'"]');
    const current=new URL(page.url()),alreadyListed=current.origin===base.origin&&current.pathname===new URL('wp-admin/plugins.php',base).pathname&&!current.searchParams.has('action')&&!current.searchParams.has('action2')&&await row.count()===1;
    mode='read';if(alreadyListed)await waitForState(adminDocumentReady,{argument:'plugins'});else await pluginScreen(listing);await status('PagePoster · Проверяем права установки Clean Links');
    const readVersion=async()=>{const info=row.locator('.plugin-version-author-uri');return (await info.count()?await info.first().innerText():'').match(/\b(\d+(?:\.\d+){2,}(?:[-+][\w.-]+)?)\b/)?.[1];};
    const present=!!await row.count(),version=present?await readVersion():null;
    const older=version&&/^\d+\.\d+\.\d+$/.test(version)&&version.split('.').reduce((result,part,i)=>result||Math.sign(Number(part)-Number(requiredVersion.split('.')[i])),0)<0;
    if(present&&!compatible(version)&&!older)fail('CLEAN_LINKS_UPDATE_REQUIRED');
    if(!present||older){
     await pluginScreen(address('wp-admin/plugin-install.php?tab=upload'));
     const input=page.locator('input[type=file][name=pluginzip]');
     if(!await input.count())fail('CLEAN_LINKS_NOT_INSTALLED');
     let packageName=cleanerName,packageHash=cleanerHash;
     if(ampMode){const release=JSON.parse(readFileSync(new URL('../../assets/pageposter-amp-package.json',import.meta.url),'utf8'));if(release.version!==ampVersion||release.filename!==`pageposter-clean-links-${ampVersion}.zip`||!/^[a-f0-9]{64}$/.test(release.sha256))fail('CLEAN_LINKS_PACKAGE_INVALID');packageName=release.filename;packageHash=release.sha256;}
     const bytes=readFileSync(fileURLToPath(new URL('../../assets/'+packageName,import.meta.url)));if(createHash('sha256').update(bytes).digest('hex')!==packageHash)fail('CLEAN_LINKS_PACKAGE_INVALID');
     const form=input.locator('xpath=ancestor::form'),action=same(await form.getAttribute('action')?new URL(await form.getAttribute('action'),page.url()).href:page.url());
     if(action.pathname!==new URL('wp-admin/update.php',base).pathname||action.searchParams.get('action')!=='upload-plugin')fail('BROWSER_ORIGIN_BLOCKED');
     await input.setInputFiles({name:packageName,mimeType:'application/zip',buffer:bytes});await status('PagePoster · Устанавливаем только PagePoster Clean Links');mode='upload';armedUrl=action.href;
     // Admin notices may contain slow images/iframes. The upload result DOM is
     // sufficient; waiting for the window's load event can stop a valid install.
     await Promise.all([page.waitForURL(u=>u.pathname===action.pathname,{waitUntil:'commit'}),form.locator('input[type=submit],button[type=submit]').first().click({noWaitAfter:true})]);await guard();mode='read';
     if(older){await waitForState(()=>!!document.querySelector('a.update-from-upload-overwrite[href],.wp-die-message,#loginform')||document.readyState!=='loading');await guard();const replace=page.locator('a.update-from-upload-overwrite[href]');if(!await replace.count())fail('CLEAN_LINKS_UPDATE_REQUIRED');const target=same(await replace.first().getAttribute('href')?new URL(await replace.first().getAttribute('href'),page.url()).href:'');if(target.pathname!==action.pathname||target.searchParams.get('action')!=='upload-plugin'||target.searchParams.get('overwrite')!=='update-plugin'||!target.searchParams.get('_wpnonce'))fail('CLEAN_LINKS_UPDATE_REQUIRED');await status('PagePoster · Обновляем только Clean Links до '+requiredVersion);await visit(target.href,false,'commit');await guard();}
     await pluginScreen(listing);row=page.locator('tr[data-plugin="'+cleaner+'"]');if(!await row.count())fail('CLEAN_LINKS_NOT_INSTALLED');
     if(!compatible(await readVersion()))fail('CLEAN_LINKS_UPDATE_REQUIRED');
    }
    if(!/(^|\s)active(\s|$)/.test(await row.getAttribute('class')||'')){
     const links=await row.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>n.href));const activate=links.find(value=>{const u=same(value);return u.pathname===new URL('wp-admin/plugins.php',base).pathname&&u.searchParams.get('action')==='activate'&&u.searchParams.get('plugin')===cleaner&&!!u.searchParams.get('_wpnonce');});if(!activate)fail('CLEAN_LINKS_NOT_ACTIVE');
     await status('PagePoster · Активируем Clean Links');await visit(activate);await pluginScreen(listing);row=page.locator('tr[data-plugin="'+cleaner+'"]');
     if(!await row.count())fail('CLEAN_LINKS_NOT_INSTALLED');if(!compatible(await readVersion()))fail('CLEAN_LINKS_UPDATE_REQUIRED');
     if(!/(^|\s)active(\s|$)/.test(await row.getAttribute('class')||''))fail('CLEAN_LINKS_NOT_ACTIVE');
    }
    await status('PagePoster · Плагин очистки готов');return {name:'PagePoster Clean Links',active:true,...(await readVersion()===ampVersion?{ampSupport:true}:{})};
   },
    inspectPublished:inspect,
    updatePublished,reconcileUpdate,
   async inspectOwnedTrash({saved,title,html}){
    // This path never arms an action URL or creates a dispatch capability.
    // Listing proof is bound to the saved ID, title, row status and restore ID.
    if(!Number.isSafeInteger(saved?.postId)||saved.postId<1||saved.phase!=='published'||typeof title!=='string'||typeof html!=='string')fail('NATIVE_TRASH_UNCERTAIN',true);
    const url=same(saved.url);if(url.pathname.startsWith(new URL('wp-admin/',base).pathname))fail('NATIVE_TRASH_UNCERTAIN',true);
    dispatch=null;dispatchError=null;armedUrl=null;expected={postId:saved.postId,title,html};mode='inspect';
    return {postId:saved.postId,status:await trashProof(title)?'trash':'unknown'};
   },
   async trashPublished({saved,title,html,cleanup:cleanupState,checkpoint,beforeSend}){
    dispatch=null;dispatchError=null;mode='trash';
    try{
     if(typeof checkpoint!=='function'||typeof beforeSend!=='function')fail('NATIVE_CHECKPOINT_REQUIRED');
     if(!Number.isSafeInteger(saved?.postId)||saved.postId<1||saved.phase!=='published'||typeof saved.url!=='string'||typeof title!=='string'||typeof html!=='string'||cleanupState&&(!['prepared','dispatching','trashed'].includes(cleanupState.phase)||cleanupState.postId!=null&&cleanupState.postId!==saved.postId))fail('NATIVE_TRASH_UNCERTAIN',true);
     const publishedUrl=same(saved.url);if(publishedUrl.hash||publishedUrl.pathname.startsWith(new URL('wp-admin/',base).pathname))fail('NATIVE_TRASH_UNCERTAIN',true);
     expected={postId:saved.postId,title,html};
     if(cleanupState?.phase==='dispatching'||cleanupState?.phase==='trashed'){
      if(!await trashProof(title))fail('NATIVE_TRASH_UNCERTAIN',true);await checkpoint({postId:saved.postId,phase:'trashed'});return {postId:saved.postId,status:'trash'};
     }
     const actual=await inspect({saved,title,html,readMode:'trash'});if(actual.url!==publishedUrl.href)fail('NATIVE_CONTENT_CHANGED',true);
     const row=await trashListing(title);if(await row.count()!==1)fail('NATIVE_TRASH_UNAVAILABLE');
     const links=row.locator('.row-actions .trash a[href]');if(await links.count()!==1)fail('NATIVE_TRASH_UNAVAILABLE');
     const chosen=links.first(),target=coreTrashUrl(await chosen.getAttribute('href'),'trash');if(!target)fail('NATIVE_TRASH_UNAVAILABLE');
     dispatch={operation:'trash',sent:false,finished:false,checkpoint,beforeSend};armedUrl=target.href;navigationError=null;navigationStatus=null;redirects=0;
     await row.hover();await chosen.click({noWaitAfter:true});const until=Date.now()+25000;while(!dispatch.finished&&!dispatchError&&Date.now()<until){assertOpen();await new Promise(resolve=>setTimeout(resolve,100));}
     if(dispatchError)throw dispatchError;if(!dispatch.finished)fail('NATIVE_TRASH_UNCERTAIN',dispatch.sent);
     if(!await trashProof(title))fail('NATIVE_TRASH_UNCERTAIN',true);await checkpoint({postId:saved.postId,phase:'trashed'});return {postId:saved.postId,status:'trash'};
    }catch(error){if(dispatch?.sent||['dispatching','trashed'].includes(cleanupState?.phase)){error.uncertain=true;error.state='uncertain';delete error.writeNotAttempted;if(!['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code))error.code='NATIVE_TRASH_UNCERTAIN';}else if(!error.uncertain)error.writeNotAttempted=true;if(!error.code)error.code='NATIVE_TRASH_UNAVAILABLE';throw error;}
    // Keep this document restricted after completion as well: delayed page
    // scripts must not turn a confirmed cleanup into another native write.
    finally{armedUrl=null;}
   },
   async publishPage({title,html,slug,checkpoint,beforeSend,saved}){
    dispatch=null;dispatchError=null;let draftSaved=false;
    try{
     if(typeof checkpoint!=='function'||typeof beforeSend!=='function')fail('NATIVE_CHECKPOINT_REQUIRED');
     if(slug!==undefined&&(typeof slug!=='string'||slug.length>200||!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)))fail('NATIVE_SLUG_MISMATCH');
     if((saved?.phase==='creating'||pendingCreation)&&!pendingDraftId)fail('NATIVE_RESULT_UNCERTAIN',true);
     if(saved?.postId&&pendingDraftId&&saved.postId!==pendingDraftId)fail('NATIVE_RESULT_UNCERTAIN',true);
     if(!saved?.postId&&pendingDraftId){saved={postId:pendingDraftId,phase:'draft'};await checkpoint(saved);draftSaved=true;}
     if(saved?.postId){try{return await inspect({saved,title,html,slug});}catch(error){if(error.code!=='NATIVE_NOT_PUBLISHED'||['dispatching','published'].includes(saved.phase))throw error;}}
     else{mode='read';draftCheckpoint=async saved=>{await checkpoint(saved);if(saved.postId){expected={postId:saved.postId,title,html};draftSaved=true;}};await status('PagePoster · Открываем новую страницу WordPress');await observeNativePhase(operationObserve,'create',()=>openNewPage(),{checkpoint:()=>pendingDraftId?'draft':pendingCreation?'creating':null});}
     const initial=await observeNativePhase(operationObserve,'editor',async()=>{
     const initial=await editorState();if(!Number.isSafeInteger(initial.postId)||initial.postId<1||!['draft','auto-draft'].includes(initial.status))fail('NATIVE_EDITOR_UNAVAILABLE');
     if(pendingDraftId&&initial.postId!==pendingDraftId)fail('NATIVE_RESULT_UNCERTAIN',true);pendingDraftId=initial.postId;expected={postId:initial.postId,title,html,slug};if(!draftSaved)await checkpoint({postId:initial.postId,phase:'draft'});pendingCreation=false;draftCheckpoint=null;await status('PagePoster · Вводим название и готовый HTML');
     if(initial.kind==='classic'){
      const tab=page.locator('#content-html');if(await tab.count())await tab.click();await page.locator('#title').fill(title);await page.locator('#content').fill(html);
     }else{
      // Use the editor's own shortcut and visible inputs, never dispatch a save.
      const welcome=page.locator('.components-modal__header button[aria-label],.edit-post-welcome-guide button[aria-label]');if(await welcome.count())await welcome.first().click();
      if(!await page.locator('textarea.editor-post-text-editor').isVisible())await page.keyboard.press('Control+Shift+Alt+m');
      const titleField=page.locator('input.editor-post-title__input,textarea.editor-post-title__input,[contenteditable=true].editor-post-title__input,[contenteditable=true].wp-block-post-title,.editor-post-title__input textarea,.editor-post-title__input input[type=text]').filter({visible:true}).first();await titleField.fill(title);
      const text=page.locator('textarea.editor-post-text-editor');await text.waitFor();await text.fill('<!-- wp:html -->\n'+html+'\n<!-- /wp:html -->');await text.press('Tab');
     }
     if(slug){
      const applied=await page.evaluate(value=>{
       const form=document.querySelector('form#post');
       if(form){
        let input=form.elements.namedItem('post_name');
        if(input&&!(input instanceof HTMLInputElement))return false;
        if(!input){input=document.createElement('input');input.type='hidden';input.name='post_name';form.appendChild(input);}
        input.value=value;
        return input.value===value&&!input.disabled;
       }
       const editor=window.wp?.data?.dispatch?.('core/editor');
       if(typeof editor?.editPost!=='function')return false;
       editor.editPost({slug:value});
       return true;
      },slug);
      if(!applied)fail('NATIVE_SLUG_MISMATCH');
     }
     // Visible inputs can update before Gutenberg commits its React/editor
     // state. Publish only the same title/content that the request guard expects.
     await waitForState(({title,html})=>{const plain=value=>String(value||'').replace(/\r\n/g,'\n');const form=document.querySelector('form#post');if(form)return plain(form.querySelector('#title')?.value)===plain(title)&&plain(form.querySelector('#content')?.value)===plain(html);const editor=window.wp?.data?.select('core/editor');if(!editor)return false;const content=plain(editor.getEditedPostContent?.());return plain(editor.getEditedPostAttribute?.('title'))===plain(title)&&(content===plain(html)||content==='<!-- wp:html -->\n'+plain(html)+'\n<!-- /wp:html -->');},{argument:{title,html},code:'NATIVE_EDITOR_CONTENT_PENDING'});
     return initial;},{checkpoint:()=>pendingDraftId?'draft':null});
     await status('PagePoster · Нажимаем «Опубликовать»');dispatch={sent:false,finished:false,checkpoint,beforeSend};mode='publish';
     if(initial.kind==='classic')await page.locator('#publish').click();
     else{
      const toggle=page.locator('button.editor-post-publish-panel__toggle').filter({visible:true}).first();
      const submit=page.locator('button:is(.editor-post-publish-button,.editor-post-publish-button__button):not(.editor-post-publish-panel__toggle)').filter({visible:true}).first();
      if(await toggle.isVisible())await toggle.click();
      // The shared __button class can also belong to the toggle. Only the
      // visible submit button is allowed to confirm publication.
      if(!dispatch.reserved&&!dispatchError)await submit.click();
     }
     const until=Date.now()+25000;while(!dispatch.finished&&!dispatchError&&Date.now()<until){assertOpen();await new Promise(resolve=>setTimeout(resolve,100));}
     if(dispatchError)throw dispatchError;
     if(!dispatch.finished)fail(dispatch.reserved?'NATIVE_RESULT_UNCERTAIN':'NATIVE_PUBLISH_NOT_SENT',dispatch.sent);
     mode='read';const result=await inspect({saved:{postId:initial.postId},title,html,slug});await checkpoint({postId:result.postId,phase:'published',url:result.url});return result;
    }catch(error){
     if(dispatch?.sent||pendingCreation&&!pendingDraftId){error.uncertain=true;error.state='uncertain';if(!dispatch?.sent)error.code='NATIVE_RESULT_UNCERTAIN';}
     if(!error.code)error.code=dispatch?.sent?'NATIVE_RESULT_UNCERTAIN':dispatch&&!dispatch.reserved&&error.name==='TimeoutError'?'NATIVE_PUBLISH_NOT_SENT':'NATIVE_EDITOR_UNAVAILABLE';
     if(!dispatch?.sent&&!error.uncertain)error.writeNotAttempted=true;throw error;
    }
    finally{mode='read';armedUrl=null;draftCheckpoint=null;}
   },
   async result(url){mode='read';await visit(same(url).href);await status('PagePoster · Страница опубликована');},
   async focus(){assertOpen();await page.bringToFront();},
   async resume(){assertOpen();await guard();return true;},
   close:cleanup
  };
  for(const name of ['login','ensureCleanLinks','publishPage','inspectPublished','inspectOwnedTrash','trashPublished','updatePublished','reconcileUpdate']){
   const action=session[name];
   session[name]=async(...args)=>{
    const prior=operationObserve;
    operationObserve=name==='login'?args[1]?.observe:args[0]?.observe;
    const pluginAction=name==='ensureCleanLinks';
    if(pluginAction)checkingCleanLinks=true;
    try{return await action(...args);}
    finally{
     operationObserve=prior;
     if(pluginAction){checkingCleanLinks=false;mode='read';armedUrl=null;}
    }
   };
  }
  sessions.set(id,session);
  if(base){
   try{await visit(address('wp-login.php'));}
   catch(error){
    // Retry the initial document read before credentials or editor writes.
    const retryableStatus=error.code==='BROWSER_PAGE_UNAVAILABLE'&&[500,502,503,504].includes(error.httpStatus);
    if(!retryableStatus&&!['network_timeout','network_failed','dns_failed'].includes(error.code))throw error;
    if(retryableStatus)await new Promise(resolve=>setTimeout(resolve,500));
    await visit(address('wp-login.php'));
   }
  }
  await page.bringToFront();operationObserve=null;return session;
  }catch(error){
   // Manual verification deliberately keeps its private page for Resume.
   if(!sessions.has(id)||!['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code)){await cleanup();sessions.delete(id);}
   throw error;
  }
 }
 return {nativeEditor:true,transportFor:id=>{const session=sessions.get(id);if(!session)return null;try{session.assertOpen();return session.networkTransport;}catch{return null;}},open,prepare:(id,options)=>open(id,options?.baseUrl||null,options),assertOpen:id=>{const s=sessions.get(id);if(!s)fail('BROWSER_NOT_OPEN');s.assertOpen();},focus:async id=>{const s=sessions.get(id);if(!s)fail('BROWSER_NOT_OPEN');await s.focus();},resume:async id=>{const s=sessions.get(id);if(!s)return false;try{s.assertOpen();}catch(error){if(error.code==='BROWSER_CLOSED')return false;throw error;}return s.resume();},switchAccount:async id=>{const s=sessions.get(id);if(!s)fail('BROWSER_NOT_OPEN');return s.switchAccount();},reset:id=>serialize(async()=>{await sessions.get(id)?.close();sessions.delete(id);if(owner===id&&!openings.has(id))owner=null;}),result:async(id,url)=>sessions.get(id)?.result(url),done:async id=>{const s=sessions.get(id);if(!s)return;s.finished=true;try{await s.status('PagePoster · Готово. Страница опубликована.');}catch(error){if(error.code!=='BROWSER_CLOSED')throw error;}},error:async(id,code)=>sessions.get(id)?.status(manualInstructions[code]||'PagePoster · Остановлено: '+(/^[a-zA-Z_]{1,80}$/.test(code||'')?code:'ошибка')+'. Подробности — в PagePoster.'),close:async()=>{closing=true;await sharedBrowser?.close().catch(()=>{});await Promise.allSettled([...openings.values()]);await lifecycle;await Promise.all([...sessions.values()].map(s=>s.close()));sessions.clear();sharedBrowser=null;owner=null;}};
}
