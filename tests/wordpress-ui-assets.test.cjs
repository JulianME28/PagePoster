const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const chrome=require('./browser-runtime.cjs').chromePath;

// The actual private browser and production route handler run against an
// injected HTTPS boundary. No request reaches a donor or a real account.
async function fixture(t,{hook,resources=''}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');
 const calls=[],responses=[],failed=[];
 const transport=async(url,init={})=>{
  const target=new URL(url);calls.push({url,method:init.method,signal:init.signal,followRedirects:init.followRedirects});
  const reply=await hook?.(target,init);if(reply)return reply;
  if(target.pathname==='/wp-login.php')return {status:200,headers:{'content-type':'text/html'},text:'<!doctype html>'+resources+'<form id="loginform"><input name="log"><input name="pwd" type="password"><input id="wp-submit" type="submit"></form>'};
  return {status:404,headers:{'content-type':'text/plain'},text:'Missing fixture'};
 };
 const manager=createWordPressUI({chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());
 const session=await manager.open('assets','https://wp.example/');
 session.page.on('response',reply=>responses.push(reply));session.page.on('requestfailed',req=>failed.push(req.url()));
 return {manager,session,calls,responses,failed};
}

test('redirected admin script executes and stylesheet applies with their actual MIME and bytes',async t=>{
 const script=Buffer.from('window.redirectedEditorReady="exact-runtime";'),css=Buffer.from('#loginform { background-color: rgb(12, 34, 56); }');
 const f=await fixture(t,{resources:'<script src="/wp-includes/js/bootstrap.js?ver=1"></script><link rel="stylesheet" href="/wp-content/editor.css?ver=1">',hook:u=>{
  if(u.pathname==='/wp-includes/js/bootstrap.js')return {status:302,headers:{location:'./runtime.js?ver=1'},text:''};
  if(u.pathname==='/wp-includes/js/runtime.js')return {status:200,headers:{'content-type':'application/javascript','cache-control':'public, max-age=300'},body:script};
  if(u.pathname==='/wp-content/editor.css')return {status:307,headers:{location:'/wp-content/editor-final.css?ver=1'},text:''};
  if(u.pathname==='/wp-content/editor-final.css')return {status:200,headers:{'content-type':'text/css','cache-control':'public, max-age=300'},body:css};
 }});
 assert.equal(await f.session.page.evaluate(()=>window.redirectedEditorReady),'exact-runtime');
 assert.equal(await f.session.page.locator('#loginform').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(12, 34, 56)');
 assert.equal(f.calls.filter(x=>x.url.endsWith('/wp-includes/js/runtime.js?ver=1')).length,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith('/wp-content/editor-final.css?ver=1')).length,1);
 assert.ok(f.calls.every(x=>x.method==='GET'&&x.followRedirects===false&&x.signal instanceof AbortSignal));
 // Observe Chromium directly: Playwright does not emit a response object for
 // resources fulfilled through a separate Fetch interception session.
 const cdp=await f.session.page.context().newCDPSession(f.session.page),received=[];t.after(()=>cdp.detach().catch(()=>{}));
 cdp.on('Network.responseReceived',event=>received.push(event));await cdp.send('Network.enable');
 // Repeat uses the safe final-resource cache; redirect itself is still guarded.
 await f.session.page.reload({waitUntil:'load'});
 assert.equal(await f.session.page.evaluate(()=>window.redirectedEditorReady),'exact-runtime');
 assert.equal(f.calls.filter(x=>x.url.endsWith('/wp-includes/js/runtime.js?ver=1')).length,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith('/wp-content/editor-final.css?ver=1')).length,1);
 const delivered=received.find(x=>x.response.url.endsWith('/wp-includes/js/runtime.js?ver=1'));
 assert.equal(delivered.response.status,200);assert.equal(delivered.response.mimeType,'application/javascript');
 const deliveredBody=await cdp.send('Network.getResponseBody',{requestId:delivered.requestId});
 assert.deepEqual(Buffer.from(deliveredBody.body,deliveredBody.base64Encoded?'base64':'utf8'),script);
});

