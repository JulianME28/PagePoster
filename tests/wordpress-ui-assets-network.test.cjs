'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const origin='https://wp.example';
const login='<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input type="submit"></form>';

// Exercise the real browser route handler and safe transport. Only the DNS and
// HTTPS socket constructors are replaced; Chromium itself cannot use the net.
async function fixture(t,{resources='',lookup,reply}={}){
 const {createSafeTransport}=await import('../server/lifecycle/network.mjs');
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');
 const calls=[],resolutions=[],failures=[],events=[];
 const transport=createSafeTransport({allowWrites:true,lookup:async(host,options)=>{
  const addresses=await (lookup?lookup(host,options):[{address:'93.184.216.'+(34+resolutions.length),family:4}]);
  const resolution={host,options,addresses};resolutions.push(resolution);events.push({kind:'dns',resolution});return addresses;
 },request:(address,options,receive)=>{
  const url=new URL(address),call={url:url.href,options,resolution:resolutions.at(-1)};
  // Emulate the TLS socket consulting its supplied lookup in both Node forms.
  // Repeated socket lookup calls must use the approved pin, not resolve again.
  options.lookup(url.hostname,{},(error,ip,family)=>{call.pinned={error,address:ip,family};});
  options.lookup(url.hostname,{all:true},(error,addresses)=>{call.allPinned={error,addresses};});
  calls.push(call);events.push({kind:'socket',call});
  const request=new EventEmitter();
  request.destroy=error=>{call.destroyed=true;if(error)queueMicrotask(()=>request.emit('error',error));};
  request.end=body=>{
   call.body=body===undefined?undefined:Buffer.from(body);
   queueMicrotask(async()=>{
    try{
     const response=await reply?.(url,options,call)||(
      url.pathname==='/wp-login.php'?{status:200,headers:{'content-type':'text/html; charset=utf-8'},body:'<!doctype html>'+resources+login}:
      {status:404,headers:{'content-type':'text/plain'},body:'Missing fixture'});
     // A delayed response may still arrive after cancellation. The production
     // transport/session must discard it rather than trust the fake boundary.
     const incoming=new PassThrough();incoming.statusCode=response.status||200;incoming.headers=response.headers||{};
     receive(incoming);incoming.end(response.body||'');
    }catch(error){request.emit('error',error);}
   });
   return request;
  };
  return request;
 }});
 const observed=async(url,options)=>{try{return await transport(url,options);}catch(error){failures.push({url,code:error.code});throw error;}};
 const manager=createWordPressUI({chromium,executablePath,headless:true,transport:observed});t.after(()=>manager.close());
 const session=await manager.open('network-assets',origin+'/');
 return {manager,session,calls,resolutions,failures,events};
}

