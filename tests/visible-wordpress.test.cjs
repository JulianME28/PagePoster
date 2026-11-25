const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const pw=require('./browser-runtime.cjs').playwrightPath,chrome=require('./browser-runtime.cjs').chromePath;
const options={timeout:45000,skip:!fs.existsSync(pw)||!fs.existsSync(chrome)};

test('approval immediately opens a private waiting window before a donor is bound',options,async t=>{
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport:async()=>assert.fail('Waiting window must not contact a site')});t.after(()=>manager.close());
 const prepared=await manager.prepare('waiting',{headless:true});assert.equal(prepared.page.isClosed(),false);assert.match(await prepared.page.locator('body').innerText(),/Підбираємо|Підготовка/);
 assert.equal(await manager.open('waiting','https://wp.example/',{headless:true}),prepared);assert.equal(prepared.baseUrl,'https://wp.example/');
});

test('WordPress admin email confirmation remains visible with readable UTF-8 and no unrelated action allowed',options,async t=>{
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport:async(url)=>url.includes('confirm_admin_email')?{status:200,headers:{'content-type':'text/html; charset=UTF-8'},text:'<h1>Подтверждение email</h1>'}:{status:302,headers:{location:'/wp-login.php?action=confirm_admin_email&redirect_to=https%3A%2F%2Fwp.example%2Fwp-admin%2F'},text:''}});t.after(()=>manager.close());
 const session=await manager.open('email','https://wp.example/');await session.transport('https://wp.example/wp-login.php');assert.equal(await session.page.locator('h1').textContent(),'Подтверждение email');
});

test('resume login handles only the authenticated remind-later email screen without changing email',options,async t=>{
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');let reminders=0;
 const transport=async(url,init={})=>{const target=new URL(url),html=text=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text});
  if(init.method==='POST')return {status:302,headers:{location:'/wp-login.php?action=confirm_admin_email','set-cookie':['wordpress_logged_in_test=session; Path=/; Secure']},text:''};
  if(target.searchParams.has('remind_me_later')){reminders++;return {status:302,headers:{location:'/wp-admin/'},text:''};}
  if(target.searchParams.get('action')==='confirm_admin_email')return html('<form class="admin-email-confirm-form"></form><a href="/wp-login.php?action=confirm_admin_email&remind_me_later=validnonce">Напомнить позже</a>');
  if(target.pathname==='/wp-login.php')return html('<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd"><button type="submit">Войти</button></form>');
  return html('<h1>WordPress admin</h1>');
 };
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());const session=await manager.open('resume-email','https://wp.example/');await session.login({username:'fixture',applicationPassword:'fixture'});
 assert.equal(reminders,1);assert.equal(new URL(session.page.url()).pathname,'/wp-admin/');
});

test('native WordPress editor receives approved title and HTML and dispatches exactly one publication form',options,async t=>{
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');let posted=0,guarded=0;
 const operation={operationId:'12345678-1234-4234-8234-123456789abc',kind:'create',postType:'page',title:'Тестовая страница',content:'<div id="pp-landing"><h1>Exact HTML</h1></div>',status:'publish'};
 const transport=async(url,init={})=>{
  if(init.method==='POST'){posted++;const data=new URLSearchParams(init.body);assert.equal(guarded,1);assert.equal(data.get('post_title'),operation.title);assert.equal(data.get('content'),operation.content);assert.equal(data.get('pageposter_operation'),operation.operationId);assert.equal(data.get('pageposter_nonce'),'fixture-nonce');return {status:201,headers:{'content-type':'text/html; charset=UTF-8'},text:'<h1>Published</h1><script type="application/json" id="pageposter-operation-result">'+JSON.stringify({status:201,data:{state:'completed',postId:71}})+'</script>'};}
  return {status:200,headers:{'content-type':'text/html'},text:'<form id="post" method="post" action="/wp-admin/post.php"><input id="title" name="post_title"><textarea id="content" name="content"></textarea><input name="pageposter_operation" value="'+operation.operationId+'"><input name="pageposter_nonce" value="fixture-nonce"><input name="post_type" value="page"><button id="publish" name="publish" value="Publish">Publish</button></form>'};
 };
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());await manager.open('native','https://wp.example/');
 const reply=await manager.publish('native',{operation,address:'https://wp.example/wp-json/pageposter/v1/operations',beforeSend:()=>guarded++});assert.equal(reply.status,201);assert.equal(JSON.parse(reply.text).postId,71);assert.equal(posted,1);
});
async function fixture(t){
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');const calls=[];
 const transport=async(url,init={})=>{calls.push({url,method:init.method||'GET',body:init.body});const u=new URL(url);let text='',status=200,headers={'content-type':'text/html'};
  if(u.pathname==='/wp-login.php'&&init.method==='POST'){assert.equal(new URLSearchParams(init.body).get('pwd'),'fixture-secret');status=302;headers.location='/wp-admin/';headers['set-cookie']=['wordpress_logged_in_test=fixture; Path=/; Secure; HttpOnly','wordpress_sec_test=admin-session; Path=/wp-admin; Secure; HttpOnly'];}
  else if(u.pathname==='/wp-login.php')text='<form id="loginform" method="post" action="/wp-login.php"><input name="log"><input name="pwd" type="password"><input type="submit" value="Log In"></form>';
  else if(u.pathname==='/wp-admin/plugin-install.php')text='<form method="post" action="/wp-admin/update.php?action=upload-plugin" enctype="multipart/form-data"><input name="_wpnonce" value="fixture"><input type="file" name="pluginzip"><input type="submit" value="Install Now"></form>';
  else if(u.pathname==='/wp-admin/update.php')text='<h1>Installed</h1>';
  else if(u.pathname==='/published/')text='<h1>Published page</h1>';
  else text='<h1>WordPress admin</h1><a href="/wp-admin/plugins.php?action=delete&plugin=x">Unexpected action</a>';
  return {url,status,headers,text,body:Buffer.from(text)};
 };
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());const session=await manager.open('fixture','https://wp.example/');return {manager,session,calls};
}
test('visible browser uses the real login form, submits once and keeps the final page open',options,async t=>{
 const {manager,session,calls}=await fixture(t);await session.login({username:'editor',applicationPassword:'fixture-secret'});
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.match(session.page.url(),/wp-admin/);assert.equal(await session.page.locator('h1').textContent(),'WordPress admin');
 assert.doesNotMatch(await session.page.locator('body').innerText(),/fixture-secret/);
 await session.publication();assert.match(await session.page.locator('#pageposter-live-status').innerText(),/редактор WordPress/);
 await manager.result('fixture','https://wp.example/published/');assert.equal(await session.page.locator('h1').textContent(),'Published page');assert.equal(session.page.isClosed(),false);
});

