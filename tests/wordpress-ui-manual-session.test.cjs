'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const html=text=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});
const loginForm='<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input type="submit" value="Log in"></form>';
const credentials={username:'fixture-admin',applicationPassword:'fixture-password'};
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t,{challenge='captcha',launchGate=null}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs'),calls=[],launches=[];
 const transport=async(address,init={})=>{
  const url=new URL(address),method=init.method||'GET';calls.push({address,method,headers:init.headers,body:init.body?.toString()});
  if(url.hostname==='www.google.com'&&url.pathname==='/recaptcha/api2/anchor')return html('<button id="human" onclick="fetch(\'/recaptcha/api2/userverify\',{method:\'POST\',body:\'fixture-manual-response\'}).then(r=>r.json()).then(()=>parent.postMessage(\'fixture-solved\',\'https://wp.example\'))">Human fixture action</button>');
  if(url.hostname==='www.google.com'&&url.pathname==='/recaptcha/api2/userverify')return {status:200,headers:{'content-type':'application/json'},text:'{"ok":true}'};
  if(url.hostname==='assets-eu.hcaptcha.com'&&url.pathname==='/static/widget.html')return html('<img id="challenge-image" src="https://imgs2.hcaptcha.com/0123456789abcdef.png"><button id="human" onclick="fetch(\'https://api2.hcaptcha.com/checkcaptcha/fixture-sitekey\',{method:\'POST\',body:\'fixture-manual-response\'}).then(r=>r.json()).then(()=>parent.postMessage(\'fixture-solved\',\'https://wp.example\'))">Human fixture action</button>');
  if(url.hostname==='imgs2.hcaptcha.com')return {status:200,headers:{'content-type':'image/png'},body:pixel};
  if(url.hostname==='api2.hcaptcha.com'&&url.pathname==='/checkcaptcha/fixture-sitekey')return {status:200,headers:{'content-type':'application/json','access-control-allow-origin':'https://assets-eu.hcaptcha.com'},text:'{"ok":true}'};
  assert.ok(['wp.example','next.example'].includes(url.hostname),'Unexpected network request '+address);
  if(url.pathname==='/cdn-cgi/challenge-platform/h/g/flow/fixture'&&method==='POST')return {...html('<nav id="adminmenu">Authenticated</nav>'),headers:{'content-type':'text/html; charset=utf-8','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']}};
  if(url.pathname==='/wp-admin/')return html('<nav id="adminmenu">WordPress fixture</nav>');
  if(url.pathname==='/wp-login.php'){
   if(method==='GET')return html(loginForm);
   const body=new URLSearchParams(init.body?.toString());
   if(body.get('g-recaptcha-response')==='fixture-solved'||body.get('h-captcha-response')==='fixture-solved'||body.get('otp')==='123456')return {...html('<nav id="adminmenu">Authenticated</nav>'),headers:{'content-type':'text/html; charset=utf-8','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']}};
   if(challenge==='otp')return html('<form id="two-factor-form" action="/wp-login.php" method="post"><input name="otp" autocomplete="one-time-code"><button id="human-submit">Verify</button></form>');
   if(challenge==='cloudflare')return html('<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/g/flow/fixture" method="post"><input hidden name="cf-turnstile-response"><button id="human-cloudflare" onclick="this.form.elements[\'cf-turnstile-response\'].value=\'fixture-solved\'">Human fixture action</button></form>');
   if(challenge==='hcaptcha')return html(loginForm.replace('</form>','<textarea hidden name="h-captcha-response"></textarea><iframe title="hCaptcha" src="https://assets-eu.hcaptcha.com/static/widget.html"></iframe><script>addEventListener("message",e=>{if(e.origin==="https://assets-eu.hcaptcha.com"&&e.data==="fixture-solved")document.querySelector("[name=h-captcha-response]").value=e.data;});</script></form>'));
   const widget=challenge==='iframe'?'<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor"></iframe><script>addEventListener("message",e=>{if(e.origin==="https://www.google.com"&&e.data==="fixture-solved")document.querySelector("[name=g-recaptcha-response]").value=e.data;});</script>':'<div class="g-recaptcha">Manual challenge</div><button id="human-solve" type="button" onclick="document.querySelector(\'[name=g-recaptcha-response]\').value=\'fixture-solved\'">Human fixture action</button>';
   return html(loginForm.replace('</form>','<textarea hidden name="g-recaptcha-response"></textarea>'+widget+'</form>'));
  }
  return html('Not found');
 };
 // Record the requested mode for the lifecycle test, but keep its actual
 // browser off the user's desktop even when exercising the mode-switch branch.
 const tracked={launch:async options=>{launches.push(options);if(launchGate)await launchGate;return chromium.launch({...options,headless:true});}};
 const manager=createWordPressUI({chromium:tracked,executablePath,headless:true,transport});t.after(()=>manager.close());return {manager,calls,launches};
}
async function promptly(action){let timer;try{return await Promise.race([action.then(()=>null,error=>error),new Promise(resolve=>timer=setTimeout(()=>resolve({code:'CHALLENGE_WAITED_FOR_TIMEOUT'}),1200))]);}finally{clearTimeout(timer);}}