test('all guarded GET redirect statuses preserve exact target query and enforce the five-hop bound',async t=>{
 const f=await fixture(t,{resources:'<script src="/wp-includes/js/hop0.js"></script>',hook:u=>{
  const hop=Number(u.pathname.match(/hop(\d+)\.js$/)?.[1]);
  if(Number.isInteger(hop))return {status:[301,302,303,307,308][hop%5],headers:{location:'hop'+(hop+1)+'.js?ver=exact%2Fvalue%2b'},text:''};
 }});
 assert.deepEqual(f.calls.filter(x=>x.url.includes('/hop')).map(x=>new URL(x.url).pathname),[0,1,2,3,4,5].map(x=>'/wp-includes/js/hop'+x+'.js'));
 assert.ok(f.calls.filter(x=>x.url.includes('/hop')&&!x.url.includes('hop0')).every(x=>x.url.endsWith('?ver=exact%2Fvalue%2b')));
 assert.ok(f.calls.every(x=>x.method==='GET'));
});

test('static redirect loops stop before requesting a visited URL again',async t=>{
 const f=await fixture(t,{resources:'<script src="/wp-includes/js/a.js"></script>',hook:u=>{
  if(u.pathname.endsWith('/a.js'))return {status:302,headers:{location:'b.js'},text:''};
  if(u.pathname.endsWith('/b.js'))return {status:302,headers:{location:'a.js'},text:''};
 }});
 assert.deepEqual(f.calls.filter(x=>/\/[ab]\.js$/.test(x.url)).map(x=>x.url),['https://wp.example/wp-includes/js/a.js','https://wp.example/wp-includes/js/b.js']);
});