test('visible browser sends path-scoped admin cookies only to admin pages',options,async t=>{
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs');const calls=[];
 const transport=async(url,init={})=>{calls.push({url,init});const pathname=new URL(url).pathname;
  if(pathname==='/wp-login.php'&&init.method==='POST')return {status:302,headers:{location:'/wp-admin/','set-cookie':['wordpress_logged_in_test=fixture; Path=/; Secure','wordpress_sec_test=admin; Path=/wp-admin; Secure']},text:''};
  if(pathname==='/wp-login.php')return {status:200,headers:{'content-type':'text/html'},text:'<form id="loginform" method="post" action="/wp-login.php"><input name="log"><input name="pwd"><button type="submit">Log in</button></form>'};
  return {status:200,headers:{'content-type':'text/html'},text:'<h1>WordPress</h1>'};
 };
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport});t.after(()=>manager.close());
 const session=await manager.open('cookies','https://wp.example/');await session.login({username:'editor',applicationPassword:'fixture'});await session.publication();await session.result('https://wp.example/published/');
 for(const call of calls.filter(c=>new URL(c.url).pathname.startsWith('/wp-admin')))assert.match(call.init.headers.cookie,/wordpress_sec_test=admin/);
 assert.doesNotMatch(calls.find(c=>c.url.endsWith('/published/')).init.headers.cookie,/wordpress_sec_test/);
});
test('visible browser blocks unrequested writes and does not silently continue after its window closes',options,async t=>{
 const {manager,session,calls}=await fixture(t);await session.login({username:'editor',applicationPassword:'fixture-secret'});const before=calls.length;
 await session.page.getByText('Unexpected action',{exact:true}).click();await session.page.waitForTimeout(50);
 assert.equal(calls.length,before);await session.page.close();
 await assert.rejects(session.transport('https://wp.example/wp-json/',{}),{code:'BROWSER_CLOSED'});
 await assert.rejects(manager.open('fixture','https://wp.example/'),{code:'BROWSER_CLOSED'});
 await assert.rejects(manager.publish('fixture',{}),error=>error.code==='BROWSER_CLOSED'&&error.writeNotAttempted===true);
 assert.equal(calls.length,before);
});
test('visible browser selects a plugin file and sends only the trusted multipart body',options,async t=>{
 const {session,calls}=await fixture(t);await session.transport('https://wp.example/wp-admin/plugin-install.php?tab=upload',{});
 const body=Buffer.from('--test\r\nContent-Disposition: form-data; name="pluginzip"; filename="fixture.zip"\r\nContent-Type: application/zip\r\n\r\nPKfixture\r\n--test--\r\n');
 const reply=await session.transport('https://wp.example/wp-admin/update.php?action=upload-plugin',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=test'},body});
 assert.equal(reply.status,200);assert.equal(await session.page.getByRole('heading',{name:'Installed'}).count(),1);assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>c.body),[body]);
});
test('complete bootstrap uses visible login and upload forms without duplicating plugin or password writes',options,async t=>{
 const {fixture:wordpress,INPUT,packages}=require('./wordpress-bootstrap-fixture.cjs'),f=wordpress();
 const {createVisibleWordPress}=await import('../server/lifecycle/visible-wordpress.mjs'),{createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 const manager=createVisibleWordPress({chromium:require(pw).chromium,executablePath:chrome,headless:true,transport:f.transport});t.after(()=>manager.close());
 const session=await manager.open(INPUT.operationId,INPUT.baseUrl);const result=await createWordPressBootstrap({transport:session.transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT);
 assert.equal(result.state,'ready');assert.equal(f.created,1);assert.equal(f.calls.filter(c=>new URL(c.url).pathname.endsWith('update.php')).length,2);
 assert.equal(f.calls.filter(c=>new URL(c.url).pathname.endsWith('wp-login.php')&&c.init.method==='POST').length,1);assert.equal(session.page.isClosed(),false);
 assert.doesNotMatch(await session.page.locator('body').innerText(),/admin-fixture-secret|application fixture password/);
});
