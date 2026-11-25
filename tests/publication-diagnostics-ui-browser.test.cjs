'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath,chromePath=require('./browser-runtime.cjs').chromePath;
const options={timeout:30000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
const publication=(state='verification_unknown',extra={})=>({state,postId:1106,url:'https://published.example/exact%2Fpath/?q=%2B#proof',checkpoint:'dispatching',cleanupPhase:null,canReconcile:true,revision:7,diagnostics:[],recovery:null,lastEvidence:{observation:'unknown',at:'2026-11-02T00:00:00Z'},capabilities:null,...extra});
const run=(id='r1',extra={})=>({id,projectId:'p1',state:'uncertain',stage:'publishing',source:'html',title:'Page '+id,revision:7,hasHtml:false,publication:publication(),...extra});
async function workspace(t,runs=[run()],{desktop=false}={}){
 const root=path.resolve(__dirname,'../dist'),fixture={runs},calls=[],errors=[];
 const server=http.createServer((req,res)=>{const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1)||'index.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const {chromium}=require(playwrightPath),browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();let data;
  if(endpoint==='/projects')data={projects:[{id:'p1',name:'Fixture project',workflowType:'html'}]};
  else if(endpoint==='/autopilot/status')data={source:{configured:false},aiConfigured:false};
  else if(endpoint==='/project-queue')data={projects:[{projectId:'p1',name:'Fixture project',type:'html',counts:{total:runs.length},items:fixture.runs.map(r=>({...r,id:'q'+r.id,runId:r.id,key:r.id,language:'en',geo:'GB',canApprove:false}))}],generation:{active:0,waiting:0},publication:{active:0,waiting:1}};
  else if(endpoint.endsWith('/reconciliation')){const r=fixture.runs.find(r=>endpoint==='/autopilot/'+r.id+'/reconciliation');data={run:r,publication:r.publication};}
  else if(endpoint==='/projects/p1/autopilot')data={runs:fixture.runs};
  else if(endpoint.endsWith('/jobs'))data={jobs:[]};
  else if(endpoint.endsWith('/pages')||endpoint.endsWith('/overview'))data={pages:[]};
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 if(desktop)await context.addInitScript(()=>{window.pageposterDesktop={showAppMenu:async()=>({opened:true})};});
 const page=await context.newPage();page.setDefaultTimeout(5500);page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{const url=new URL(req.url());if(url.pathname.startsWith('/api/'))calls.push({endpoint:url.pathname.replace('/api/lifecycle',''),method:req.method(),body:req.postDataJSON(),guard:req.headers()['x-pageposter-request']});});await page.goto(origin+'/autopilot.html');await page.locator('[data-run-id="'+runs[0].id+'"]').first().waitFor({state:'attached'});return {page,fixture,calls};
}

test('known published, CAPTCHA and automatic recovery have truthful labels in cards and queue',options,async t=>{
 const runs=[run('published',{state:'failed',publication:publication('verification_unknown',{checkpoint:'published',lastEvidence:{observation:'published'}})}),run('captcha',{state:'needs_attention',error:{code:'BROWSER_CAPTCHA_REQUIRED'},publication:publication('manual_action',{postId:null,url:null,canReconcile:false})}),run('recover',{state:'failed',error:{code:'READ_TIMEOUT',message:'Temporary failure'},publication:publication('reconciling',{recovery:{state:'reading',attempt:1,limit:3}})})],{page,calls}=await workspace(t,runs);
 assert.match(await page.locator('[data-run-id=published] .ap-badge').textContent(),/Опубліковано.*перевірка/);assert.match(await page.locator('[data-run-id=captcha] .ap-badge').textContent(),/CAPTCHA|ручн/);assert.match(await page.locator('[data-run-id=recover] .ap-badge').textContent(),/Звіряємо|Повторюємо/);assert.equal(await page.locator('[data-run-id=recover] .ap-badge.error').count(),0);assert.doesNotMatch(await page.locator('[data-run-id=recover]').textContent(),/Temporary failure/);
 assert.equal(await page.locator('[data-run-id=published]').getByRole('button',{name:'Продовжити зі збереженого кроку'}).count(),0);
 await page.locator('#pq-dashboard-open').click();assert.match(await page.locator('[data-queue-item=qpublished] .pq-state').textContent(),/Опубліковано.*перевірка/);assert.match(await page.locator('[data-queue-item=qcaptcha] .pq-state').textContent(),/CAPTCHA|ручн/);assert.equal(await page.locator('[data-queue-item=qcaptcha] .pq-error').count(),0);assert.equal(await page.locator('[data-queue-item=qrecover] .pq-error').count(),0);assert.equal(await page.locator('[data-queue-item=qpublished] [data-action=retry]').count(),0);assert.equal(calls.filter(c=>c.method==='POST').length,0);
});

test('a login timeout is distinguished from exhausted recovery in the queue',options,async t=>{
 const blocked=extra=>publication('blocked',{postId:null,url:null,checkpoint:null,lastEvidence:null,canReconcile:false,...extra});
 const {page}=await workspace(t,[
  run('login',{state:'needs_attention',stage:'installing',error:{code:'BROWSER_TIMEOUT'},publication:blocked({diagnostics:[{phase:'login',code:'BROWSER_TIMEOUT',httpStatus:200}]})}),
  run('exhausted',{state:'failed',publication:blocked({recovery:{state:'exhausted',attempt:3,limit:3}})})
 ]);
 await page.locator('#pq-dashboard-open').click();
 assert.equal(await page.locator('[data-queue-item=qlogin] .pq-state').textContent(),'Вхід у WordPress не підтверджено');
 assert.match(await page.locator('[data-queue-item=qexhausted] .pq-state').textContent(),/відновлення вичерпано/);
});

test('one reconciliation dialog reads the exact identity and only explicitly checks with its revision',options,async t=>{
 const {page,calls}=await workspace(t);await page.route('**/api/lifecycle/autopilot/r1/reconcile',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({run:run('r1',{revision:8,publication:publication('published_checking',{revision:8,canReconcile:false,lastEvidence:{observation:'published'}})}),publication:publication('published_checking',{revision:8,canReconcile:false,lastEvidence:{observation:'published'}}),observation:'published'})}));
 const opener=page.locator('[data-run-id=r1] [data-action=reconcile]');await opener.click();const dialog=page.locator('#ap-reconciliation');await dialog.locator('#ap-reconciliation-check:enabled').waitFor();assert.equal(await page.locator('#ap-reconciliation').count(),1);assert.match(await dialog.textContent(),/1106/);assert.match(await dialog.textContent(),/dispatching/);assert.equal(await dialog.locator('a').getAttribute('href'),publication().url);assert.equal(await dialog.locator('input[type=checkbox]').count(),0);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await dialog.locator('#ap-reconciliation-check').click();await dialog.locator('#ap-reconciliation-note').getByText(/Опубліковано/).waitFor();assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>({endpoint:c.endpoint,body:c.body,guard:c.guard})),[{endpoint:'/autopilot/r1/reconcile',body:{expectedRevision:7},guard:'1'}]);assert.equal(await dialog.locator('#ap-reconciliation-check').isDisabled(),true);await dialog.locator('[data-close=ap-reconciliation]').click();assert.equal(await opener.evaluate(n=>n===document.activeElement),true);
});

