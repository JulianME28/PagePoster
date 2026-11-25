const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const chrome=require('./browser-runtime.cjs').chromePath;
test('Classic publication submits the requested slug and detects a WordPress permalink mismatch',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.session.publishPage({...f.input,slug:'requested-slug'}),{code:'NATIVE_SLUG_MISMATCH',uncertain:true});
 const post=f.calls.find(call=>call.method==='POST'&&new URL(call.url).pathname==='/wp-admin/post.php');
 assert.deepEqual(new URLSearchParams(post.body.toString()).getAll('post_name'),['requested-slug']);
 assert.equal(f.counts.publishes,1);
 assert.equal(f.checkpoints.at(-1).phase,'dispatching');
});
test('Classic publication confirms a requested slug that matches the saved permalink',async t=>{
 const f=await fixture(t),result=await f.session.publishPage({...f.input,slug:'example-page'});
 assert.equal(result.url,'https://wp.example/example-page/');
 const post=f.calls.find(call=>call.method==='POST'&&new URL(call.url).pathname==='/wp-admin/post.php');
 assert.deepEqual(new URLSearchParams(post.body.toString()).getAll('post_name'),['example-page']);
 assert.equal(f.checkpoints.at(-1).phase,'published');
});
test('Gutenberg publication sends the exact requested slug in the reviewed write',async t=>{
 const f=await fixture(t,{block:true}),result=await f.session.publishPage({...f.input,slug:'example-page'});
 assert.equal(result.url,'https://wp.example/example-page/');
 const write=f.calls.find(call=>call.method==='POST'&&new URL(call.url).pathname==='/wp-json/wp/v2/pages/71');
 assert.equal(JSON.parse(write.body.toString()).slug,'example-page');
 assert.equal(f.checkpoints.at(-1).phase,'published');
});
test('native timing observes actual send status and separate create/editor spans; observer errors do not change outcome',async t=>{
 const f=await fixture(t),events=[];const result=await f.session.publishPage({...f.input,observe:event=>{events.push(event);if(event.kind==='network')throw Error('observer failure');}});
 assert.equal(result.status,'publish');for(const phase of ['create','editor','send','reconcile'])assert.ok(events.some(e=>e.kind==='phase'&&e.phase===phase&&e.state==='end'&&Number.isInteger(e.elapsedMs)),phase);
 const send=events.find(e=>e.kind==='phase'&&e.phase==='send'&&e.state==='end');assert.equal(send.httpStatus,302);assert.equal(send.method,'POST');assert.ok(events.some(e=>e.kind==='network'&&e.networkMs>=0&&e.queueMs>=0&&e.httpStatus===302));assert.doesNotMatch(JSON.stringify(events),/wp\.example|fixture-secret|_wpnonce|<form/);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('native timing records the actual failed write response and never substitutes its synthetic 502',async t=>{
 const f=await fixture(t,{transportHook:(u,init)=>u.pathname==='/wp-admin/post.php'&&init.method==='POST'?{status:503,headers:{'content-type':'text/html'},text:'private provider details'}:null}),events=[];
 await assert.rejects(f.session.publishPage({...f.input,observe:e=>events.push(e)}));const send=events.find(e=>e.kind==='phase'&&e.phase==='send'&&e.state==='end');assert.equal(send.httpStatus,503);assert.equal(send.code,'network_failed');assert.doesNotMatch(JSON.stringify(events),/private provider|wp\.example/);assert.equal(events.some(e=>e.httpStatus===502),false);
});
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
async function fixture(t,{installed=true,enabled=installed,lost=false,sanitize=false,block=false,email=false,version='1.1.3',adminMissing=false,pluginDenied=false,pluginBroken=false,loginReject=false,uploadBusy=false,signIn=true,loginFailureOnce=false,newPageHref='post-new.php?post_type=page',assetBootstrap=false,blankEditor=false,editorDelay=0,postNewDelay=0,postNewLost=false,modernTitle=false,loginAlias=null,loginRedirect=false,installationPath='',initialBase='https://wp.example/',deferLoginSubmit=false,lateLoginReset=false,transportHook}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');
 const calls=[],checkpoints=[];let active=enabled,post=null,newPages=0,publishes=0,guarded=0,releaseNotice,loginPosts=0;
 const noticePending=new Promise(resolve=>releaseNotice=resolve);t.after(()=>releaseNotice());
 const html=(text,extra={})=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+(assetBootstrap?'<script src="/wp-includes/js/runtime.js?ver=1"></script>':'')+(installationPath?text.replaceAll('"/wp-','"'+installationPath+'/wp-').replaceAll('https://wp.example/','https://'+(loginAlias||'wp.example')+'/'):text),...extra});
 const redirect=location=>({status:302,headers:{location:installationPath&&location.startsWith('/wp-')?installationPath+location:location},text:''});
 const menu='<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Oldalak</a></li></ul>';
 const loginForm='<form id="loginform" action="'+(loginAlias?'https://'+loginAlias+'/wp-login.php':'/wp-login.php')+'" method="post"><input name="log" required><input name="pwd" type="password" required><input name="redirect_to" type="hidden" value="/wp-admin/"><input type="submit" id="wp-submit"></form>'+(deferLoginSubmit?'<script>document.querySelector("#loginform").addEventListener("submit",event=>{event.preventDefault();const form=event.target;setTimeout(()=>HTMLFormElement.prototype.submit.call(form),150);});</script>':'');
 const transport=async(url,init={})=>{
  const u=new URL(url),method=init.method||'GET';calls.push({url,method,body:init.body,referer:init.headers?.referer});
  const intercepted=await transportHook?.(u,init);if(intercepted)return intercepted;
  if(installationPath&&method==='GET'&&u.pathname==='/wp-login.php'&&u.hostname===loginAlias)return redirect(installationPath+'/wp-login.php');
  if(installationPath&&u.pathname.startsWith(installationPath+'/'))u.pathname=u.pathname.slice(installationPath.length);
  if(u.pathname==='/wp-includes/js/editor-delay.js'){await new Promise(resolve=>setTimeout(resolve,editorDelay));return {status:200,headers:{'content-type':'application/javascript'},text:'window.editorAssetsLoaded=true;'};}
  if(u.pathname==='/slow-plugin-notice.png'){await noticePending;return {status:200,headers:{'content-type':'image/png'},body:Buffer.alloc(0)};}
  if(u.pathname==='/wp-includes/js/runtime.js')return {status:200,headers:{'content-type':'application/javascript','cache-control':'public, max-age=300'},text:'window.fixtureCore=true;'};
  assert.ok(!/pageposter\/v1|application-passwords|pageposter-bridge/.test(url));
  if(u.pathname==='/wp-login.php'){
   if(loginRedirect&&method==='GET'&&u.hostname==='wp.example')return redirect('https://'+loginAlias+'/wp-login.php');
   if(method==='POST'){loginPosts++;if(loginReject||loginFailureOnce&&loginPosts===1)return html('<div id="login_error">Incorrect password</div>'+loginForm+(lateLoginReset?'<script>document.querySelector("#wp-submit").disabled=true;setTimeout(()=>{document.querySelector("[name=pwd]").value="";document.querySelector("#wp-submit").disabled=false;},250);</script>':''));}
   if(u.searchParams.has('remind_me_later'))return redirect('/wp-admin/');
   if(u.searchParams.get('action')==='confirm_admin_email')return html('<form class="admin-email-confirm-form"></form><a href="/wp-login.php?action=confirm_admin_email&remind_me_later=validnonce">Remind me later</a>');
   return method==='POST'?{...redirect('/wp-admin/'),'headers':{location:email?'/wp-login.php?action=confirm_admin_email':new URLSearchParams(init.body.toString()).get('redirect_to')||'/wp-admin/','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']}}:html(loginForm);
  }
  if(u.pathname==='/wp-admin/')return adminMissing?{status:404,headers:{'content-type':'text/html'},text:'Not found'}:html(menu);
  if(u.pathname==='/wp-admin/edit.php'){assert.equal(u.searchParams.get('post_type'),'page');return html(menu+'<h1>Oldalak <a class="page-title-action" href="'+esc(newPageHref)+'">Oldal hozzáadása</a></h1><table id="the-list"></table>');}
  if(u.pathname==='/wp-admin/plugins.php'){
   if(pluginDenied==='generic')return html('<div class="wp-die-message">Sorry, you are not allowed to access this page.</div>',{status:403});
   if(u.searchParams.get('action')==='activate'){assert.equal(u.searchParams.get('plugin'),'pageposter-clean-links/pageposter-clean-links.php');active=true;return redirect('/wp-admin/plugins.php');}
   return html(menu+'<table><tr data-plugin="unrelated/unrelated.php" class="active"><td>Other plugin</td></tr>'+(installed?'<tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="'+(active?'active':'inactive')+'"><td>PagePoster Clean Links '+(version?'<div class="plugin-version-author-uri">Version '+version+' | PagePoster</div>':'')+(active?'':'<a href="plugins.php?action=activate&plugin=pageposter-clean-links%2Fpageposter-clean-links.php&_wpnonce=fixture">Activate</a>')+'</td></tr>':'')+'</table>');
  }
  if(u.pathname==='/wp-admin/plugin-install.php')return pluginBroken?html('<div class="wp-die-message">'+(pluginBroken===403?'The link you followed has expired.':'There has been a critical error on this website.')+'</div>',{status:pluginBroken===403?403:500}):pluginDenied?html('<div class="wp-die-message">Sorry, you are not allowed to install plugins on this site.</div>',{status:403}):html('<form action="update.php?action=upload-plugin" method="post" enctype="multipart/form-data"><input name="_wpnonce" value="fixture"><input type="file" name="pluginzip"><input type="submit" value="Install Now"></form>');
  if(u.pathname==='/wp-admin/update.php'){
   if(u.searchParams.get('overwrite')==='update-plugin'){assert.equal(method,'GET');version='1.1.3';return html('Updated');}
   assert.equal(method,'POST');assert.match(Buffer.from(init.body).toString('latin1'),/pageposter-clean-links-1\.1\.3.zip/);assert.doesNotMatch(Buffer.from(init.body).toString('latin1'),/pageposter-bridge/);
   if(installed&&version!=='1.1.3')return html((uploadBusy==='script'?'<script src="/wp-content/upload-notice.js"></script>':'')+'<a class="update-from-upload-overwrite" href="update.php?action=upload-plugin&overwrite=update-plugin&package=pageposter-clean-links.zip&_wpnonce=fixture">Replace current with uploaded</a>');
   installed=true;version='1.1.3';return html((uploadBusy?'<aside class="notice"><img src="/slow-plugin-notice.png">Theme promotion</aside>':'')+'<a href="plugins.php?action=activate&plugin=pageposter-clean-links%2Fpageposter-clean-links.php&_wpnonce=fixture">Activate</a>');}
  if(u.pathname==='/wp-admin/post-new.php'){newPages++;post={id:71,title:'',content:'',status:'auto-draft'};if(postNewDelay)await new Promise(resolve=>setTimeout(resolve,postNewDelay));if(postNewLost)throw Object.assign(Error('lost creation response'),{code:'network_timeout'});const reply=editorReply();if(editorDelay)reply.text=reply.text.replace('<meta charset="utf-8">','<meta charset="utf-8"><script src="/wp-includes/js/editor-delay.js"></script>');return reply;}
  if(u.pathname==='/wp-admin/post.php'){
   if(method==='POST'){
    assert.equal(guarded,1);publishes++;const f=new URLSearchParams(init.body.toString());assert.equal(f.get('post_ID'),'71');assert.equal(f.get('action'),'editpost');assert.ok(f.has('publish'));post={id:71,title:f.get('post_title'),content:sanitize?'stripped':f.get('content'),status:'publish'};
    if(lost){lost=false;throw Error('Connection lost after save');}return redirect('/wp-admin/post.php?post=71&action=edit&message=6');
   }return editorReply();
  }
  if(u.pathname==='/wp-json/wp/v2/pages/71'&&method==='POST'){
   assert.equal(guarded,1);publishes++;const f=JSON.parse(init.body.toString());assert.equal(f.status,'publish');post={id:71,title:f.title,content:f.content,status:f.status};return {status:200,headers:{'content-type':'application/json'},text:JSON.stringify({...post,link:'https://wp.example/example-page/'})};
  }
  if(u.pathname==='/example-page/')return html(post.content);
  return {status:404,headers:{'content-type':'text/html'},text:'Not found'};
 };
 function editor(){if(blankEditor)return html('<div id="editor"></div><script id="wp-edit-post-js-after">wp.editPost.initializeEditor(\'editor\', "page", 71, {}, {});</script>');if(block)return html('<h1 class="editor-post-title__input" contenteditable="true">'+esc(post.title)+'</h1><textarea class="editor-post-text-editor" hidden>'+esc(post.content)+'</textarea><button class="editor-post-publish-panel__toggle">Publish</button><button class="editor-post-publish-button" hidden>Publish now</button><script>let current='+JSON.stringify({...post,link:'https://wp.example/example-page/'}).replaceAll('<','\\u003c')+';let slug;const title=document.querySelector("h1"),text=document.querySelector("textarea"),toggle=document.querySelector(".editor-post-publish-panel__toggle"),publish=document.querySelector(".editor-post-publish-button");window.wp={data:{select:()=>({getCurrentPostId:()=>71,getCurrentPost:()=>current,getEditedPostAttribute:()=>title.textContent,getEditedPostContent:()=>text.value}),dispatch:()=>({editPost:attributes=>{slug=attributes.slug;}})}};document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.shiftKey&&e.altKey&&e.key.toLowerCase()==="m"){e.preventDefault();text.hidden=false;}});toggle.onclick=()=>{toggle.hidden=true;publish.hidden=false;};publish.onclick=async()=>{current=await(await fetch("/wp-json/wp/v2/pages/71",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({title:title.textContent,content:text.value,...(slug?{slug}:{}),status:"publish"})})).json();};</script>');return html('<form id="post" action="post.php" method="post"><input id="title" name="post_title" value="'+esc(post.title)+'"><textarea id="content" name="content">'+esc(post.content)+'</textarea><input name="post_ID" id="post_ID" value="71"><input name="post_type" value="page"><input name="action" value="editpost"><input name="_wpnonce" value="fixture"><input id="original_post_status" value="'+post.status+'"><button id="publish" name="publish" value="Publish">Publish</button></form>'+(post.status==='publish'?'<a id="sample-permalink" href="https://wp.example/example-page/">View</a>':''));}
 function editorReply(){const reply=editor();if(modernTitle&&block)reply.text=reply.text.replace('<h1 class="editor-post-title__input" contenteditable="true">'+esc(post.title)+'</h1>','<div class="editor-post-title__input"><textarea class="components-textarea-control__input">'+esc(post.title)+'</textarea></div>').replace('const title=document.querySelector("h1")','const title=document.querySelector(".components-textarea-control__input")').replace('text=document.querySelector("textarea")','text=document.querySelector("textarea.editor-post-text-editor")').replaceAll('title.textContent','title.value');return reply;}
 const manager=createWordPressUI({chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());
 const session=await manager.open('run',initialBase);
 if(signIn&&!loginReject)await session.login({username:'admin',applicationPassword:'fixture-secret'});
 const input={title:'Casino guide',html:'<div id="pp-landing">Exact <b>HTML</b> & text</div>',checkpoint:async value=>checkpoints.push(value),beforeSend:()=>guarded++};
 return {manager,session,calls,checkpoints,input,repairEditor(){blankEditor=false;},reopen:()=>manager.open('run',initialBase),get counts(){return {newPages,publishes,guarded};}};
}
test('a reCAPTCHA badge without an interactive challenge does not block normal login',async t=>{
 const f=await fixture(t,{signIn:false});await f.session.page.evaluate(()=>{const badge=document.createElement('div');badge.className='grecaptcha-badge';badge.textContent='Protected by reCAPTCHA';document.body.append(badge);});
 await f.session.login({username:'admin',applicationPassword:'fixture-secret'});assert.equal(f.calls.filter(c=>c.method==='POST'&&new URL(c.url).pathname==='/wp-login.php').length,1);
});
test('a transient login document timeout retries only the read',async t=>{
 let reads=0;
 const f=await fixture(t,{transportHook:(url,init)=>{
  if(url.pathname==='/wp-login.php'&&init.method==='GET'&&++reads===1)throw Object.assign(Error('fixture timeout'),{code:'network_timeout'});
 }});
 assert.equal(reads,2);
 assert.equal(f.calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname==='/wp-login.php').length,1);
});
test('login checks the dashboard once after an HTTP 200 interstitial with a session cookie',async t=>{
 let adminReads=0;
 const f=await fixture(t,{signIn:false,transportHook:(url,init)=>{
  if(url.pathname==='/wp-login.php'&&init.method==='POST')return {status:200,headers:{'content-type':'text/html','set-cookie':'wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly'},text:'<!doctype html><p>Signed in</p>'};
  if(url.pathname==='/wp-admin/'){adminReads++;assert.match(init.headers.cookie,/wordpress_logged_in_fixture=ok/);}
 }});
 const login=f.session.login({username:'admin',applicationPassword:'fixture-secret'});
 await Promise.race([login,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Login waited instead of checking the dashboard')),3500);timer.unref();})]);
 assert.equal(adminReads,1);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 assert.equal(f.counts.newPages,0);
});
test('an HTTP 200 that returns the login form without rejection leaves the form for manual action',async t=>{
 const f=await fixture(t,{signIn:false,transportHook:(url,init)=>url.pathname==='/wp-login.php'&&init.method==='POST'?{
  status:200,headers:{'content-type':'text/html'},text:'<!doctype html><form id="loginform"><input name="log"><input name="pwd" type="password"></form>'
 }:null});
 await assert.rejects(Promise.race([f.session.login({username:'admin',applicationPassword:'fixture-secret'}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Login waited on the returned form')),3500);timer.unref();})]),{code:'BROWSER_LOGIN_REQUIRED'});
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 assert.equal(f.session.page.isClosed(),false);
});
test('an initial HTTP 500 retries the WordPress login document before sending credentials',async t=>{
 let reads=0;
 const f=await fixture(t,{transportHook:(url,init)=>{
  if(url.pathname==='/wp-login.php'&&init.method==='GET'&&++reads===1)return {status:500,headers:{'content-type':'text/html'},text:'Temporary error'};
 }});
 assert.equal(reads,2);
 assert.deepEqual(f.calls.filter(call=>new URL(call.url).pathname==='/wp-login.php').map(call=>call.method),['GET','GET','POST']);
});
test('a repeated HTTP 500 stops after two document reads and sends no credentials',async t=>{
 const methods=[];
 await assert.rejects(fixture(t,{transportHook:(url,init)=>{
  methods.push(init.method);
  assert.equal(url.pathname,'/wp-login.php');
  return {status:500,headers:{'content-type':'text/html'},text:'Temporary error'};
 }}),{code:'BROWSER_PAGE_UNAVAILABLE',httpStatus:500});
 assert.deepEqual(methods,['GET','GET']);
});
test('ready login and plugin controls remain usable while an unrelated trailing script is stalled',async t=>{
 let slow=false;const f=await fixture(t,{signIn:false,transportHook:async(u,init)=>{
  if(u.pathname==='/wp-content/notice-tail.js'){await new Promise(resolve=>setTimeout(resolve,2500));return {status:200,headers:{'content-type':'application/javascript'},text:''};}
  if(slow&&u.pathname==='/wp-admin/plugins.php'&&init.method==='GET')return {status:200,headers:{'content-type':'text/html'},text:'<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul><table><tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="active"><td><div class="plugin-version-author-uri">Version 1.1.3</div></td></tr></table><script src="/wp-content/notice-tail.js"></script>'};
 }});slow=true;f.session.page.setDefaultNavigationTimeout(400);await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-admin/update.php').length,0);
 await f.session.page.goto('https://wp.example/wp-admin/edit.php?post_type=page',{waitUntil:'commit'});await f.session.ensureCleanLinks();
});
test('confirmed editor publication is returned before a separate public preview can fail',async t=>{
 const f=await fixture(t,{transportHook:async u=>{if(u.pathname==='/example-page/')throw Object.assign(Error('public preview unavailable'),{code:'network_timeout'});}});
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.equal(f.checkpoints.at(-1).phase,'published');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/example-page/').length,0);
});

test('an FTP prompt blocks only Clean Links installation and the same login can publish without it',async t=>{
 const f=await fixture(t,{installed:false,transportHook:u=>u.pathname==='/wp-admin/plugin-install.php'?{
  status:200,headers:{'content-type':'text/html'},text:'<form><input name="hostname"><input name="connection_type"></form>'
 }:null});
 await assert.rejects(f.session.ensureCleanLinks(),error=>error.code==='CLEAN_LINKS_FILESYSTEM_REQUIRED');
 await f.session.login({username:'admin',applicationPassword:'fixture-secret'});
 const result=await f.session.publishPage(f.input);
 assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 assert.equal(f.calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname==='/wp-admin/update.php').length,0);
});

test('native read and plugin phase errors retain numeric HTTP status without response text',async t=>{
 const f=await fixture(t,{installed:false,pluginDenied:true});await assert.rejects(f.session.ensureCleanLinks(),error=>error.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&error.httpStatus===403);
 const read=await fixture(t,{transportHook:u=>u.pathname==='/wp-admin/post.php'?{status:503,headers:{'content-type':'text/html'},text:'private provider details'}:null});
 await assert.rejects(read.session.inspectPublished({saved:{postId:71},title:read.input.title,html:read.input.html}),error=>error.code==='BROWSER_PAGE_UNAVAILABLE'&&error.httpStatus===503&&!error.message.includes('private'));
});

test('adapter cannot downgrade a dispatched checkpoint into another Publish after a draft observation',async t=>{
 const f=await fixture(t);await assert.rejects(f.session.publishPage({...f.input,beforeSend:()=>{throw Object.assign(Error(),{code:'BROWSER_CLOSED'});}}));assert.equal(f.checkpoints.at(-1).phase,'dispatching');
 await assert.rejects(f.session.publishPage({...f.input,saved:{postId:71,phase:'dispatching'}}),error=>error.code==='NATIVE_NOT_PUBLISHED');assert.deepEqual(f.counts,{newPages:1,publishes:0,guarded:0});
});
test('a plugin table container is not proof that its delayed active cleaner row is absent',async t=>{
 let slow=false;const f=await fixture(t,{pluginDenied:true,transportHook:async(u,init)=>{
  if(u.pathname==='/wp-content/list-notice.js'){await new Promise(resolve=>setTimeout(resolve,700));return {status:200,headers:{'content-type':'application/javascript'},text:''};}
  if(slow&&u.pathname==='/wp-admin/plugins.php'&&init.method==='GET')return {status:200,headers:{'content-type':'text/html'},text:'<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul><table class="plugins"><tbody id="the-list"><script src="/wp-content/list-notice.js"></script><tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="active"><td><div class="plugin-version-author-uri">Version 1.1.3</div></td></tr></tbody></table>'};
 }});slow=true;await f.session.page.goto('https://wp.example/wp-admin/edit.php?post_type=page');await f.session.ensureCleanLinks();assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-admin/plugin-install.php').length,0);
});
test('an older cleaner waits for the actual ZIP overwrite control before deciding update is unavailable',async t=>{
 const f=await fixture(t,{version:'1.1.2',uploadBusy:'script',transportHook:async u=>{if(u.pathname==='/wp-content/upload-notice.js'){await new Promise(resolve=>setTimeout(resolve,700));return {status:200,headers:{'content-type':'application/javascript'},text:''};}}});
 await f.session.ensureCleanLinks();assert.equal(f.calls.filter(c=>new URL(c.url).searchParams.get('overwrite')==='update-plugin').length,1);const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.equal(f.counts.publishes,1);
});
test('Gutenberg waits for the visible confirmation button and sends exactly one publication',async t=>{
 const f=await fixture(t,{block:true});
 f.session.page.setDefaultTimeout(6000);
 await f.session.page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
  const toggle=document.querySelector('.editor-post-publish-panel__toggle'),confirm=document.querySelector('.editor-post-publish-button');
  if(!toggle||!confirm)return;
  toggle.classList.add('editor-post-publish-button__button');
  confirm.className='editor-post-publish-button__button';
  const hidden=document.createElement('button');hidden.className='editor-post-publish-button';hidden.hidden=true;confirm.before(hidden);
  toggle.onclick=()=>{toggle.setAttribute('aria-expanded','true');setTimeout(()=>{confirm.hidden=false;},150);};
 }));
 const result=await f.session.publishPage(f.input);
 assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 assert.deepEqual(f.checkpoints.map(value=>value.phase),['creating','draft','dispatching','published']);
});

test('Gutenberg confirms publication through its standard POST with PUT override',async t=>{
 const f=await fixture(t,{block:true});
 await f.session.page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
  const toggle=document.querySelector('.editor-post-publish-panel__toggle'),confirm=document.querySelector('.editor-post-publish-button');
  if(!toggle||!confirm)return;
  toggle.addEventListener('click',()=>sessionStorage.setItem('publish-panel-opened','yes'));
  confirm.onclick=async()=>{
   if(sessionStorage.getItem('publish-panel-opened')!=='yes')throw Error('confirmation panel was not opened');
   const body=JSON.stringify({id:71,status:'publish',title:document.querySelector('h1').textContent,content:document.querySelector('textarea').value});
   const send=(url,method)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-http-method-override':method},body});
   const route='/wp-json/wp/v2/pages/71';
   await send('/wp-json/wp/v2/pages/72','PUT').catch(()=>{});
   await send(route,'DELETE').catch(()=>{});
   await send(route+'?_method=DELETE','PUT').catch(()=>{});
   await send(route+'?_locale=user','PUT');
  };
 }));
 const result=await f.session.publishPage(f.input);
 assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 const writes=f.calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname.startsWith('/wp-json/'));
 assert.deepEqual(writes.map(call=>new URL(call.url).pathname+new URL(call.url).search),['/wp-json/wp/v2/pages/71?_locale=user']);
 assert.deepEqual(f.checkpoints.map(value=>value.phase),['creating','draft','dispatching','published']);
});

