'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {chromium}=require('./browser-runtime.cjs').playwright;
const chromePath=require('./browser-runtime.cjs').chromePath;
const detail='Arbitrary site scripts, handlers or embedded documents require an externally isolated browser runner.';
const live={progress:{stage:'public_assets',elapsedMs:900,budgetMs:30000},state:'unknown',code:'unsupported_page_scripts',scope:'public-snapshot',evidence:detail,network:{untrustedScripts:1,blockedAssets:2,failedAssets:0,fetchedAssets:3,deniedBrowserRequests:0},viewports:[{name:'desktop',width:1440,height:900,checks:[{kind:'overflow',state:'ok',evidence:'No horizontal overflow detected at this viewport.'},{kind:'clicks',state:'ok',evidence:'Activated 2 controls; destinations were intercepted without partner navigation. 0 failed.'}],snapshot:{headings:[{text:'PRIVATE_HTML_SECRET'}]},clicks:[{destination:'https://partner.example/?token=PRIVATE_QUERY_SECRET'}]},{name:'mobile',width:390,height:844,checks:[{kind:'overflow',state:'ok',evidence:'No horizontal overflow detected at this viewport.'}]}],limitations:['PRIVATE_LIMITATION_SECRET'],stack:'PRIVATE_STACK_SECRET',rawHTTP:'PRIVATE_HTTP_SECRET'};
async function fixture(t,result=live,extra={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-check-diagnostics-'));
 const app=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,58).toString('base64'),browserVerifier:{verifyPublished:async()=>result},client:{checkPage:async()=>['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'fixture'}))},...extra});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const s=app.store,project=s.createProject({name:'Diagnostic project',workflowType:'html'}),site=s.createSite(project.id,{name:'Site',baseUrl:'https://site.example/'}),page=s.createPage(project.id,{title:'Diagnostic page',siteId:site.id,wpId:71,fullUrl:'https://site.example/offer/',config:{title:'Diagnostic page',cards:[],sections:[],faq:[]},expectedUrls:[],remoteSnapshot:{content:'<div id="pp-landing"><h1>Diagnostic page</h1></div>'}}),job=s.enqueueJob({projectId:project.id,pageId:page.id,siteId:site.id,type:'page_check',idempotencyKey:'diagnostics-check'}),run=s.createRecord(project.id,'autopilot',{state:'checking',stage:'checking',source:'html',pageId:page.id,checkJobId:job.id,links:[]});
 await app.tick();await app.tick();return {app,project,page,run};
}

test('public check code, detail, viewport and network evidence survive store, run and queue projections safely',async t=>{
 const {app,project,page,run}=await fixture(t),check=app.store.listChecks(page.id).find(c=>c.kind==='live_browser');
 assert.equal(check.evidence.code,'unsupported_page_scripts');assert.equal(check.evidence.detail,detail);assert.equal(check.evidence.network.untrustedScripts,1);
 assert.deepEqual(check.evidence.viewports.map(v=>v.name),['desktop','mobile']);assert.equal(check.evidence.viewports[0].checks[1].kind,'clicks');assert.equal(check.evidence.viewports[0].checks[1].state,'ok');
 assert.equal(Object.keys(check.evidence).some(key=>/^\d+$/.test(key)),false,'A string must never become numeric object keys.');
 const verification=app.store.getPage(page.id).verification,publicRun=app.autopilot.list(project.id).find(r=>r.id===run.id);
 assert.equal(verification.diagnostics.code,'unsupported_page_scripts');assert.match(verification.summary,/скрипт/i);
 assert.equal(publicRun.verification.diagnostics.code,'unsupported_page_scripts');assert.match(publicRun.error.message,/скрипт/i);
 const response=await app.handle(new Request('http://localhost/api/lifecycle/project-queue')),body=await response.json(),item=body.projects[0].items[0];
 assert.equal(item.verification.diagnostics.code,'unsupported_page_scripts');assert.match(item.error.message,/скрипт/i);
 for(const value of [check,verification,publicRun,body])assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|token=|rawHTTP|"snapshot":|"stack":/);
});

for(const [code,want] of [['GOOGLE_RATE_LIMITED',/Google.*обмежив.*пізніше/],['GOOGLE_READ_ABORTED',/Google.*скасовано/]])test('queue import explains '+code+' without provider error text',async t=>{
 const {app}=await fixture(t,live,{projectImporter:{preview:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_SECRET'),{code});}}});
 const response=await app.handle(new Request('http://localhost/api/lifecycle/project-import/preview',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-PagePoster-Request':'1'},body:'{}'})),body=await response.json();
 assert.equal(body.code,code);assert.match(body.error,want);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_/);
});

test('check diagnostics cap nested evidence and replace arbitrary HTML, headers, paths or secrets with local explanations',async t=>{
 const result={...live,evidence:{detail:'<html>PRIVATE_TOP_SECRET</html>',scope:'PRIVATE_SCOPE_SECRET'},network:{untrustedScripts:1,blockedAssets:-1,failedAssets:Infinity,authorization:'Bearer PRIVATE_AUTH_SECRET'},viewports:Array.from({length:100},()=>({name:'mobile',width:390,height:844,checks:Array.from({length:100},()=>({kind:'overflow',state:'problem',evidence:'HTTP/1.1 500\nAuthorization: Bearer PRIVATE_VIEW_SECRET'})),screenshot:{path:'C:/private/PRIVATE_PATH_SECRET.png'},snapshot:{html:'PRIVATE_HTML_SECRET'}}))};
 const {app,page}=await fixture(t,result),check=app.store.listChecks(page.id).find(c=>c.kind==='live_browser');
 assert.equal(check.evidence.code,'unsupported_page_scripts');assert.ok(check.evidence.viewports.length<=2);assert.ok(check.evidence.viewports.every(v=>v.checks.length<=16));assert.ok(JSON.stringify(check.evidence).length<14000);assert.equal(check.evidence.network.untrustedScripts,1);
 assert.doesNotMatch(JSON.stringify(check),/PRIVATE_|Authorization|Bearer|C:\/|HTTP\/|<html>|rawHTTP|"snapshot":|"stack":/);
});

test('active Desktop queue and inspector explain the failed browser verification without lifecycle-ui', {timeout:20000},async t=>{
 const {app,page:storedPage}=await fixture(t),root=path.resolve(__dirname,'../dist'),server=http.createServer(async(req,res)=>{
  const origin='http://127.0.0.1:'+server.address().port,address=new URL(req.url,origin);
  if(address.pathname.startsWith('/api/lifecycle')){const response=await app.handle(new Request(address,{headers:{Origin:origin}}));res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());}
  const file=path.resolve(root,address.pathname.slice(1)||'autopilot.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:chromePath,headless:true}),context=await browser.newContext(),page=await context.newPage();
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));});
 await context.addInitScript(()=>{window.pageposterDesktop={showAppMenu:async()=>({opened:true})};});page.setDefaultTimeout(5000);await page.goto('http://127.0.0.1:'+server.address().port+'/autopilot.html');
 const row=page.locator('[data-queue-item]');await row.first().waitFor();assert.match(await row.first().textContent(),/скрипт/i);
 await row.first().locator('.pq-row-open').click();await page.locator('#pq-inspector-details [data-check-diagnostics]').waitFor();
 const diagnostics=await page.locator('#pq-inspector-details [data-check-diagnostics]').textContent();assert.match(diagnostics,/unsupported_page_scripts/);assert.match(diagnostics,/desktop|Комп/i);assert.match(diagnostics,/mobile|Телефон/i);assert.match(diagnostics,/1/);assert.match(diagnostics,/Завантаження ресурсів/);assert.doesNotMatch(diagnostics,/PRIVATE_/);
 assert.equal(await page.locator('script[src$="lifecycle-ui.js"]').count(),0);assert.equal(app.store.getPage(storedPage.id).verification.state,'unknown');
});

test('asset preparation timeout carries safe phase and timing through stored diagnostics',async t=>{
 const result={state:'unknown',code:'public_assets_timeout',progress:{stage:'public_assets',elapsedMs:30000,budgetMs:30000,url:'https://PRIVATE_PROGRESS_SECRET/'},network:{fetchedAssets:31,failedAssets:2},viewports:[]};const {app,page}=await fixture(t,result),value=app.store.getPage(page.id).verification.diagnostics;assert.equal(value.code,'public_assets_timeout');assert.deepEqual(value.progress,{stage:'public_assets',elapsedMs:30000,budgetMs:30000});assert.match(app.store.getPage(page.id).verification.summary,/ресурс/);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_PROGRESS_SECRET/);
});
test('unknown progress stages and invalid timing do not leak through public evidence',async()=>{
 const {safePublishedEvidence}=await import('../server/lifecycle/published-diagnostics.mjs');for(const progress of [{stage:'PRIVATE_PROGRESS_SECRET',elapsedMs:5,budgetMs:30000},{stage:'public_assets',elapsedMs:Infinity,budgetMs:30000},{stage:'public_assets',elapsedMs:300,budgetMs:-1}]){const value=safePublishedEvidence({code:'public_assets_timeout',progress});assert.equal(value.progress,undefined);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_PROGRESS_SECRET|Infinity/);}
});