test('late identity reads cannot overwrite a reopened reconciliation selection and requests stay serial',options,async t=>{
 const {page,calls}=await workspace(t,[run(),run('r2',{publication:publication('draft',{postId:2200,url:null,revision:9}),revision:9})]);let release,entered;const started=new Promise(resolve=>entered=resolve);await page.route('**/api/lifecycle/autopilot/r1/reconciliation',async route=>{entered();await new Promise(resolve=>release=resolve);await route.fulfill({contentType:'application/json',body:JSON.stringify({run:run(),publication:publication()})});});
 await page.locator('[data-run-id=r1] [data-action=reconcile]').click();await started;await page.locator('#ap-reconciliation [data-close]').click();await page.locator('[data-run-id=r2] [data-action=reconcile]').click();assert.equal(await page.locator('#ap-reconciliation-check').isDisabled(),true);assert.equal(calls.filter(c=>c.endpoint==='/autopilot/r2/reconciliation').length,0);release();await page.locator('#ap-reconciliation-check:enabled').waitFor();assert.match(await page.locator('#ap-reconciliation-identity').textContent(),/2200/);assert.doesNotMatch(await page.locator('#ap-reconciliation-identity').textContent(),/1106/);assert.equal(calls.filter(c=>c.method==='POST').length,0);
});

test('a stale revision or uncertain check requires fresh evidence before another explicit check',options,async t=>{
 const {page,calls}=await workspace(t);await page.route('**/api/lifecycle/autopilot/r1/reconcile',route=>route.fulfill({status:409,contentType:'application/json',body:'{"code":"CONFLICT","error":"Стан змінився. Оновіть дані."}'}));await page.locator('[data-run-id=r1] [data-action=reconcile]').click();await page.locator('#ap-reconciliation-check:enabled').waitFor();await page.locator('#ap-reconciliation-check').click();await page.locator('#ap-reconciliation-note.error').waitFor();assert.equal(await page.locator('#ap-reconciliation-check').isDisabled(),true);await page.locator('#ap-reconciliation-refresh').click();await page.locator('#ap-reconciliation-check:enabled').waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,1);
});