test('CAPTCHA stops promptly and manual resume keeps the exact private page and solved token',async t=>{
 const {manager,calls}=await fixture(t),session=await manager.open('first','https://wp.example/'),page=session.page;
 const error=await promptly(session.login(credentials));assert.equal(error?.code,'BROWSER_CAPTCHA_REQUIRED');assert.equal(error.state,'needs_attention');assert.equal(page.isClosed(),false);
 assert.equal(await page.locator('#pageposter-live-status').count(),0);await manager.error('first','BROWSER_CAPTCHA_REQUIRED');assert.equal(await page.locator('#pageposter-live-status').count(),0);
 await assert.rejects(session.result('https://wp.example/'),{code:'BROWSER_CAPTCHA_REQUIRED'});
 const before=calls.length;await assert.rejects(manager.resume('first'),{code:'BROWSER_CAPTCHA_REQUIRED'});assert.equal(calls.length,before);assert.equal(await manager.open('first','https://wp.example/'),session);
 await page.locator('#human-solve').click();assert.equal(await manager.resume('first'),true);assert.equal(session.page,page);assert.equal(calls.length,before);
 await session.login(credentials);assert.equal(await page.locator('#adminmenu').innerText(),'Authenticated');assert.equal(calls.filter(c=>c.method==='GET'&&new URL(c.address).pathname==='/wp-login.php').length,1);assert.equal(calls.filter(c=>c.method==='POST').length,2);
});

test('2FA is detected before the login wait and human submission resumes without navigation or credential replay',async t=>{
 const {manager,calls}=await fixture(t,{challenge:'otp'}),session=await manager.open('first','https://wp.example/'),page=session.page;
 const error=await promptly(session.login(credentials));assert.equal(error?.code,'BROWSER_LOGIN_REQUIRED');const before=calls.length;
 await assert.rejects(manager.resume('first'),{code:'BROWSER_LOGIN_REQUIRED'});assert.equal(calls.length,before);
 await page.locator('[name=otp]').fill('123456');await page.locator('#human-submit').click();await page.locator('#adminmenu').waitFor();
 const after=calls.length;assert.equal(await manager.resume('first'),true);await session.login(credentials);assert.equal(session.page,page);assert.equal(calls.length,after);
});

test('one browser rotates private contexts only after done and unfinished sessions cannot be replaced',async t=>{
 const {manager,launches}=await fixture(t),first=await manager.open('first','https://wp.example/'),browser=first.page.context().browser(),listeners=browser.listenerCount('disconnected');
 await first.page.context().addCookies([{name:'fixture_private',value:'first-only',url:'https://wp.example/'}]);
 await assert.rejects(manager.open('second','https://next.example/'),{code:'BROWSER_BUSY'});assert.equal(first.page.isClosed(),false);assert.equal(launches.length,1);
 await manager.done('first');assert.equal(first.page.isClosed(),false);const second=await manager.open('second','https://next.example/');
 assert.equal(first.page.isClosed(),true);assert.equal(second.page.context().browser(),browser);assert.equal(browser.contexts().length,1);assert.equal(launches.length,1);assert.equal((await second.page.context().cookies()).some(c=>c.name==='fixture_private'),false);assert.equal(browser.listenerCount('disconnected'),listeners,'Retired contexts must release browser listeners.');
});

