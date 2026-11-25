'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const cleaner='pageposter-clean-links/pageposter-clean-links.php';
const menu='<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul>';
const login='<form id="loginform" method="post" action="/wp-login.php"><input name="log"><input name="pwd" type="password"><input type="submit"></form>';
const html=text=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});

// Real Chromium and the production adapter; every request is fulfilled by this
// isolated in-memory transport, with external DNS blocked by the adapter.
async function fixture(t,{partialPluginRow=false,trailingNotice=false,version='1.1.3',transportHook}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');
 const calls=[];let noticeCompleted=false,releaseNotice;
 const noticePending=new Promise(resolve=>releaseNotice=resolve);t.after(()=>releaseNotice());
 const notice='<script src="/wp-content/plugin-row-notice.js"></script>';
 const transport=async(address,init={})=>{
  const url=new URL(address),method=init.method||'GET';calls.push({path:url.pathname,method});
  const intercepted=await transportHook?.(url,init);if(intercepted)return intercepted;
  if(url.pathname==='/wp-login.php')return method==='POST'?{status:302,headers:{location:'/wp-admin/plugins.php','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']},text:''}:html(login);
  if(url.pathname==='/wp-admin/plugins.php')return html(menu+'<table class="plugins"><tbody id="the-list"><tr data-plugin="'+cleaner+'" class="active"><td>'+(partialPluginRow?notice:'')+(version?'<div class="plugin-version-author-uri">Version '+version+' | PagePoster</div>':'')+'</td></tr></tbody></table><div class="tablenav bottom"></div>'+(trailingNotice?notice:''));
  if(url.pathname==='/wp-content/plugin-row-notice.js'){
   await noticePending;noticeCompleted=true;
   return {status:200,headers:{'content-type':'application/javascript'},text:''};
  }
  assert.fail('Unexpected synthetic request '+method+' '+url.pathname);
 };
 const manager=createWordPressUI({chromium,executablePath,headless:true,transport});t.after(()=>manager.close());
 const session=await manager.open('adapter-regression','https://wp.example/');
 await session.login({username:'fixture-admin',applicationPassword:'fixture-password'});
 return {session,calls,releaseNotice,get noticeCompleted(){return noticeCompleted;}};
}

test('login landing on a partially parsed active cleaner row waits for its version before declaring incompatibility',async t=>{
 const f=await fixture(t,{partialPluginRow:true});
 assert.equal(await f.session.page.locator('tr[data-plugin="'+cleaner+'"]').count(),1);
 assert.equal(f.noticeCompleted,false,'the login/admin controls are ready before the trailing version is parsed');
 const ready=f.session.ensureCleanLinks();ready.catch(()=>{});
 setTimeout(f.releaseNotice,200);
 assert.deepEqual(await ready,{name:'PagePoster Clean Links',active:true});
 assert.equal(f.calls.some(call=>['/wp-admin/plugin-install.php','/wp-admin/update.php'].includes(call.path)),false);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1,'only the login form was submitted');
});

test('a complete active cleaner row remains ready while an unrelated trailing script is held',async t=>{
 const f=await fixture(t,{trailingNotice:true});
 assert.deepEqual(await f.session.ensureCleanLinks(),{name:'PagePoster Clean Links',active:true});
 assert.equal(f.noticeCompleted,false);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

for(const version of ['1.1.4',null])test('a parsed active cleaner row with '+(version?'incompatible version':'missing version')+' still stops before any plugin or page write',async t=>{
 const f=await fixture(t,{version});
 await assert.rejects(f.session.ensureCleanLinks(),{code:'CLEAN_LINKS_UPDATE_REQUIRED'});
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 assert.equal(f.calls.every(call=>['/wp-login.php','/wp-admin/plugins.php'].includes(call.path)),true);
});

async function failedSaveFixture(t,{persisted}){
 const title='Initial publication response check',content='<p>Exact approved HTML</p>',checkpoints=[],events=[];
 let creates=0,publishes=0,sends=0,saved=false;
 const esc=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const editor=()=>html(menu+'<form id="post" action="/wp-admin/post.php" method="post"><input id="title" name="post_title" value="'+(saved?esc(title):'')+'"><textarea id="content" name="content">'+(saved?esc(content):'')+'</textarea><input id="post_ID" name="post_ID" value="71"><input name="post_type" value="page"><input name="action" value="editpost"><input id="original_post_status" value="'+(saved?'publish':'auto-draft')+'"><button id="publish" name="publish" value="Publish">Publish</button></form>'+(saved?'<a id="sample-permalink" href="https://wp.example/published/">View</a>':''));
 const f=await fixture(t,{transportHook:(url,init)=>{
  if(url.pathname==='/wp-admin/edit.php')return html(menu+'<a class="page-title-action" href="/wp-admin/post-new.php?post_type=page">Add New Page</a>');
  if(url.pathname==='/wp-admin/post-new.php'){creates++;return editor();}
  if(url.pathname==='/wp-admin/post.php'){
   if(init.method==='POST'){
    const fields=new URLSearchParams(init.body.toString());assert.equal(fields.get('post_ID'),'71');assert.equal(fields.get('post_title'),title);assert.equal(fields.get('content'),content);
    publishes++;saved=persisted;
    return {...html('<div class="wp-die-message">Synthetic upstream save response</div>'),status:503};
   }
   assert.equal(url.searchParams.get('post'),'71');assert.equal(url.searchParams.get('action'),'edit');return editor();
  }
 }});
 return {...f,checkpoints,events,input:{title,html:content,checkpoint:async value=>checkpoints.push(value),beforeSend:()=>sends++,observe:event=>events.push(event)},get counts(){return {creates,publishes,sends};}};
}

test('a persisted initial Publish with HTTP 503 succeeds only after exact-ID editor verification',async t=>{
 const f=await failedSaveFixture(t,{persisted:true}),result=await f.session.publishPage(f.input);
 assert.equal(result.postId,71);assert.equal(result.status,'publish');assert.equal(result.content,f.input.html);assert.equal(result.url,'https://wp.example/published/');
 assert.equal(f.checkpoints.at(-1).phase,'published');assert.deepEqual(f.counts,{creates:1,publishes:1,sends:1});
 const send=f.events.find(event=>event.kind==='phase'&&event.phase==='send'&&event.state==='end');assert.equal(send.httpStatus,503);assert.equal(send.code,'network_failed');
});

test('an unpersisted initial Publish with HTTP 503 remains uncertain and never creates or sends again on reconciliation',async t=>{
 const f=await failedSaveFixture(t,{persisted:false});
 await assert.rejects(f.session.publishPage(f.input),error=>error.code==='NATIVE_NOT_PUBLISHED'&&error.uncertain===true&&!error.writeNotAttempted);
 assert.equal(f.checkpoints.at(-1).phase,'dispatching');assert.equal(f.checkpoints.some(value=>value.phase==='published'),false);
 await assert.rejects(f.session.publishPage({...f.input,saved:{postId:71,phase:'dispatching'}}),{code:'NATIVE_NOT_PUBLISHED'});
 assert.deepEqual(f.counts,{creates:1,publishes:1,sends:1});
});