test('diagnostics stay bounded to structured fields and old records make no reconciliation requests',options,async t=>{
 const diagnostics=Array.from({length:30},()=>({phase:'editor_open',code:'READ_TIMEOUT',httpStatus:504,elapsedMs:1200,budgetMs:4000,method:'GET',safeReadRetries:2,message:'PRIVATE raw exception',url:'https://private.invalid/token',html:'<b>PRIVATE HTML</b>'}));const {page,calls}=await workspace(t,[run('r1',{publication:publication('verification_unknown',{diagnostics})}),run('legacy',{publication:null})]);await page.locator('[data-run-id=r1] [data-publication-diagnostics] summary').click();const box=page.locator('[data-run-id=r1] [data-publication-diagnostics]');assert.match(await box.textContent(),/READ_TIMEOUT.*504/);assert.doesNotMatch(await box.textContent(),/PRIVATE|private.invalid/);assert.ok(await box.locator('li').count()<=12);assert.equal(await page.locator('[data-run-id=legacy] [data-action=reconcile]').count(),0);assert.equal(calls.filter(c=>c.endpoint.endsWith('/reconciliation')).length,0);
});

test('advanced support download sends only an empty guarded payload and retains its busy lock',options,async t=>{
 const {page,calls}=await workspace(t,[run()],{desktop:true});let release,entered;const started=new Promise(resolve=>entered=resolve);await page.route('**/api/lifecycle/support/export',async route=>{entered();await new Promise(resolve=>release=resolve);await route.fulfill({contentType:'application/json',body:'{"kind":"pageposter-support","counts":{"runs":1}}'});});
 await page.locator('#ap-settings-open').click();await page.locator('[data-settings-tab=advanced]').click();await page.locator('.ap-support-settings > summary').click();await page.locator('#ap-support-download').click();await started;assert.equal(await page.locator('#ap-support-download').isDisabled(),true);await page.locator('#ap-settings [data-close=ap-settings]').click();await page.locator('#ap-settings-open').click();await page.locator('[data-settings-tab=advanced]').click();assert.equal(await page.locator('#ap-support-download').isDisabled(),true);const downloaded=page.waitForEvent('download');release();const file=await downloaded;assert.match(file.suggestedFilename(),/support.*\.json$/);const data=JSON.parse(fs.readFileSync(await file.path(),'utf8'));assert.equal(data.kind,'pageposter-support');assert.deepEqual(calls.filter(c=>c.method==='POST'),[{endpoint:'/support/export',method:'POST',body:{},guard:'1'}]);
});

test('a saved URL without publication proof stays unknown while a published checkpoint stays published',options,async t=>{
 const {page}=await workspace(t,[run('sent',{verification:{state:'unknown',diagnostics:{linkSummary:{outsideUrls:3}}}}),run('known',{publication:publication('verification_unknown',{url:null,checkpoint:'published'})})]);assert.doesNotMatch(await page.locator('[data-run-id=sent] .ap-badge').textContent(),/Опубліковано/);assert.match(await page.locator('[data-run-id=known] .ap-badge').textContent(),/Опубліковано/);
});

test('automatic recovery continues polling even if the underlying legacy run state was failed',options,async t=>{
 const {page,fixture}=await workspace(t,[run('recovery',{state:'failed',publication:publication('reconciling',{recovery:{state:'waiting',attempt:1,limit:3}})})]);fixture.runs[0].publication=publication('published_checking',{checkpoint:'published'});await page.locator('[data-run-id=recovery] .ap-badge').getByText('Опубліковано · перевіряємо',{exact:true}).waitFor();
});

test('working recovery belongs to the active filter while attention waits for exhausted recovery',options,async t=>{
 const {page}=await workspace(t,[run('recovery',{state:'failed',publication:publication('reconciling',{recovery:{state:'waiting',attempt:1,limit:3}})})]);await page.locator('#ap-filter').selectOption('active');assert.equal(await page.locator('[data-run-id=recovery]').count(),1);await page.locator('#ap-filter').selectOption('attention');assert.equal(await page.locator('[data-run-id=recovery]').count(),0);await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item=qrecovery]').waitFor();await page.locator('#pq-filter-state').selectOption('active');assert.equal(await page.locator('[data-queue-item=qrecovery]').count(),1);await page.locator('#pq-filter-state').selectOption('attention');assert.equal(await page.locator('[data-queue-item=qrecovery]').count(),0);
});

test('browser diagnostics distinguish our destinations, native hrefs, repeated controls and outside theme links',options,async t=>{
 const verification={state:'problem',summary:'Є сторонні посилання теми.',diagnostics:{code:'PUBLISHED_OUTSIDE_LINKS',linkSummary:{expectedUrls:2,ourUrls:2,nativeHrefs:7,repeatedControls:5,outsideUrls:3,unexpectedOurUrls:0}}},{page}=await workspace(t,[run('r1',{verification,publication:publication('verification_unknown',{checkpoint:'published'})})]);await page.locator('[data-run-id=r1] [data-check-diagnostics] summary').click();const details=await page.locator('[data-run-id=r1] [data-check-diagnostics]').textContent();assert.match(details,/Наші адреси: 2 \/ 2/);assert.match(details,/href: 7/);assert.match(details,/Повторні кнопки: 5/);assert.match(details,/Сторонні адреси теми: 3/);assert.equal(await page.locator('[data-run-id=r1] .ap-badge.good').count(),0);
});