test('the private publication context never retains an extra popup page',async t=>{
 const {manager}=await fixture(t),session=await manager.open('first','https://wp.example/');
 await session.page.evaluate(()=>window.open('/wp-admin/','_blank'));await new Promise(resolve=>setTimeout(resolve,200));
 assert.equal(session.page.context().pages().length,1);assert.equal(session.page.isClosed(),false);
});

test('concurrent opens reserve one run before launch and same-run calls share the pending session',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),{manager,launches}=await fixture(t,{launchGate:gate});
 const a=manager.open('first','https://wp.example/'),same=manager.open('first','https://wp.example/');
 try{const error=await promptly(manager.open('second','https://next.example/'));assert.equal(error?.code,'BROWSER_BUSY');}finally{release();await Promise.allSettled([a,same]);}
 const [first,reused]=await Promise.all([a,same]);assert.equal(first,reused);assert.equal(launches.length,1);assert.equal(first.page.context().browser().contexts().length,1);
});

test('auth fallback resets one run context without churning the browser and missing or closed resume returns false',async t=>{
 const {manager,launches}=await fixture(t);assert.equal(await manager.resume('missing'),false);const first=await manager.open('first','https://wp.example/'),browser=first.page.context().browser();
 await manager.reset('first');assert.equal(first.page.isClosed(),true);assert.equal(await manager.resume('first'),false);
 const replacement=await manager.open('first','https://next.example/');assert.equal(replacement.page.context().browser(),browser);assert.equal(launches.length,1);await replacement.page.close();assert.equal(await manager.resume('first'),false);
 await manager.done('first');const next=await manager.open('second','https://wp.example/');assert.equal(next.page.context().browser(),browser);
});

test('an explicitly reset cancelled owner releases the private browser for another run',async t=>{
 const {manager,launches}=await fixture(t),first=await manager.open('first','https://wp.example/'),browser=first.page.context().browser();
 await manager.reset('first');const next=await manager.open('second','https://next.example/');assert.equal(first.page.isClosed(),true);assert.equal(next.page.context().browser(),browser);assert.equal(launches.length,1);
});

test('a requested visibility change relaunches only after the previous run completes',async t=>{
 const {manager,launches}=await fixture(t),first=await manager.open('first','https://wp.example/',{headless:true}),browser=first.page.context().browser();
 await assert.rejects(manager.open('second','https://next.example/',{headless:false}),{code:'BROWSER_BUSY'});assert.equal(browser.isConnected(),true);
 await manager.done('first');const second=await manager.open('second','https://next.example/',{headless:false});assert.equal(launches.length,2);assert.equal(browser.isConnected(),false);assert.equal(second.page.context().browser().isConnected(),true);
 assert.deepEqual(launches.map(options=>options.headless),[true,false]);
});

test('known CAPTCHA iframe uses guarded transport and manual POST while unrelated endpoints stay blocked',async t=>{
 const {manager,calls}=await fixture(t,{challenge:'iframe'}),session=await manager.open('first','https://wp.example/'),page=session.page;
 await page.evaluate(async()=>{await fetch('https://www.google.com/recaptcha/api2/userverify',{method:'POST',body:'unarmed'}).catch(()=>{});});assert.equal(calls.some(c=>c.address.includes('userverify')),false);
 const error=await promptly(session.login(credentials));assert.equal(error?.code,'BROWSER_CAPTCHA_REQUIRED');await page.frameLocator('iframe[title=reCAPTCHA]').locator('#human').waitFor();
 await page.frameLocator('iframe[title=reCAPTCHA]').locator('#human').click();await page.waitForFunction(()=>document.querySelector('[name=g-recaptcha-response]')?.value==='fixture-solved');
 assert.ok(calls.some(c=>c.address==='https://www.google.com/recaptcha/api2/userverify'&&c.method==='POST'));
 const before=calls.length;await page.evaluate(async()=>{await Promise.all(['https://evil.example/recaptcha/api2/anchor','https://www.google.com/private','https://127.0.0.1/recaptcha/api2/anchor'].map(url=>fetch(url).catch(()=>{})));});assert.equal(calls.length,before);
 assert.equal(await manager.resume('first'),true);await session.login(credentials);assert.equal(await page.locator('#adminmenu').innerText(),'Authenticated');
});