for(const location of ['query','body'])test('Gutenberg initial publication refuses a '+location+' override of the reviewed page ID',async t=>{
 const f=await fixture(t,{block:true});
 await f.session.page.addInitScript(location=>{
  const fetchOriginal=window.fetch;
  window.fetch=(url,init)=>{
   if(typeof url==='string'&&url.startsWith('/wp-json/wp/v2/pages/')&&init?.body){
    if(location==='query')url+='?id=72';
    else init={...init,body:JSON.stringify({...JSON.parse(init.body),id:72})};
   }
   return fetchOriginal(url,init);
  };
 },location);
 await assert.rejects(f.session.publishPage(f.input),error=>error.code==='NATIVE_CONTENT_CHANGED'&&error.writeNotAttempted===true);
 assert.deepEqual(f.counts,{newPages:1,publishes:0,guarded:0});
 assert.deepEqual(f.checkpoints.map(value=>value.phase),['creating','draft']);
});

test('Gutenberg receives the exact committed editor state before Publish is clicked',async t=>{
 const f=await fixture(t,{block:true});await f.session.page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
  if(!window.wp?.data||!document.querySelector('textarea.editor-post-text-editor'))return;
  const original=wp.data.select,title=document.querySelector('.editor-post-title__input'),text=document.querySelector('textarea.editor-post-text-editor');let savedTitle=title.textContent,savedContent=text.value,timer;
  wp.data.select=(...args)=>({...original(...args),getEditedPostAttribute:name=>name==='title'?savedTitle:original(...args).getEditedPostAttribute(name),getEditedPostContent:()=>savedContent});
  const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>{savedTitle=title.textContent;savedContent=text.value;},700);};title.addEventListener('input',changed);text.addEventListener('input',changed);
  document.querySelector('.editor-post-publish-button').addEventListener('click',event=>{if(savedTitle===title.textContent&&savedContent===text.value)return;event.preventDefault();event.stopImmediatePropagation();void fetch('/wp-json/wp/v2/pages/71',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title:savedTitle,content:savedContent,status:'publish'})}).catch(()=>{});},true);
 }));
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('native UI installs only Clean Links and saves exact title/HTML using the normal WordPress form',async t=>{
 const f=await fixture(t,{installed:false});assert.equal(f.manager.nativeEditor,true);await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.equal(result.content,f.input.html);assert.equal(result.title,f.input.title);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 assert.deepEqual(f.checkpoints.map(x=>x.phase),['creating','draft','dispatching','published']);
 assert.equal(f.calls.filter(x=>new URL(x.url).pathname==='/wp-admin/update.php').length,1);
});

