'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const pw=require('./browser-runtime.cjs').playwrightPath,chrome=require('./browser-runtime.cjs').chromePath;
const options={timeout:20000},sheet='https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=17',idle={clientConfigured:true,managedClient:true,connected:false,phase:'idle',email:''};
async function workspace(t,initial={}){
 const root=path.resolve(__dirname,'../dist'),calls=[],errors=[],fixture={account:{...idle,...initial},authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=fixture',readStatus:200};
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html',file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}let body=fs.readFileSync(file);if(name==='autopilot.html')body=body.toString().replace(/<script\b[^>]*src="(?!google-account-ui\.js)[^"]*"[^>]*><\/script>/g,'');res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,browser=await require(pw).chromium.launch({executablePath:chrome,headless:true}),context=await browser.newContext();
 t.after(async()=>{await context.close();await browser.close();await new Promise(r=>server.close(r));assert.deepEqual(errors,[]);});
 await context.addInitScript(sheet=>{window.addEventListener('pageposter:google-source-verify',async event=>{try{const response=await fetch('/api/lifecycle/autopilot/source/check',{method:'POST',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify({projectId:'selected-project'})});const result=await response.json();if(!response.ok)throw Error('Аккаунт подключён, но Google отказал в чтении выбранной таблицы.');event.detail.resolve(result);}catch(error){event.detail.reject(error);}});window.externalOpens=[];window.pageposterDesktop={openGooglePage:async url=>{window.externalOpens.push(url);return {opened:true};}};window.addEventListener('pageposter:google-account-prepare',event=>{window.finishGooglePrepare=()=>window.prepareError?event.detail.reject(Error(window.prepareError)):event.detail.resolve({spreadsheetUrl:sheet,projectId:'selected-project'});if(!window.delayGooglePrepare)window.finishGooglePrepare();});},sheet);
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();calls.push({path:url.pathname,method:req.method(),body:req.postDataJSON(),headers:req.headers()});let data;
 if(url.pathname==='/api/lifecycle/google/account')data={account:{...fixture.account}};
 else if(url.pathname==='/api/lifecycle/google/client'){
  await fixture.beforeClient?.();
  if(req.postDataJSON()?.expectedUnconfigured&&fixture.account.clientConfigured)return route.fulfill({status:409,contentType:'application/json',body:'{"code":"CONFLICT"}'});
  fixture.account={...fixture.account,clientConfigured:true};data={account:fixture.account};
 }
 else if(url.pathname==='/api/lifecycle/google/connect'){fixture.account={...fixture.account,phase:'waiting'};data={authorizationUrl:fixture.authorizationUrl,status:fixture.account,expiresAt:Date.now()+300000};}
 else if(url.pathname==='/api/lifecycle/google/cancel'){fixture.account={...fixture.account,phase:fixture.account.connected?'connected':'idle'};data={account:fixture.account};}
 else if(url.pathname==='/api/lifecycle/google/disconnect'){fixture.account={...idle};data={account:fixture.account};}
 else if(url.pathname==='/api/lifecycle/autopilot/status')data={source:{authMode:'user',spreadsheetId:'fixture-sheet',spreadsheetUrl:sheet,range:'B:O',columns:{url:'B'}}};
 else if(url.pathname==='/api/lifecycle/autopilot/source/check'){await fixture.beforeRead?.();if(fixture.readStatus!==200)return route.fulfill({status:fixture.readStatus,contentType:'application/json',body:JSON.stringify({code:'source_access_denied',message:'private-provider-detail'})});data={candidateCount:57,issueCount:0,sample:[]};}
 else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});});
 const page=await context.newPage();page.setDefaultTimeout(3500);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const open=async(mode='user')=>{await page.evaluate(mode=>{const dialog=document.getElementById('ap-settings');if(!dialog.open)dialog.showModal();window.dispatchEvent(new CustomEvent('pageposter:settings-opened',{detail:{source:{authMode:mode}}}));},mode);if(mode!=='service'&&fixture.account.clientConfigured)await page.locator('#ga-connect:enabled').waitFor();};
 return {page,calls,fixture,open};
}
const posts=calls=>calls.filter(c=>c.method==='POST');
const clean={clientConfigured:false,managedClient:false};
const desktopClient={client_id:'fake-client.apps.googleusercontent.com',client_secret:'fake-secret'};
const registration=(contents=JSON.stringify({installed:{...desktopClient,project_id:'ignored-project'}}))=>({name:'desktop.json',mimeType:'application/json',buffer:Buffer.from(contents)});
test('a clean profile can import a Desktop registration before explicitly signing in',options,async t=>{
 const {page,calls,open}=await workspace(t,clean);await open();
 await page.locator('#ga-setup').waitFor();
 assert.equal(await page.locator('#ga-connect').isEnabled(),false);
 await page.locator('#ga-client-file').setInputFiles(registration());
 assert.deepEqual(posts(calls),[]);
 await page.locator('#ga-client-import').click();
 await page.locator('#ga-connect:enabled').waitFor();
 assert.equal(await page.locator('#ga-client-file').count(),0);
 assert.doesNotMatch(await page.locator('#ga-user').textContent(),/fake-secret|fake-client|ignored-project/);
 assert.deepEqual(posts(calls).map(c=>[c.path,c.body]),[['/api/lifecycle/google/client',{client:{installed:desktopClient},expectedUnconfigured:true}]]);
 assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);
 await page.locator('#ga-connect').click();
 await page.locator('#ga-cancel:visible').waitFor();
 assert.equal(posts(calls).at(-1).path,'/api/lifecycle/google/connect');
});
test('invalid Google registration files are rejected locally and cleared',options,async t=>{
 const {page,calls,open}=await workspace(t,clean);await open();
 for(const contents of [
  '[broken fake-secret',
  JSON.stringify({type:'service_account',private_key:'fake-secret'}),
  JSON.stringify({installed:{...desktopClient,client_id:'invalid-client'}}),
  JSON.stringify({web:desktopClient}),
  JSON.stringify({installed:desktopClient,padding:' '.repeat(32768)}),
 ]){
  await page.locator('#ga-client-file').setInputFiles(registration(contents));
  await page.locator('#ga-client-import').click();
  await page.locator('#ga-note.error:visible').waitFor();
  assert.equal(await page.locator('#ga-client-file').inputValue(),'');
  assert.equal(await page.locator('#ga-connect').isEnabled(),false);
  assert.doesNotMatch(await page.locator('#ga-user').textContent(),/fake-secret/);
 }
 assert.deepEqual(posts(calls),[]);
 assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);
});
test('a stale setup window refreshes to the registration configured by another window',options,async t=>{
 const {page,calls,fixture,open}=await workspace(t,clean);await open();
 await page.locator('#ga-client-file').setInputFiles(registration());
 fixture.account={...idle,managedClient:false};
 await page.locator('#ga-client-import').click();
 await page.locator('#ga-connect:enabled').waitFor();
 assert.equal(await page.locator('#ga-setup').count(),0);
 await page.locator('#ga-note').getByText(/Вхід через Google уже налаштовано/).waitFor();
 assert.deepEqual(calls.map(call=>call.path),['/api/lifecycle/google/account','/api/lifecycle/google/client','/api/lifecycle/google/account']);
 assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);
});
test('closing settings during registration import clears the selection and cannot start sign-in',options,async t=>{
 const {page,calls,fixture,open}=await workspace(t,clean);let release;
 const gate=new Promise(resolve=>release=resolve);
 fixture.beforeClient=()=>gate;
 try{
  await open();
  await page.locator('#ga-client-file').setInputFiles(registration());
  const pending=page.waitForRequest(req=>req.url().endsWith('/google/client'));
  await page.locator('#ga-client-import').click();
  await pending;
  await page.evaluate(()=>document.getElementById('ap-settings').close());
  await page.locator('#ga-client-file').waitFor({state:'detached'});
  const response=page.waitForResponse(res=>res.url().endsWith('/google/client'));
  release();await response;
  await open();
  assert.equal(await page.locator('#ga-client-file').count(),0);
  assert.equal(await page.locator('#ga-note').isVisible(),false);
  assert.deepEqual(posts(calls).map(c=>c.path),['/api/lifecycle/google/client']);
  assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);
 }finally{release();}
});
test('normal account sign-in has one Google button, no extension or user client setup',options,async t=>{
 const {page,calls,open}=await workspace(t);await open();assert.equal(await page.locator('#ga-mode').inputValue(),'user');for(const id of ['ga-setup','ga-client-file','ga-reader-install'])assert.equal(await page.locator('#'+id).count(),0);assert.doesNotMatch(await page.locator('#ga-user').textContent(),/JSON|Google Cloud|расширени/i);await page.locator('#ga-connect').click();await page.locator('#ga-status').getByText(/Завершіть вхід/).waitFor();assert.equal(posts(calls)[0].path,'/api/lifecycle/google/connect');assert.match((await page.evaluate(()=>window.externalOpens))[0],/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);assert.equal(calls.some(c=>c.path.includes('/browser/')),false);assert.equal(calls.some(c=>c.path.endsWith('/source/check')),false);
});
test('successful Google grant automatically reads the selected source with the project criteria',options,async t=>{
 const {page,calls,fixture,open}=await workspace(t);await open();await page.locator('#ga-connect').click();await page.locator('#ga-cancel:visible').waitFor();fixture.account={...idle,connected:true,phase:'connected',email:'work@example.com'};await page.locator('#ga-note').getByText(/Таблицю прочитано. Придатних сайтів: 57/).waitFor();assert.equal(await page.locator('#ga-status').textContent(),'Підключений акаунт: work@example.com');assert.deepEqual(posts(calls).find(c=>c.path.endsWith('/source/check')).body,{projectId:'selected-project'});assert.equal(await page.locator('#ga-open-link').isVisible(),false);
});
test('Google account access is not presented as a successful Sheet read when reading is denied',options,async t=>{
 const {page,fixture,open}=await workspace(t);fixture.readStatus=403;await open();await page.locator('#ga-connect').click();fixture.account={...idle,connected:true,phase:'connected',email:'other@example.com'};await page.locator('#ga-note').getByText(/Google отказал в чтении/).waitFor();assert.doesNotMatch(await page.locator('#ga-user').textContent(),/Таблицю прочитано|private-provider-detail/);
});
test('closing during source preparation cannot start a Google sign-in afterward',options,async t=>{
 const {page,calls,open}=await workspace(t);await open();await page.evaluate(()=>window.delayGooglePrepare=true);await page.locator('#ga-connect').click();await page.waitForFunction(()=>typeof window.finishGooglePrepare==='function');await page.evaluate(()=>document.getElementById('ap-settings').close());await page.evaluate(()=>window.finishGooglePrepare());assert.equal(posts(calls).length,0);assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);
});
test('switching from service account needs no files and foreign sign-in URLs are rejected',options,async t=>{
 const {page,calls,fixture,open}=await workspace(t);await open('service');assert.equal(await page.locator('#ga-user').isVisible(),false);await page.locator('#ga-mode').selectOption('user');await page.locator('#ga-connect:enabled').waitFor();assert.deepEqual(posts(calls),[]);fixture.authorizationUrl='https://evil.example/';await page.locator('#ga-connect').click();await page.locator('#ga-note').getByText(/неприпустиму адресу/).waitFor();assert.deepEqual(await page.evaluate(()=>window.externalOpens),[]);await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#ap-settings').evaluate(d=>d.scrollWidth<=d.clientWidth+1),true);
});
test('switching accounts during a pending Sheet check still checks the newly selected account',options,async t=>{
 const {page,calls,fixture,open}=await workspace(t,{connected:true,phase:'connected',email:'old@example.com'});let release,checks=0;const gate=new Promise(resolve=>release=resolve);fixture.beforeRead=async()=>{if(++checks===1)await gate;};
 try{await open();await page.waitForFunction(()=>document.getElementById('ga-note').textContent.includes('Читаємо вибрану'));await page.locator('#ga-connect').click();await page.locator('#ga-cancel:visible').waitFor();fixture.account={...idle,connected:true,phase:'connected',email:'new@example.com'};await page.locator('#ga-note').getByText(/Таблицю прочитано/).waitFor();assert.equal(checks,2);assert.match(await page.locator('#ga-status').textContent(),/new@example.com/);assert.equal(posts(calls).filter(c=>c.path.endsWith('/source/check')).length,2);}finally{release();}
});
