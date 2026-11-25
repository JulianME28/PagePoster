'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const loginForm='<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input type="submit"></form>';
const html=text=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});
async function fixture(t,{transport=async()=>html(loginForm),initialize}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');let browser;
 const tracked={launch:async options=>{browser=await chromium.launch(options);await initialize?.(browser);return browser;}};
 const manager=createWordPressUI({chromium:tracked,executablePath,headless:true,transport});t.after(()=>manager.close());
 return {manager,get browser(){return browser;}};
}

// Missing owner rollback must not turn a real launch failure into BROWSER_BUSY.
test('an unavailable browser does not reserve ownership for a failed run',async t=>{
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs'),manager=createWordPressUI({chromium:null,executablePath:null});t.after(()=>manager.close());
 await assert.rejects(manager.prepare('first'),{code:'BROWSER_UNAVAILABLE'});
 await assert.rejects(manager.prepare('second'),{code:'BROWSER_UNAVAILABLE'});
});

test('invalid initial URL leaves the private browser available to another run',async t=>{
 const f=await fixture(t);await assert.rejects(f.manager.open('invalid','https://127.0.0.1/'),{code:'unsafe_address'});
 const next=await f.manager.open('next','https://wp.example/');assert.equal(await next.page.locator('#loginform').count(),1);
});

// A failed initial request must dispose the private context, including its
// cookies and session registration, before another run can open.
test('failed initial navigation releases its context and lets another run open',async t=>{
 let reads=0;const f=await fixture(t,{transport:async()=>{if(++reads<=2)throw Object.assign(Error('fixture request failure'),{code:'network_failed'});return html(loginForm);}});
 await assert.rejects(f.manager.open('first','https://wp.example/'),{code:'network_failed'});
 assert.equal(reads,2);
 assert.equal(f.browser.contexts().length,0);
 const next=await f.manager.open('next','https://next.example/');assert.equal(await next.page.locator('#loginform').count(),1);
});

test('retrying the same run after failed initial navigation loads WordPress again',async t=>{
 let reads=0;const f=await fixture(t,{transport:async url=>{if(new URL(url).pathname!=='/wp-login.php')return {status:404,headers:{},text:''};if(++reads<=2)throw Object.assign(Error('fixture request timeout'),{code:'network_timeout'});return html(loginForm);}});
 await assert.rejects(f.manager.open('first','https://wp.example/'),{code:'network_timeout'});
 assert.equal(reads,2);
 const retried=await f.manager.open('first','https://wp.example/');assert.equal(await retried.page.locator('#loginform').count(),1);
});

test('a context initialization failure closes the context before retry',async t=>{
 const failure=Error('fixture initialization failure');let failed=false;
 const f=await fixture(t,{initialize:browser=>{const original=browser.newContext.bind(browser);browser.newContext=async options=>{const context=await original(options);if(!failed){failed=true;context.addInitScript=async()=>{throw failure;};}return context;};}});
 await assert.rejects(f.manager.prepare('first'),error=>error===failure);assert.equal(f.browser.contexts().length,0);
 const next=await f.manager.open('next','https://wp.example/');assert.equal(await next.page.locator('#loginform').count(),1);
});

test('login reports the actual navigation transport error',async t=>{
 const f=await fixture(t,{transport:async(_url,options)=>{if(options.method==='POST')throw Object.assign(Error('fixture login timeout'),{code:'network_timeout'});return html(loginForm);}});
 const session=await f.manager.open('first','https://wp.example/');
 await assert.rejects(session.login({username:'fixture-admin',applicationPassword:'fixture-password'}),{code:'network_timeout'});
});

for(const status of [200,403,429,503])test('an HTTP '+status+' challenge on the initial login page retains the private page for manual resume',async t=>{
 const f=await fixture(t,{transport:async()=>({...html(loginForm+'<div class="g-recaptcha">Manual challenge</div><textarea hidden name="g-recaptcha-response"></textarea><button id="solve" onclick="document.querySelector(\'[name=g-recaptcha-response]\').value=\'solved\'">Human action</button>'),status})});
 await assert.rejects(f.manager.open('first','https://wp.example/'),{code:'BROWSER_CAPTCHA_REQUIRED'});
 const session=await f.manager.open('first','https://wp.example/');assert.equal(f.browser.contexts().length,1);
 await session.page.locator('#solve').click();assert.equal(await f.manager.resume('first'),true);
});
test('a plain HTTP 403 still reports an unavailable login page and closes its context',async t=>{
 const f=await fixture(t,{transport:async()=>({...html('<h1>Forbidden</h1>'),status:403})});
 await assert.rejects(f.manager.open('first','https://wp.example/'),{code:'BROWSER_PAGE_UNAVAILABLE',httpStatus:403});
 assert.equal(f.browser.contexts().length,0);
});

// WordPress hides its admin navigation below 783px. Chrome's native headless
// window can be narrower, so a context without a desktop viewport cannot click
// the Pages link even after a successful login.
test('headless publication can use the responsive WordPress admin navigation',async t=>{
 const menu='<style>@media(max-width:782px){#adminmenu{display:none}}</style><ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul>';
 let published=false,title='',content='',creates=0,publishes=0;
 const editor=()=>html('<form id="post" action="/wp-admin/post.php" method="post"><input id="title" name="post_title" value="'+title+'"><textarea id="content" name="content">'+content+'</textarea><input name="post_ID" id="post_ID" value="71"><input name="post_type" value="page"><input name="action" value="editpost"><input id="original_post_status" value="'+(published?'publish':'auto-draft')+'"><button id="publish" name="publish" value="Publish">Publish</button></form>'+(published?'<a id="sample-permalink" href="https://wp.example/published/">View</a>':''));
 const f=await fixture(t,{transport:async(address,options)=>{
  const url=new URL(address);
  if(url.pathname==='/wp-login.php')return options.method==='POST'?{...html(menu),headers:{'content-type':'text/html; charset=utf-8','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']}}:html(loginForm);
  if(url.pathname==='/wp-admin/edit.php')return html(menu+'<a class="page-title-action" href="/wp-admin/post-new.php?post_type=page">Add New Page</a>');
  if(url.pathname==='/wp-admin/post-new.php'){creates++;return editor();}
  if(url.pathname==='/wp-admin/post.php'){
   if(options.method==='POST'){const fields=new URLSearchParams(options.body.toString());title=fields.get('post_title');content=fields.get('content');published=true;publishes++;}
   return editor();
  }
  if(url.pathname==='/published/')return html(content);
  assert.fail('Unexpected fixture request '+address);
 }});
 const session=await f.manager.open('first','https://wp.example/');
 await session.login({username:'fixture-admin',applicationPassword:'fixture-password'});
 session.page.setDefaultTimeout(5000);session.page.setDefaultNavigationTimeout(5000);
 const result=await session.publishPage({title:'Desktop navigation',html:'<p>Responsive admin fixture</p>',checkpoint:async()=>{},beforeSend:()=>{}});
 assert.equal(result.status,'publish');assert.equal(result.url,'https://wp.example/published/');assert.equal(creates,1);assert.equal(publishes,1);
});