test('each redirected script and stylesheet GET resolves DNS anew and pins the approved address to its socket',{timeout:30000},async t=>{
 for(const [extension,resource,mime,body] of [
  ['js','<script src="/wp-includes/js/start.js"></script>','application/javascript','window.pinnedAssetReady=true;'],
  ['css','<link rel="stylesheet" href="/wp-content/start.css">','text/css','#loginform{color:rgb(12,34,56)}']
 ])await t.test(extension,async t=>{
  const directory=extension==='js'?'/wp-includes/js/':'/wp-content/';
  const f=await fixture(t,{resources:resource,reply:url=>{
   if(url.pathname===directory+'start.'+extension)return {status:302,headers:{location:'final.'+extension+'?ver=exact%2F'},body:''};
   if(url.pathname===directory+'final.'+extension)return {status:200,headers:{'content-type':mime},body};
  }});
  if(extension==='js')assert.equal(await f.session.page.evaluate(()=>window.pinnedAssetReady),true);
  else assert.equal(await f.session.page.locator('#loginform').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
  const assets=f.calls.filter(call=>new URL(call.url).pathname.startsWith(directory));
  assert.deepEqual(assets.map(call=>call.url),[origin+directory+'start.'+extension,origin+directory+'final.'+extension+'?ver=exact%2F']);
  assert.notEqual(assets[0].resolution,assets[1].resolution,'The final browser redirect must cross a fresh DNS check');
  assert.notEqual(assets[0].pinned.address,assets[1].pinned.address,'The final socket uses its own newly approved address');
  for(const call of assets){
   assert.equal(call.options.method,'GET');assert.equal(call.body,undefined);
   assert.equal(call.options.agent,false);assert.equal(call.options.rejectUnauthorized,true);assert.equal(call.options.autoSelectFamily,false);
   assert.deepEqual(call.resolution.options,{all:true,verbatim:true});
   assert.deepEqual(call.pinned,{error:null,...call.resolution.addresses[0]});
   assert.deepEqual(call.allPinned,{error:null,addresses:[call.resolution.addresses[0]]});
   const socketIndex=f.events.findIndex(event=>event.call===call);
   assert.ok(f.events.findIndex(event=>event.resolution===call.resolution)<socketIndex,'DNS validation precedes each HTTPS socket');
  }
  assert.equal(f.resolutions.length,f.calls.length,'Socket lookup callbacks must not trigger additional DNS resolution');
  assert.deepEqual(f.failures,[]);
 });
});

test('a redirected asset with private or mixed final-hop DNS is blocked before a second asset socket opens',{timeout:30000},async t=>{
 for(const [name,addresses] of [
  ['private',[{address:'10.0.0.7',family:4}]],
  ['mixed',[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]]
 ])await t.test(name,async t=>{
  let redirected=false;
  const f=await fixture(t,{resources:'<script src="/wp-includes/js/start.js"></script>',lookup:async()=>redirected?addresses:[{address:'93.184.216.34',family:4}],reply:url=>{
   if(url.pathname==='/wp-includes/js/start.js'){redirected=true;return {status:302,headers:{location:'blocked.js'},body:''};}
   if(url.pathname==='/wp-includes/js/blocked.js')return {status:200,headers:{'content-type':'application/javascript'},body:'window.privateAssetRan=true;'};
  }});
  assert.equal(await f.session.page.locator('#loginform').count(),1,'A blocked asset does not replace the useful login document');
  assert.equal(await f.session.page.evaluate(()=>window.privateAssetRan),undefined);
  assert.equal(f.calls.filter(call=>call.url===origin+'/wp-includes/js/start.js').length,1);
  assert.equal(f.calls.filter(call=>call.url===origin+'/wp-includes/js/blocked.js').length,0,'Unsafe DNS is rejected before the final HTTPS request constructor');
  assert.ok(f.resolutions.some(resolution=>resolution.addresses===addresses),'The final hop was actually resolved');
  assert.deepEqual(f.failures.filter(error=>error.url===origin+'/wp-includes/js/blocked.js'),[{url:origin+'/wp-includes/js/blocked.js',code:'unsafe_address'}]);
 });
});

test('POST login redirects cannot replay the submitted credentials through the static asset redirect path',{timeout:30000},async t=>{
 for(const status of [307,308])await t.test(String(status),async t=>{
  const f=await fixture(t,{reply:(url,options)=>{
   if(url.pathname==='/wp-login.php'&&options.method==='POST')return {status,headers:{location:'/wp-includes/js/replay.js'},body:''};
   if(url.pathname==='/wp-includes/js/replay.js')return {status:200,headers:{'content-type':'application/javascript'},body:'window.replayedWrite=true;'};
  }});
  f.session.page.setDefaultTimeout(1500);
  await assert.rejects(f.session.login({username:'fixture-admin',applicationPassword:'fixture-secret'}),{code:'BROWSER_ORIGIN_BLOCKED'});
  const writes=f.calls.filter(call=>call.options.method==='POST');assert.equal(writes.length,1);
  assert.equal(writes[0].url,origin+'/wp-login.php');
  const fields=new URLSearchParams(writes[0].body.toString());assert.equal(fields.get('log'),'fixture-admin');assert.equal(fields.get('pwd'),'fixture-secret');
  assert.equal(f.calls.filter(call=>call.url===origin+'/wp-includes/js/replay.js').length,0,'Neither a GET nor POST is sent to the redirect destination');
 });
});

test('switching accounts cancels an old redirected asset before its late body or cookies can enter the new account',{timeout:30000},async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),held=new Promise(resolve=>release=resolve);
 t.after(()=>release());
 const f=await fixture(t,{reply:async url=>{
  if(url.pathname==='/wp-includes/js/old.js')return {status:302,headers:{location:'held.js'},body:''};
  if(url.pathname==='/wp-includes/js/held.js'){
   enter();await held;return {status:200,headers:{'content-type':'application/javascript','set-cookie':['stale_account=old; Path=/; Secure; HttpOnly']},body:'window.staleAccountBodyRan=true;'};
  }
 }});
 await f.session.page.context().addCookies([{name:'fixture_account',value:'old',url:origin+'/'}]);
 await f.session.page.evaluate(()=>{const script=document.createElement('script');script.src='/wp-includes/js/old.js';document.head.append(script);});
 await entered;
 const old=f.calls.find(call=>call.url===origin+'/wp-includes/js/held.js');assert.match(old.options.headers.cookie,/fixture_account=old/);
 await f.manager.switchAccount('network-assets');
 await f.session.page.context().addCookies([{name:'fixture_account',value:'new',url:origin+'/'}]);
 release();await f.session.page.waitForLoadState('load');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(old.destroyed,true,'Account switch aborts the old HTTPS request');
 assert.equal(await f.session.page.evaluate(()=>window.staleAccountBodyRan),undefined);
 const cookies=await f.session.page.context().cookies(origin+'/');
 assert.deepEqual(cookies.map(cookie=>[cookie.name,cookie.value]),[['fixture_account','new']]);
 assert.equal(f.calls.filter(call=>call.url===origin+'/wp-includes/js/held.js').length,1,'An old redirect is not replayed for the new account');
 assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
});