test('redirected modules and styles retain their final URL for relative dependencies',async t=>{
 const f=await fixture(t,{resources:'<script type="module" src="/wp-includes/js/start.js"></script><link rel="stylesheet" href="/wp-content/start.css">',hook:u=>{
  if(u.pathname==='/wp-includes/js/start.js')return {status:302,headers:{location:'nested/final.js'},text:''};
  if(u.pathname==='/wp-includes/js/nested/final.js')return {status:200,headers:{'content-type':'application/javascript','cache-control':'public, max-age=300'},text:'import {ready} from "./dependency.js";window.redirectDependency=ready;window.redirectModuleUrl=import.meta.url;'};
  if(u.pathname==='/wp-includes/js/nested/dependency.js')return {status:200,headers:{'content-type':'application/javascript','cache-control':'public, max-age=300'},text:'export const ready="nested-ready";'};
  if(u.pathname==='/wp-content/start.css')return {status:302,headers:{location:'theme/final.css'},text:''};
  if(u.pathname==='/wp-content/theme/final.css')return {status:200,headers:{'content-type':'text/css','cache-control':'public, max-age=300'},text:'@import "./nested.css";#loginform{background-image:url("./icon.png")}'};
  if(u.pathname==='/wp-content/theme/nested.css')return {status:200,headers:{'content-type':'text/css','cache-control':'public, max-age=300'},text:'#loginform{color:rgb(12,34,56)}'};
  if(u.pathname==='/wp-content/theme/icon.png')return {status:200,headers:{'content-type':'image/png'},body:Buffer.alloc(0)};
 }});
 await f.session.page.waitForLoadState('load');
 assert.equal(await f.session.page.evaluate(()=>window.redirectDependency),'nested-ready');
 assert.equal(await f.session.page.evaluate(()=>window.redirectModuleUrl),'https://wp.example/wp-includes/js/nested/final.js');
 assert.equal(await f.session.page.locator('#loginform').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
 assert.ok(f.calls.some(x=>x.url==='https://wp.example/wp-content/theme/icon.png'));
 assert.equal(f.calls.filter(x=>['/wp-includes/js/dependency.js','/wp-content/nested.css','/wp-content/icon.png'].includes(new URL(x.url).pathname)).length,0);
 await f.session.page.reload({waitUntil:'load'});
 assert.equal(await f.session.page.evaluate(()=>window.redirectDependency),'nested-ready');
 assert.equal(await f.session.page.evaluate(()=>window.redirectModuleUrl),'https://wp.example/wp-includes/js/nested/final.js');
 assert.equal(await f.session.page.locator('#loginform').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
 for(const suffix of ['/wp-includes/js/nested/final.js','/wp-includes/js/nested/dependency.js','/wp-content/theme/final.css','/wp-content/theme/nested.css'])assert.equal(f.calls.filter(x=>x.url.endsWith(suffix)).length,1);
});

test('redirect response cookies are available to the next guarded static GET',async t=>{
 const f=await fixture(t,{resources:'<script src="/wp-includes/js/cookie.js"></script>',hook:(u,init)=>{
  if(u.pathname.endsWith('/cookie.js'))return {status:302,headers:{location:'cookie-final.js','set-cookie':['asset_fixture=allowed; Path=/wp-includes/; Secure; HttpOnly']},text:''};
  if(u.pathname.endsWith('/cookie-final.js'))return {status:200,headers:{'content-type':'application/javascript'},text:/asset_fixture=allowed/.test(init.headers?.cookie||'')?'window.assetCookieReady=true;':''};
 }});
 assert.equal(await f.session.page.evaluate(()=>window.assetCookieReady),true);
});

test('resource redirects never dispatch cross-origin, private, admin-write, malformed or wrong-kind targets',async t=>{
 const targets=['https://other.example/wp-includes/runtime.js','https://127.0.0.1/runtime.js','/wp-admin/post-new.php?post_type=page','/wp-admin/post.php?post=71&action=trash&_wpnonce=secret','bad\\path.js','/wp-content/runtime.css','/wp-includes/runtime.js?action=activate'];
 const f=await fixture(t,{resources:targets.map((_,i)=>'<script src="/wp-includes/js/unsafe'+i+'.js"></script>').join(''),hook:u=>{
  const index=u.pathname.match(/unsafe(\d+)\.js$/)?.[1];if(index!==undefined)return {status:302,headers:{location:targets[Number(index)]},text:''};
 }});
 // Chromium may re-request an aborted speculative preload when its parser
 // reaches that tag. Every such attempt must still stop before the bad target.
 assert.ok(f.calls.every(x=>x.url==='https://wp.example/wp-login.php'||/\/unsafe\d+\.js$/.test(x.url)));
 for(let i=0;i<targets.length;i++)assert.ok(f.calls.some(x=>x.url==='https://wp.example/wp-includes/js/unsafe'+i+'.js'));
});

test('a static redirect chain has one cumulative response-byte budget',async t=>{
 const oversized=Buffer.alloc(3*1024*1024,32);
 const f=await fixture(t,{resources:'<script src="/wp-includes/js/large.js"></script>',hook:u=>{
  if(u.pathname.endsWith('/large.js'))return {status:302,headers:{location:'large-next.js'},body:oversized};
  if(u.pathname.endsWith('/large-next.js'))return {status:302,headers:{location:'must-not-run.js'},body:oversized};
  if(u.pathname.endsWith('/must-not-run.js'))return {status:200,headers:{'content-type':'application/javascript'},text:'window.oversizedRan=true;'};
 }});
 assert.equal(await f.session.page.evaluate(()=>window.oversizedRan),undefined);
 assert.equal(f.calls.filter(x=>x.url.endsWith('/must-not-run.js')).length,0);
});

test('closing a session during an asset redirect cancels the chain before its next GET',async t=>{
 let entered,release;const pending=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{hook:async u=>{
  if(u.pathname.endsWith('/pending.js')){entered();await held;return {status:302,headers:{location:'never.js'},text:''};}
  if(u.pathname.endsWith('/never.js'))return {status:200,headers:{'content-type':'application/javascript'},text:'window.cancelledRan=true;'};
 }});
 const appended=f.session.page.evaluate(()=>{const script=document.createElement('script');script.src='/wp-includes/js/pending.js';document.head.append(script);}).catch(()=>{});
 await pending;await f.session.close();release();await appended;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(x=>x.url.endsWith('/never.js')).length,0);assert.equal(f.calls.find(x=>x.url.endsWith('/pending.js')).signal.aborted,true);
});