test('installed plugin is activated and page published while an unrelated upload-screen resource is still loading',async t=>{
 const f=await fixture(t,{installed:false,uploadBusy:true});f.session.page.setDefaultNavigationTimeout(1200);
 await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-admin/update.php'&&c.method==='POST').length,1);
 assert.equal(f.calls.filter(c=>new URL(c.url).searchParams.get('action')==='activate').length,1);
});

test('WordPress stays free of PagePoster overlays through progress, manual errors and completion',async t=>{
 const f=await fixture(t);await f.session.login({username:'admin',applicationPassword:'fixture-secret'});
 await f.session.status('PagePoster progress');assert.equal(await f.session.page.locator('#pageposter-live-status').count(),0);
 await f.manager.error('run','BROWSER_CAPTCHA_REQUIRED');assert.equal(await f.session.page.locator('#pageposter-live-status').count(),0);
 await f.session.ensureCleanLinks();await f.session.publishPage(f.input);await f.manager.done('run');assert.equal(await f.session.page.locator('#pageposter-live-status').count(),0);
});
test('existing active cleaner publishes without visiting the installer even when upload permission is denied',async t=>{
 const f=await fixture(t,{pluginDenied:true});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();
 assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/plugin-install.php'),false);assert.equal(f.calls.some(c=>c.method==='POST'&&!c.url.endsWith('/wp-login.php')),false);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-admin/plugins.php').length,1);
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});