test('manual Cloudflare verification permits only its bounded same-origin challenge POST',async t=>{
 const {manager,calls}=await fixture(t,{challenge:'cloudflare'}),session=await manager.open('first','https://wp.example/'),page=session.page,path='/cdn-cgi/challenge-platform/h/g/flow/fixture';
 await page.evaluate(async path=>{await fetch(path,{method:'POST',body:'unarmed'}).catch(()=>{});},path);assert.equal(calls.some(c=>new URL(c.address).pathname===path),false);
 const error=await promptly(session.login(credentials));assert.equal(error?.code,'BROWSER_CAPTCHA_REQUIRED');const before=calls.length;
 await page.evaluate(async()=>{await Promise.all(['/wp-admin/post.php','/cdn-cgi/challenge-platform/%2e%2e%2fwp-admin%2fpost.php'].map(path=>fetch(path,{method:'POST',body:'action=editpost&publish=1&post_ID=99'}).catch(()=>{})));});assert.equal(calls.length,before);
 await page.locator('#human-cloudflare').click();await page.locator('#adminmenu').waitFor();assert.equal(calls.filter(c=>new URL(c.address).pathname===path&&c.method==='POST').length,1);
 const after=calls.length;assert.equal(await manager.resume('first'),true);await session.login(credentials);assert.equal(calls.length,after);
});

test('regional hCaptcha iframe and root hash images work while vendor lookalikes, unsafe ports and unrelated writes stay blocked',async t=>{
 const {manager,calls}=await fixture(t,{challenge:'hcaptcha'}),session=await manager.open('first','https://wp.example/'),page=session.page;
 await page.evaluate(async()=>{await fetch('https://api2.hcaptcha.com/checkcaptcha/fixture-sitekey',{method:'POST',body:'unarmed'}).catch(()=>{});});assert.equal(calls.some(c=>c.address.includes('api2.hcaptcha.com')),false);
 const error=await promptly(session.login(credentials));assert.equal(error?.code,'BROWSER_CAPTCHA_REQUIRED');
 const frame=page.frameLocator('iframe[title=hCaptcha]');await frame.locator('#human').waitFor({timeout:5000});assert.equal(await frame.locator('#challenge-image').evaluate(image=>image.complete&&image.naturalWidth>0),true);
 assert.ok(calls.some(c=>c.address==='https://assets-eu.hcaptcha.com/static/widget.html'&&c.method==='GET'));assert.ok(calls.some(c=>c.address==='https://imgs2.hcaptcha.com/0123456789abcdef.png'&&c.method==='GET'));
 const before=calls.length;await page.evaluate(async()=>{await Promise.all(['https://imgs2.hcaptcha.com.evil.example/fixture.png','https://evil-hcaptcha.com/fixture.png','https://hcaptcha.com.evil.example/1/api.js','http://imgs2.hcaptcha.com/fixture.png','https://imgs2.hcaptcha.com:444/fixture.png'].map(url=>fetch(url).catch(()=>{})));await fetch('https://api2.hcaptcha.com/siteverify',{method:'POST',body:'not-a-browser-endpoint'}).catch(()=>{});});assert.equal(calls.length,before);
 await frame.locator('#human').click();await page.waitForFunction(()=>document.querySelector('[name=h-captcha-response]')?.value==='fixture-solved');assert.ok(calls.some(c=>c.address==='https://api2.hcaptcha.com/checkcaptcha/fixture-sitekey'&&c.method==='POST'));
 assert.equal(await manager.resume('first'),true);await session.login(credentials);assert.equal(await page.locator('#adminmenu').innerText(),'Authenticated');assert.equal(session.page,page);
});
