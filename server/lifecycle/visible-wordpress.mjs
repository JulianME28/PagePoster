import {createRequire} from 'node:module';
import path from 'node:path';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
import {findBrowserExecutable} from './browser-executable.cjs';
const require=createRequire(import.meta.url);
const fail=code=>{throw Object.assign(Error(code),{code,state:'needs_attention'});};
function runtime(){for(const name of ['playwright','playwright-core',path.resolve(path.dirname(process.execPath),'..','node_modules','playwright'),path.resolve(path.dirname(process.execPath),'..','node_modules','playwright-core')])try{return require(name).chromium;}catch{}return null;}
function executable(chromium){return findBrowserExecutable({chromium});}
const header=(reply,name)=>Object.entries(reply.headers||{}).find(([key])=>key.toLowerCase()===name)?.[1];
function uploadFile(body,type){
 const boundary=/boundary=([^;]+)/i.exec(type||'')?.[1],buffer=Buffer.isBuffer(body)?body:Buffer.from(body||'');
 const match=/name="pluginzip"; filename="([a-zA-Z0-9.-]+\.zip)"\r\nContent-Type: application\/zip\r\n\r\n/.exec(buffer.toString('latin1'));
 if(!boundary||!match)fail('BROWSER_ACTION_UNSUPPORTED');const start=match.index+match[0].length,end=buffer.indexOf(Buffer.from('\r\n--'+boundary),start);if(end<start)fail('BROWSER_ACTION_UNSUPPORTED');
 return {name:match[1],mimeType:'application/zip',buffer:buffer.subarray(start,end)};
}
// Browser navigation is mediated by the same DNS-pinned transport as bootstrap.
// Only one explicitly armed action can write. Page scripts, unsolicited admin
// navigations, external origins and new windows cannot send network requests.
export function createVisibleWordPress({chromium=runtime(),executablePath=executable(chromium),headless=false,transport=createSafeTransport({allowWrites:true,maxBytes:2*1024*1024})}={}){
 const sessions=new Map();
 async function open(id,baseUrl,options={}){
  let base=baseUrl?validatePublicUrl(baseUrl):null;const existing=sessions.get(id);if(existing){existing.assertOpen();if(base)existing.bind(base.href);return existing;}
  if(!chromium||!executablePath)fail('BROWSER_UNAVAILABLE');let browser;
  try{browser=await chromium.launch({executablePath,headless:options.headless??headless,timeout:20000,args:['--incognito','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--disable-features=MediaRouter','--host-resolver-rules=MAP * ~NOTFOUND','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});}catch{fail('BROWSER_UNAVAILABLE');}
  const context=await browser.newContext({viewport:null,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});
  const page=await context.newPage();page.setDefaultTimeout(15000);let pending=null,closed=false,resourceCount=0,message='PagePoster · Підключаємося до WordPress',authenticated=false;
  page.on('close',()=>{closed=true;void browser.close().catch(()=>{});});browser.on('disconnected',()=>closed=true);
  const assertOpen=()=>{if(closed||page.isClosed()||!browser.isConnected())fail('BROWSER_CLOSED');};
  const same=value=>{if(!base)fail('BROWSER_SITE_REQUIRED');const url=validatePublicUrl(value);if(url.origin!==base.origin)fail('BROWSER_ORIGIN_BLOCKED');return url;};
  const cookieHeaders=async(url)=>({cookie:(await context.cookies(url)).map(c=>c.name+'='+c.value).join('; ')});
  async function acceptCookies(reply,url){
   const raw=header(reply,'set-cookie');for(const value of raw?(Array.isArray(raw)?raw:[raw]):[]){const parts=value.split(';'),pair=parts.shift(),i=pair.indexOf('=');if(i<1)continue;
    const attrs=new Map(parts.map(p=>{const i=p.indexOf('=');return i<0?[p.trim().toLowerCase(),'']:[p.slice(0,i).trim().toLowerCase(),p.slice(i+1).trim()];}));
    const domain=(attrs.get('domain')||url.hostname).replace(/^\./,'').toLowerCase();if(domain!==url.hostname&&!url.hostname.endsWith('.'+domain))continue;
    const expires=attrs.has('max-age')?Math.floor(Date.now()/1000)+Number(attrs.get('max-age')):attrs.has('expires')?Math.floor(Date.parse(attrs.get('expires'))/1000):undefined;
    await context.addCookies([{name:pair.slice(0,i).trim(),value:pair.slice(i+1).trim(),domain:url.hostname,path:attrs.get('path')||'/',secure:true,httpOnly:attrs.has('httponly'),...(Number.isFinite(expires)?{expires:Math.max(1,expires)}:{})}]);
   }
  }
  async function fulfill(route,reply,url){
   await acceptCookies(reply,url);const headers={};for(const[key,value]of Object.entries(reply.headers||{}))if(!['set-cookie','content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase()))headers[key]=Array.isArray(value)?value.join(', '):String(value);
   await route.fulfill({status:reply.status,headers,body:reply.body||Buffer.from(reply.text||'')});
  }
  function readRedirect(url){const suffix=url.pathname.slice(base.pathname.length),action=url.searchParams.get('action');if(!url.pathname.startsWith(base.pathname)||!['wp-admin/','wp-admin/index.php','wp-admin/plugins.php','wp-admin/plugin-install.php','wp-login.php'].includes(suffix)||url.searchParams.has('action2'))return false;if(action&&!(suffix==='wp-login.php'&&action==='confirm_admin_email'))return false;const redirect=url.searchParams.get('redirect_to');if(redirect){let target;try{target=same(new URL(redirect,url).href);}catch{return false;}if(!target.pathname.startsWith(new URL('wp-admin/',base).pathname)||target.searchParams.has('action')||target.searchParams.has('action2'))return false;}return true;}
  await context.route('**/*',async route=>{
   const req=route.request();let url;try{url=same(req.url());}catch{return route.abort();}
   if(req.frame()!==page.mainFrame())return route.abort();
   const action=pending;
   if(action&&!action.sent&&req.isNavigationRequest()&&url.href===action.url&&req.method()===action.method){
    try{if(action.options.beforeSend)action.options.beforeSend();action.sent=true;const reply=await transport(url.href,{...action.options,method:action.method,followRedirects:false});action.reply=reply;
     // Browser redirects can escape request interception. Follow them explicitly
     // through navigate after recording the original response for bootstrap.
     if([301,302,303,307,308].includes(reply.status)){await acceptCookies(reply,url);await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><title>WordPress</title><p>WordPress перевіряє вхід. Очікуємо наступний екран…</p>'});}
     else await fulfill(route,reply,url);action.resolve(reply);
    }catch(error){action.reject(error);await route.abort().catch(()=>{});}return;
   }
   const redirected=action&&action.sent&&req.isNavigationRequest()&&readRedirect(url);
   const asset=['stylesheet','image','font'].includes(req.resourceType())&&!url.searchParams.has('action')&&!url.searchParams.has('action2');
   if(req.method()!=='GET'||(!redirected&&!asset)||++resourceCount>180)return route.abort();
   try{const reply=await transport(url.href,{method:'GET',headers:await cookieHeaders(url.href),followRedirects:false});await fulfill(route,reply,url);}catch{await route.abort().catch(()=>{});}
  });
  async function status(text){message=text;if(closed)return;await page.evaluate(text=>{let node=document.getElementById('pageposter-live-status');if(!node){node=document.createElement('div');node.id='pageposter-live-status';node.setAttribute('role','status');node.style.cssText='position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:14px 18px;background:#172a43;color:white;border:1px solid #47668c;border-radius:10px;font:15px/1.5 Arial,sans-serif;box-shadow:0 3px 16px #0004;pointer-events:none';document.documentElement.appendChild(node);}node.textContent=text;},text).catch(()=>{});}
  async function navigate(url,options={},depth=0){
   assertOpen();same(url);if(pending)fail('BROWSER_BUSY');resourceCount=0;
   const method=options.method||'GET';let resolve,reject;const response=new Promise((a,b)=>{resolve=a;reject=b;});response.catch(()=>{});
   const action={url,method,options,resolve,reject,sent:false};pending=action;
   const timer=setTimeout(()=>reject(Object.assign(Error('BROWSER_TIMEOUT'),{code:'BROWSER_TIMEOUT'})),20000);
   try{
    let navigation;
    if(method==='GET')navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
    else if(new URL(url).pathname.endsWith('/wp-login.php')){
     await status('PagePoster · Уводимо дані й входимо у WordPress');const form=page.locator('form#loginform');const data=new URLSearchParams(options.body);
     await form.locator('[name=log]').fill(data.get('log')||'');await form.locator('[name=pwd]').fill(data.get('pwd')||'');
     const submit=form.locator('input[type=submit],button[type=submit]').first(),loaded=page.waitForEvent('domcontentloaded',{timeout:20000});navigation=Promise.all([loaded,submit.count().then(count=>count?submit.click():form.evaluate(f=>f.requestSubmit()))]);
    }else if(method==='POST'&&new URL(url).searchParams.get('action')==='upload-plugin'){
     const file=uploadFile(options.body,options.headers?.['content-type']);await status('PagePoster · Установлюємо '+file.name);
     const input=page.locator('input[type=file][name=pluginzip]');await input.setInputFiles(file);const form=input.locator('xpath=ancestor::form'),submit=form.locator('input[type=submit],button[type=submit]').first(),loaded=page.waitForEvent('domcontentloaded',{timeout:20000});navigation=Promise.all([loaded,submit.count().then(count=>count?submit.click():form.evaluate(f=>f.requestSubmit()))]);
    }else if(method==='POST'&&options.nativeForm){
     const form=page.locator('form#post'),loaded=page.waitForEvent('domcontentloaded',{timeout:20000});navigation=Promise.all([loaded,form.locator('#publish').click()]);
    }else fail('BROWSER_ACTION_UNSUPPORTED');
    await navigation;const reply=await response;await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
    if([301,302,303,307,308].includes(reply.status)){if(depth>=5||method!=='GET'&&[307,308].includes(reply.status))fail('BROWSER_ORIGIN_BLOCKED');const next=same(new URL(header(reply,'location'),url).href);if(!readRedirect(next))fail('BROWSER_ORIGIN_BLOCKED');pending=null;await navigate(next.href,{headers:await cookieHeaders(next.href)},depth+1);}
    await status(message);return reply;
   }catch(error){const code=closed?'BROWSER_CLOSED':error.code||'BROWSER_ACTION_FAILED',uncertain=action.sent&&method==='POST'&&!new URL(url).pathname.endsWith('/wp-login.php');throw Object.assign(Error(code),{code,state:uncertain?'uncertain':'needs_attention',uncertain,...(error.writeNotAttempted?{writeNotAttempted:true}:{})});}
   finally{clearTimeout(timer);pending=null;}
  }
  const session={get baseUrl(){return base?.href||'';},bind:url=>{if(base&&base.href!==url)fail('BROWSER_SITE_CHANGED');base=validatePublicUrl(url);},page,assertOpen,status,
   transport:async(url,options={})=>{assertOpen();const target=same(url),relative=target.pathname.slice(base.pathname.length);if(target.pathname.startsWith(base.pathname)&&(/^(?:wp-login\.php|wp-admin\/(?:index\.php|plugins\.php|plugin-install\.php|update\.php)?|wp-admin\/edit\.php)$/.test(relative)))return navigate(target.href,options);return transport(target.href,{...options,followRedirects:false});},
   markAuthenticated:()=>authenticated=true,
   login:async credential=>{assertOpen();if(authenticated)return;const url=new URL('wp-login.php',base).href;await navigate(url,{headers:await cookieHeaders(url)});await navigate(url,{method:'POST',headers:{...(await cookieHeaders(url)),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({log:credential.username,pwd:credential.applicationPassword,redirect_to:new URL('wp-admin/',base).href,testcookie:'1'}).toString()});
    if(new URL(page.url()).searchParams.get('action')==='confirm_admin_email'){
     const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(node=>node.href));const reminder=links.find(value=>{try{const target=same(value);return target.pathname===new URL(url).pathname&&target.searchParams.get('action')==='confirm_admin_email'&&/^[a-zA-Z0-9_-]{5,100}$/.test(target.searchParams.get('remind_me_later')||'')&&readRedirect(target);}catch{return false;}});
     if(!reminder)fail('BROWSER_EMAIL_CONFIRMATION_REQUIRED');await status('PagePoster · WordPress просить перевірити email. Вибираємо «Нагадати пізніше», адресу не змінюємо.');await navigate(reminder,{headers:await cookieHeaders(reminder)});
    }
    if(await page.locator('form#loginform,input[name*=otp],input[name*=two_factor]').count()||!(await context.cookies(base.href)).some(c=>c.name.startsWith('wordpress_logged_in_')))fail('BROWSER_LOGIN_REQUIRED');authenticated=true;},
   publication:async()=>{await status('PagePoster · Перевіряємо готовий HTML. Далі відкриється редактор WordPress.');const url=new URL('wp-admin/edit.php?post_type=page',base).href;await navigate(url,{headers:await cookieHeaders(url)});if(await page.locator('form#loginform').count()){authenticated=false;fail('BROWSER_LOGIN_REQUIRED');}},
   publish:async({operation,address,beforeSend})=>{
    let nativeDispatched=false;try{
    assertOpen();if(operation.kind!=='create'||!['page','post'].includes(operation.postType)||operation.status!=='publish'||! /^[a-f0-9-]{36}$/.test(operation.operationId))fail('BROWSER_ACTION_UNSUPPORTED');
    const editor=new URL('wp-admin/post-new.php',base);editor.searchParams.set('post_type',operation.postType);editor.searchParams.set('pageposter_operation',operation.operationId);
    await status('PagePoster · Відкриваємо редактор WordPress');await navigate(editor.href,{headers:await cookieHeaders(editor.href)});
    const form=page.locator('form#post');if(await form.locator('[name=pageposter_operation]').inputValue()!==operation.operationId)fail('BROWSER_EDITOR_UNAVAILABLE');
    await status('PagePoster · Заповнюємо заголовок і HTML сторінки');await form.locator('#title').fill(operation.title);await form.locator('#content').fill(operation.content);
    const data=await form.evaluate(form=>{const data=new URLSearchParams();for(const [key,value]of new FormData(form))if(typeof value==='string')data.append(key,value);const button=form.querySelector('#publish');if(button.name)data.set(button.name,button.value);return {action:form.action,body:data.toString()};});
    const target=same(data.action);if(target.pathname!==new URL('wp-admin/post.php',base).pathname)fail('BROWSER_ORIGIN_BLOCKED');
    const fields=new URLSearchParams(data.body);if(fields.get('post_title')!==operation.title||fields.get('content')!==operation.content||fields.get('post_type')!==operation.postType||!fields.get('pageposter_nonce'))fail('BROWSER_EDITOR_UNAVAILABLE');
    await status('PagePoster · Натискаємо «Опублікувати» у WordPress');
    await navigate(target.href,{method:'POST',headers:{...(await cookieHeaders(target.href)),'content-type':'application/x-www-form-urlencoded'},body:data.body,nativeForm:true,beforeSend:()=>{if(beforeSend)beforeSend();nativeDispatched=true;}});
    let result;try{result=JSON.parse(await page.locator('#pageposter-operation-result').textContent());}catch{throw Object.assign(Error('BROWSER_PUBLICATION_UNCERTAIN'),{code:'BROWSER_PUBLICATION_UNCERTAIN',uncertain:true});}
    if(!Number.isInteger(result.status)||!result.data)throw Object.assign(Error('BROWSER_PUBLICATION_UNCERTAIN'),{code:'BROWSER_PUBLICATION_UNCERTAIN',uncertain:true});
    return {status:result.status,text:JSON.stringify(result.data),url:address,headers:{'content-type':'application/json'}};
    }catch(error){if(!nativeDispatched)error.writeNotAttempted=true;if(!error.code)error.code=nativeDispatched?'BROWSER_PUBLICATION_UNCERTAIN':'BROWSER_EDITOR_UNAVAILABLE';throw error;}
   },
   result:async url=>{await status('PagePoster · Сторінку опубліковано. Перевіряємо результат.');await navigate(same(url).href,{headers:await cookieHeaders(url)});},
   focus:async()=>{assertOpen();await page.bringToFront();},
   close:async()=>{closed=true;await browser.close().catch(()=>{});}
  };sessions.set(id,session);if(!base)await page.setContent('<!doctype html><meta charset="utf-8"><title>PagePoster — приватна публікація</title><main style="font:18px/1.6 Arial;max-width:700px;margin:80px auto;padding:30px"><h1>Підготовка публікації</h1><p>Підбираємо донора й відкриваємо WordPress. У цьому приватному вікні буде видно весь процес.</p></main>');await status(message);await page.bringToFront();return session;
 }
 return {open,prepare:(id,options)=>open(id,null,options),publish:async(id,input)=>{const session=sessions.get(id);if(!session)fail('BROWSER_NOT_OPEN');return session.publish(input);},assertOpen:id=>{const session=sessions.get(id);if(!session)fail('BROWSER_NOT_OPEN');session.assertOpen();},focus:async id=>{const session=sessions.get(id);if(!session)fail('BROWSER_NOT_OPEN');await session.focus();},done:async id=>sessions.get(id)?.status('PagePoster · Готово. Сторінку опубліковано й перевірено.'),error:async(id,code)=>sessions.get(id)?.status('PagePoster · Зупинено: '+(/^[A-Z_a-z]{1,80}$/.test(code||'')?code:'помилка')+'. Подробиці й продовження — у PagePoster.'),result:async(id,url)=>sessions.get(id)?.result(url),reset:async id=>{await sessions.get(id)?.close();sessions.delete(id);},close:async()=>{await Promise.all([...sessions.values()].map(session=>session.close()));sessions.clear();}};
}