test('existing inactive cleaner is activated once and published without accessing the ZIP installer',async t=>{
 const f=await fixture(t,{enabled:false,pluginDenied:true});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();
 assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/plugin-install.php'),false);assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/update.php'),false);
 assert.equal(f.calls.filter(c=>new URL(c.url).searchParams.get('action')==='activate').length,1);
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});

test('older cleaner is updated through the WordPress upload replacement screen before page creation',async t=>{
 const f=await fixture(t,{version:'1.1.2'});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await f.session.ensureCleanLinks();
 assert.ok(f.calls.some(c=>new URL(c.url).searchParams.get('overwrite')==='update-plugin'));assert.equal(f.counts.newPages,0);
});
test('newer or unrecognized cleaner versions stop without downgrading or creating pages',async t=>{
 for(const version of ['1.1.3.1','1.1.3-beta',null]){
  const f=await fixture(t,{version});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});
  await assert.rejects(f.session.ensureCleanLinks(),{code:'CLEAN_LINKS_UPDATE_REQUIRED'});assert.deepEqual(f.counts,{newPages:0,publishes:0,guarded:0});
  assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/update.php'),false);
 }
});
test('lost publish response is reconciled from the same WordPress post without a second create or publish',async t=>{
 const f=await fixture(t,{lost:true});await assert.rejects(f.session.publishPage(f.input),e=>e.uncertain===true);const saved=f.checkpoints.at(-1);assert.equal(saved.postId,71);assert.equal(saved.phase,'dispatching');
 const result=await f.session.publishPage({...f.input,saved});assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('WordPress stripping the supplied HTML is reported instead of claiming successful publication',async t=>{
 const f=await fixture(t,{sanitize:true});await assert.rejects(f.session.publishPage(f.input),e=>e.code==='NATIVE_CONTENT_CHANGED'&&e.uncertain===true);
});
test('standard block editor uses code mode, visible title/content inputs and its two-step Publish buttons',async t=>{
 const f=await fixture(t,{block:true});const result=await f.session.publishPage(f.input);assert.equal(result.content,f.input.html);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('Gutenberg code mode fills the editable title inside its non-editable wrapper',async t=>{
 const f=await fixture(t,{block:true,modernTitle:true});const result=await f.session.publishPage(f.input);assert.equal(result.title,f.input.title);assert.equal(result.content,f.input.html);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('block wrapper comparison preserves leading and trailing whitespace in approved HTML',async t=>{
 const f=await fixture(t,{block:true});const html='\n  '+f.input.html+'\n\n';const result=await f.session.publishPage({...f.input,html});assert.equal(result.content,html);assert.equal(f.counts.publishes,1);
});
test('email reminder redirect is completed without confirming or changing the administrator email',async t=>{
 const f=await fixture(t,{email:true});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});assert.equal(new URL(f.session.page.url()).pathname,'/wp-admin/');assert.equal(f.calls.filter(c=>new URL(c.url).searchParams.has('remind_me_later')).length,1);
});
test('final lease/approval guard stops the actual browser request before WordPress receives it',async t=>{
 const f=await fixture(t);await assert.rejects(f.session.publishPage({...f.input,beforeSend:()=>{throw Object.assign(Error('Changed approval'),{code:'REVIEW_REQUIRED'});}}),e=>e.writeNotAttempted===true);assert.equal(f.counts.publishes,0);assert.equal(f.checkpoints.at(-1).phase,'dispatching');
});
test('page scripts cannot save or activate unrelated plugins outside an armed user action',async t=>{
 const f=await fixture(t);await f.session.login({username:'admin',applicationPassword:'fixture-secret'});const before=f.calls.length;
 await f.session.page.evaluate(async()=>{await Promise.all([fetch('/wp-admin/post.php',{method:'POST',body:'action=editpost&publish=1&post_ID=99'}).catch(()=>{}),fetch('/wp-admin/plugins.php?action=activate&plugin=unrelated%2Funrelated.php').catch(()=>{}),fetch('https://external.example/').catch(()=>{})]);});assert.equal(f.calls.length,before);
});
test('opening a selected donor starts at login without a dashboard or public homepage request',async t=>{
 const f=await fixture(t,{signIn:false});assert.equal(new URL(f.session.page.url()).pathname,'/wp-login.php');assert.equal(f.calls.some(c=>['/','/wp-admin/','/wp-admin/index.php'].includes(new URL(c.url).pathname)),false);assert.doesNotMatch(await f.session.page.locator('body').innerText(),/Підготовка публікації/);
});
test('standard login opens without needing a working wp-admin dashboard',async t=>{
 const f=await fixture(t,{adminMissing:true,signIn:false});assert.equal(new URL(f.session.page.url()).pathname,'/wp-login.php');assert.equal(await f.session.page.locator('#loginform').count(),1);
});

test('second credential is submitted in the same login form and successful login goes directly to Plugins',async t=>{
 const f=await fixture(t,{signIn:false,loginFailureOnce:true}),page=f.session.page,context=page.context();
 await assert.rejects(f.session.login({username:'first',applicationPassword:'wrong'}),{code:'bootstrap_auth_failed'});
 await f.session.login({username:'backup',applicationPassword:'correct'});assert.equal(f.session.page,page);assert.equal(page.context(),context);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-login.php'&&c.method==='GET').length,1);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-login.php'&&c.method==='POST').length,2);
 assert.equal(f.calls.some(c=>['/','/wp-admin/','/wp-admin/index.php'].includes(new URL(c.url).pathname)),false);assert.equal(new URL(page.url()).pathname,'/wp-admin/plugins.php');
});
test('a delayed second login waits for its own response instead of reusing the previous password error',async t=>{
 const f=await fixture(t,{signIn:false,loginFailureOnce:true,deferLoginSubmit:true}),page=f.session.page;
 await assert.rejects(f.session.login({username:'first',applicationPassword:'wrong'}),{code:'bootstrap_auth_failed'});await f.session.login({username:'backup',applicationPassword:'correct'});assert.equal(f.session.page,page);assert.equal(f.calls.filter(c=>c.method==='POST'&&new URL(c.url).pathname==='/wp-login.php').length,2);assert.equal(new URL(page.url()).pathname,'/wp-admin/plugins.php');
});
test('backup credentials wait for the rejected login document to finish its password reset script',async t=>{
 const f=await fixture(t,{signIn:false,loginFailureOnce:true,lateLoginReset:true}),page=f.session.page;page.setDefaultTimeout(3000);
 await assert.rejects(f.session.login({username:'first',applicationPassword:'wrong'}),{code:'bootstrap_auth_failed'});
 await f.session.login({username:'backup',applicationPassword:'correct'});
 assert.equal(f.session.page,page);assert.equal(f.calls.filter(c=>c.method==='POST'&&new URL(c.url).pathname==='/wp-login.php').length,2);assert.equal(new URL(page.url()).pathname,'/wp-admin/plugins.php');
});
test('a www login form is opened and validated before credentials leave the bare host',async t=>{
 const f=await fixture(t,{loginAlias:'www.wp.example',signIn:false});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});
 assert.equal(f.session.baseUrl,'https://www.wp.example/');assert.equal(new URL(f.session.page.url()).hostname,'www.wp.example');
 const login=f.calls.filter(c=>new URL(c.url).pathname==='/wp-login.php');assert.equal(login.filter(c=>c.method==='POST').length,1);assert.equal(new URL(login.find(c=>c.method==='POST').url).hostname,'www.wp.example');assert.ok(login.some(c=>c.method==='GET'&&new URL(c.url).hostname==='www.wp.example'));
 assert.deepEqual(f.session.canonicalLogin,{requestedBaseUrl:'https://wp.example/',baseUrl:'https://www.wp.example/'});
 assert.equal(await f.reopen(),f.session);
});
test('an initial HTTPS www login redirect stays in the same private page',async t=>{
 const f=await fixture(t,{loginAlias:'www.wp.example',loginRedirect:true});assert.equal(f.session.baseUrl,'https://www.wp.example/');assert.equal(new URL(f.session.page.url()).hostname,'www.wp.example');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('a bare-host redirect followed by a child installation login uses that installation for plugins and publication',async t=>{
 const f=await fixture(t,{loginAlias:'www.wp.example',loginRedirect:true,installationPath:'/wp',signIn:false,transportHook:async(u,options)=>u.hostname==='www.wp.example'&&u.pathname==='/wp/wp-login.php'&&(options.method||'GET')==='GET'?{status:200,headers:{'content-type':'text/html'},text:'<form id="loginform" action="https://www.wp.example/wp/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input type="submit" id="wp-submit"></form>'}:null});
 await f.session.login({username:'admin',applicationPassword:'fixture-secret'});assert.equal(f.session.baseUrl,'https://www.wp.example/wp/');
 assert.deepEqual(f.session.canonicalLogin.steps,[{kind:'redirect',from:'https://wp.example/wp-login.php',to:'https://www.wp.example/wp-login.php'},{kind:'redirect',from:'https://www.wp.example/wp-login.php',to:'https://www.wp.example/wp/wp-login.php'}]);
 await f.session.ensureCleanLinks();await f.session.publishPage(f.input);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
 assert.ok(f.calls.filter(c=>c.method==='POST').every(c=>new URL(c.url).origin==='https://www.wp.example'&&new URL(c.url).pathname.startsWith('/wp/')));
});
test('the www-to-bare login transition uses the same installation and can publish normally',async t=>{
 const f=await fixture(t,{initialBase:'https://www.wp.example/',loginAlias:'wp.example'});assert.equal(f.session.baseUrl,'https://wp.example/');await f.session.ensureCleanLinks();await f.session.publishPage(f.input);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('an unrelated login form never receives credentials or a browser request',async t=>{
 const f=await fixture(t,{loginAlias:'unrelated.example',signIn:false});await assert.rejects(f.session.login({username:'admin',applicationPassword:'fixture-secret'}),{code:'BROWSER_ORIGIN_BLOCKED'});assert.equal(f.calls.some(c=>new URL(c.url).hostname==='unrelated.example'||c.method==='POST'),false);assert.equal(await f.session.page.locator('[name=pwd]').inputValue(),'');
});
test('a canonical login response is revalidated before filling any credentials',async t=>{
 const f=await fixture(t,{loginAlias:'www.wp.example',signIn:false,transportHook:async(url,options)=>url.hostname==='www.wp.example'&&url.pathname==='/wp-login.php'?{status:200,headers:{'content-type':'text/html'},text:'<form id="loginform" action="https://unrelated.example/wp-login.php"><input name="log"><input name="pwd"><button type="submit">Login</button></form>'}:null});await assert.rejects(f.session.login({username:'admin',applicationPassword:'fixture-secret'}),{code:'BROWSER_ORIGIN_BLOCKED'});assert.equal(f.calls.some(c=>c.method==='POST'),false);assert.equal(await f.session.page.locator('[name=pwd]').inputValue(),'');
});

test('a same-host child login form without a server redirect receives no credentials',async t=>{
 const f=await fixture(t,{signIn:false,transportHook:async(u,options)=>u.pathname==='/wp-login.php'?{status:200,headers:{'content-type':'text/html'},text:'<form id="loginform" action="https://wp.example/wp/wp-login.php"><input name="log"><input name="pwd"><button type="submit">Login</button></form>'}:null});
 await assert.rejects(f.session.login({username:'admin',applicationPassword:'fixture-secret'}),{code:'BROWSER_ORIGIN_BLOCKED'});assert.equal(f.calls.some(c=>c.method==='POST'),false);assert.equal(await f.session.page.locator('[name=pwd]').inputValue(),'');
});

test('authenticated account switch clears private authentication while preserving the same page and context',async t=>{
 const f=await fixture(t),page=f.session.page,context=page.context();assert.ok((await context.cookies()).some(c=>c.name.startsWith('wordpress_logged_in_')));
 await f.manager.switchAccount('run');assert.equal(f.session.page,page);assert.equal(page.context(),context);assert.equal((await context.cookies()).some(c=>c.name.startsWith('wordpress_logged_in_')),false);
 await f.session.login({username:'backup',applicationPassword:'correct'});assert.equal(new URL(page.url()).pathname,'/wp-admin/plugins.php');
});

test('late responses from the previous account cannot restore its cookies after switching accounts',async t=>{
 let release,started;const pending=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);t.after(()=>release());
 const f=await fixture(t,{transportHook:async u=>{if(u.pathname==='/wp-content/late-account.js'){started();await pending;return {status:200,headers:{'content-type':'application/javascript','set-cookie':['wordpress_logged_in_old=first; Path=/; Secure; HttpOnly']},text:'window.oldAccount=true;'};}}});
 await f.session.page.evaluate(()=>{const s=document.createElement('script');s.src='/wp-content/late-account.js?ver=1';document.head.append(s);});await requested;
 await f.manager.switchAccount('run');await f.session.login({username:'backup',applicationPassword:'correct'});release();
 // The old route has already left the old document; allow its transport reply
 // and browser cookie task to finish before observing the new account's jar.
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal((await f.session.page.context().cookies()).some(c=>c.name==='wordpress_logged_in_old'),false);
});

test('account switching waits for an already applying old cookie before clearing authentication',async t=>{
 let release,started;const pending=new Promise(resolve=>release=resolve),applying=new Promise(resolve=>started=resolve);t.after(()=>release());
 const f=await fixture(t,{transportHook:async u=>u.pathname==='/old-cookie'?{status:200,headers:{'content-type':'text/plain','set-cookie':['old_identity=first; Path=/; Secure; HttpOnly']},text:'ok'}:null});
 const context=f.session.page.context(),original=context.addCookies.bind(context);context.addCookies=async values=>{if(values.some(c=>c.name==='old_identity')){started();await pending;}return original(values);};
 await f.session.page.evaluate(()=>{void fetch('/old-cookie').catch(()=>{});});await applying;const switching=f.manager.switchAccount('run');await new Promise(resolve=>setTimeout(resolve,100));release();await switching;
 assert.equal((await context.cookies()).some(c=>c.name==='old_identity'),false);
});

test('new page is opened by clicking Pages and its localized Add New link',async t=>{
 const f=await fixture(t);await f.session.ensureCleanLinks();const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');
 const pages=f.calls.find(c=>new URL(c.url).pathname==='/wp-admin/edit.php'),create=f.calls.find(c=>new URL(c.url).pathname==='/wp-admin/post-new.php');assert.ok(pages);assert.equal(new URL(pages.referer).pathname,'/wp-admin/plugins.php');assert.equal(new URL(create.referer).pathname,'/wp-admin/edit.php');assert.equal(new URL(create.referer).searchParams.get('post_type'),'page');assert.equal(f.counts.newPages,1);
});
test('a hidden Pages menu falls back to the same-site Pages list before clicking Add New',async t=>{
 const f=await fixture(t);
 await f.session.ensureCleanLinks();
 await f.session.page.locator('#menu-pages').evaluate(node=>{node.hidden=true;});
 f.session.page.setDefaultTimeout(2000);
 assert.equal((await f.session.publishPage(f.input)).status,'publish');
 assert.deepEqual(f.checkpoints.map(row=>row.phase),['creating','draft','dispatching','published']);
 assert.equal(f.counts.newPages,1);
});

test('AMP support uses the current cleaner without changing ordinary plugin behavior',async t=>{
 const f=await fixture(t,{version:'1.2.1'});
 assert.equal((await f.session.ensureCleanLinks({ampMode:true})).ampSupport,true);
 assert.equal((await f.session.ensureCleanLinks()).active,true);
 assert.equal(f.calls.some(call=>new URL(call.url).pathname==='/wp-admin/update.php'),false);
 const legacy=await fixture(t,{version:'1.2.0'});
 assert.equal((await legacy.session.ensureCleanLinks()).active,true);
 assert.equal(legacy.calls.some(call=>new URL(call.url).pathname==='/wp-admin/update.php'),false);
});

test('AMP mode upgrades the previous AMP cleaner to its separately checksummed package',async t=>{
 let replaced=false,uploads=0;
 const html=text=>({status:200,headers:{'content-type':'text/html'},text});
 const f=await fixture(t,{transportHook:(url,init)=>{
  if(url.pathname==='/wp-admin/plugins.php')return html('<ul id="adminmenu"><li id="menu-pages"><a href="edit.php?post_type=page">Pages</a></li></ul><table><tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="active"><td><div class="plugin-version-author-uri">Version '+(replaced?'1.2.1':'1.2.0')+'</div></td></tr></table>');
  if(url.pathname==='/wp-admin/update.php'){
   if(init.method==='POST'){uploads++;assert.match(Buffer.from(init.body).toString('latin1'),/pageposter-clean-links-1\.2\.1\.zip/);return html('<a class="update-from-upload-overwrite" href="update.php?action=upload-plugin&overwrite=update-plugin&_wpnonce=fixture">Replace</a>');}
   replaced=true;return html('Updated');
  }
 }});
 assert.equal((await f.session.ensureCleanLinks({ampMode:true})).ampSupport,true);assert.equal(uploads,1);assert.equal(f.counts.newPages,0);
});
test('a loaded Pages list with no Add New control proves creation was not sent',async t=>{
 const f=await fixture(t,{transportHook:url=>url.pathname==='/wp-admin/edit.php'?{status:200,headers:{'content-type':'text/html'},text:'<form id="posts-filter"><table><tbody id="the-list"></tbody></table></form>'}:null});
 const deadline=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Missing Add New control was not detected')),4500);timer.unref();});
 await assert.rejects(Promise.race([f.session.publishPage(f.input),deadline]),{code:'NATIVE_NAVIGATION_UNAVAILABLE',writeNotAttempted:true});
 assert.equal(f.counts.newPages,0);
 assert.deepEqual(f.checkpoints,[]);
});

test('foreign Add New link is refused before any draft or publication is created',async t=>{
 const f=await fixture(t,{newPageHref:'https://outside.example/wp-admin/post-new.php?post_type=page'});await assert.rejects(f.session.publishPage(f.input),e=>['BROWSER_ORIGIN_BLOCKED','NATIVE_NAVIGATION_UNAVAILABLE'].includes(e.code));assert.equal(f.counts.newPages,0);assert.equal(f.counts.publishes,0);assert.equal(f.calls.some(c=>new URL(c.url).hostname==='outside.example'),false);
});

test('versioned static scripts are reused through login, Plugins, Pages and publication',async t=>{
 const f=await fixture(t,{assetBootstrap:true});await f.session.ensureCleanLinks();await f.session.publishPage(f.input);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-includes/js/runtime.js').length,1);
});
test('a failed core script read is recovered before dependent editor code runs, with one publication',async t=>{
 let reads=0;const f=await fixture(t,{assetBootstrap:true,transportHook:async url=>{if(url.pathname==='/wp-includes/js/runtime.js'&&++reads===1)throw Object.assign(Error('transient core read'),{code:'network_timeout'});}});
 assert.equal(await f.session.page.evaluate(()=>window.fixtureCore),true);await f.session.ensureCleanLinks();await f.session.publishPage(f.input);assert.equal(reads,2);assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});

test('private static cache is cleared when switching authenticated accounts in the same window',async t=>{
 const f=await fixture(t,{assetBootstrap:true});assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-includes/js/runtime.js').length,1);
 await f.manager.switchAccount('run');await f.session.login({username:'backup',applicationPassword:'correct'});assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/wp-includes/js/runtime.js').length,2);
});

test('a broken Gutenberg bootstrap still checkpoints its draft before waiting and resumes that draft once repaired',async t=>{
 const f=await fixture(t,{blankEditor:true});let resultError;const pending=f.session.publishPage(f.input).catch(error=>{resultError=error;});
 const until=Date.now()+1800;while(!f.checkpoints.some(c=>c.phase==='draft')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30));
 try{
  assert.deepEqual(f.checkpoints.at(-1),{postId:71,phase:'draft'});assert.equal(f.counts.publishes,0);
  // The checkpoint is emitted inside response interception, before the editor
  // document commits. Closing that target early can deadlock Chrome's close
  // command; this case interrupts the broken editor after its document loads.
  await f.session.page.waitForURL(url=>url.pathname==='/wp-admin/post-new.php'&&url.searchParams.get('post_type')==='page',{waitUntil:'domcontentloaded',timeout:5000});
 }finally{await f.session.page.close();await pending;}
 assert.ok(resultError);f.repairEditor();await f.manager.reset('run');const next=await f.reopen();await next.login({username:'admin',applicationPassword:'fixture-secret'});const result=await next.publishPage({...f.input,saved:f.checkpoints.at(-1)});assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('opening a slow editor waits for its controls rather than the short navigation deadline',async t=>{
 const f=await fixture(t,{editorDelay:1600});f.session.page.setDefaultNavigationTimeout(600);
 const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('late Add New HTML retains its draft identity after navigation times out and resumes exactly once',async t=>{
 const f=await fixture(t,{postNewDelay:1200});f.session.page.setDefaultNavigationTimeout(500);
 await assert.rejects(f.session.publishPage(f.input),e=>e.uncertain===true&&e.writeNotAttempted!==true);assert.equal(f.checkpoints[0]?.phase,'creating');assert.equal(f.counts.newPages,1);
 const until=Date.now()+3000;while(!f.checkpoints.some(c=>c.phase==='draft')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30));const saved=f.checkpoints.find(c=>c.phase==='draft');assert.equal(saved?.postId,71);
 await f.manager.reset('run');const next=await f.reopen();await next.login({username:'admin',applicationPassword:'fixture-secret'});const result=await next.publishPage({...f.input,saved});assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});
test('a lost Add New response blocks another create even after the private browser session is reset',async t=>{
 const f=await fixture(t,{postNewLost:true});await assert.rejects(f.session.publishPage(f.input),e=>e.uncertain===true);const saved=f.checkpoints.at(-1);assert.deepEqual(saved,{postId:null,phase:'creating'});
 await f.manager.reset('run');const next=await f.reopen();await next.login({username:'admin',applicationPassword:'fixture-secret'});await assert.rejects(next.publishPage({...f.input,saved}),e=>e.code==='NATIVE_RESULT_UNCERTAIN'&&e.uncertain===true);assert.deepEqual(f.counts,{newPages:1,publishes:0,guarded:0});
});

test('a proven pre-request Add New failure rolls back only the new creation checkpoint and permits retry',async t=>{
 const {createSafeTransport}=await import('../server/lifecycle/network.mjs');let blocked=true,requests=0;
 const denied=createSafeTransport({lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{requests++;assert.fail('unsafe DNS must never open a request');}});
 const f=await fixture(t,{transportHook:(url,options)=>blocked&&url.pathname==='/wp-admin/post-new.php'?denied(url.href,options):undefined});
 await assert.rejects(f.session.publishPage(f.input),error=>error.code==='unsafe_address'&&error.uncertain!==true&&error.writeNotAttempted===true);
 assert.equal(requests,0);assert.deepEqual(f.checkpoints,[{postId:null,phase:'creating'},{postId:null,phase:'not_started',requestNotStarted:true}]);assert.equal(f.counts.newPages,0);
 blocked=false;await f.session.login({username:'admin',applicationPassword:'fixture-secret'});const result=await f.session.publishPage(f.input);assert.equal(result.status,'publish');assert.deepEqual(f.counts,{newPages:1,publishes:1,guarded:1});
});

test('a started Add New request failure retains the unknown draft checkpoint',async t=>{
 const {createSafeTransport}=await import('../server/lifecycle/network.mjs');let requests=0;
 const failed=createSafeTransport({lookup:async()=>[{address:'93.184.216.34',family:4}],request:()=>{requests++;throw Error('request outcome unknown');}});
 const f=await fixture(t,{transportHook:(url,options)=>url.pathname==='/wp-admin/post-new.php'?failed(url.href,options):undefined});
 await assert.rejects(f.session.publishPage(f.input),error=>error.code==='NATIVE_RESULT_UNCERTAIN'&&error.uncertain===true&&error.writeNotAttempted!==true);
 assert.equal(requests,1);assert.deepEqual(f.checkpoints,[{postId:null,phase:'creating'}]);
 await assert.rejects(f.session.publishPage({...f.input,saved:f.checkpoints.at(-1)}),{code:'NATIVE_RESULT_UNCERTAIN'});assert.equal(requests,1);
});
test('plugin upload permission denial is classified before any page or upload is created',async t=>{
 const f=await fixture(t,{installed:false,pluginDenied:true});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});
 await assert.rejects(f.session.ensureCleanLinks(),e=>e.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&e.beforePageCreation===true);
 assert.equal(f.counts.newPages,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('a generic WordPress fatal error is not treated as proof of missing plugin permissions',async t=>{
 for(const pluginBroken of [true,403]){const f=await fixture(t,{installed:false,pluginBroken});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await assert.rejects(f.session.ensureCleanLinks(),e=>e.code==='BROWSER_PAGE_UNAVAILABLE'&&!e.beforePageCreation);assert.equal(f.counts.newPages,0);}
});
test('generic permission denial on the explicit Plugins screen skips before accessing the uploader',async t=>{
 const f=await fixture(t,{pluginDenied:'generic'});await f.session.login({username:'admin',applicationPassword:'fixture-secret'});await assert.rejects(f.session.ensureCleanLinks(),e=>e.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&e.beforePageCreation);assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/plugin-install.php'),false);
});
test('rejected login is definite and does not create a page or contact the plugin installer',async t=>{
 const f=await fixture(t,{loginReject:true});await assert.rejects(f.session.login({username:'admin',applicationPassword:'fixture-secret'}),e=>e.code==='bootstrap_auth_failed'&&e.loginRejectedBeforeWrites===true);
 assert.equal(f.calls.some(c=>new URL(c.url).pathname.includes('plugin')),false);assert.equal(f.counts.newPages,0);
});
test('Vietnamese WordPress capability denial on the uploader is an account-permission failure before page creation',async t=>{
 for(const legacy of [false,true,'delayed']){const f=await fixture(t,{installed:false,transportHook:async u=>{if(u.pathname==='/wp-admin/plugin-install.php')return {status:403,headers:{'content-type':'text/html; charset=utf-8'},text:legacy==='delayed'?'<body id="error-page"><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend","<p>Xin lỗi, bạn không được phép truy cập vào trang này.</p>"),400)</script></body>':legacy?'<body id="error-page"><p>Xin lỗi, bạn không được phép truy cập vào trang này.</p></body>':'<div class="wp-die-message">Xin lỗi, bạn không được phép truy cập vào trang này.</div>'};}});
 await assert.rejects(f.session.ensureCleanLinks(),e=>e.code==='CLEAN_LINKS_INSTALL_FORBIDDEN'&&e.beforePageCreation===true);assert.equal(f.counts.newPages,0);assert.equal(f.calls.some(c=>c.method==='POST'&&new URL(c.url).pathname==='/wp-admin/update.php'),false);}
});
