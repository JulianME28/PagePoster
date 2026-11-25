'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const EXACT='https://partner.example/go?q=%2F&token=PRIVATE_LINK_REPORT#part';
const expected='<div id="pp-landing"><h1>Page</h1><a href="'+EXACT.replace(/&/g,'&amp;')+'">Offer</a><button data-pp-url="'+EXACT.replace(/&/g,'&amp;')+'">Again</button></div>';
async function fixture(t,options={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-link-report-'));let calls=0;
 const app=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,87).toString('base64'),client:{checkPage:async()=>{calls++;return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:kind==='robots'&&options.clientState?options.clientState:'ok'}));}},browserVerifier:{verifyPublished:async()=>({state:options.browserState||'unknown',code:options.browserState==='ok'?'published_verified':'unsupported_page_scripts',viewports:[],...(options.report?{localLinkReport:options.report}:{})})}});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const store=app.store,project=store.createProject({name:'Local reports'}),site=store.createSite(project.id,{name:'Fixture',baseUrl:'https://site.example/'}),page=store.createPage(project.id,{title:'Report page',siteId:site.id,wpId:41,fullUrl:'https://site.example/page/',remoteSnapshot:{content:expected},expectedUrls:[EXACT]});
 const req=(suffix='',headers={})=>app.handle(new Request('http://127.0.0.1:4317/api/lifecycle/pages/'+page.id+'/link-report?expectedRevision='+page.revision+suffix,{headers:{Origin:'http://127.0.0.1:4317','X-PagePoster-Request':'1',...headers}}));
 return {app,dir,project,page,req,calls:()=>calls};
}
test('explicit local report read is honest about absent captured verification and performs no check',async t=>{
 const f=await fixture(t),response=await f.req();assert.equal(response.status,200);const {report}=await response.json();assert.equal(report.state,'unavailable');assert.equal(report.verificationState,'unknown');assert.deepEqual(report.rows,[]);assert.equal(f.calls(),0);assert.equal(f.app.store.listJobs(f.project.id).length,0);
});
test('report groups exact customer/native/repeated controls separately from outside theme and unsafe addresses',async()=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs');
 const actual=expected.replace('</div>','<a href="https://extra.example/?x=%2f">Extra</a><a href="javascript:alert(1)">Unsafe</a></div>')+'<a href="https://theme.example/?q=%2F">Theme</a>';
 const r=buildPublishedLinkReport({expectedHtml:expected,actualHtml:actual,expectedUrls:[EXACT]});
 assert.equal(r.rows.find(row=>row.url===EXACT).nativeHrefs,1);assert.equal(r.rows.find(row=>row.url===EXACT).repeatedControls,1);assert.equal(r.rows.find(row=>row.url===EXACT).expectedNativeHrefs,1);assert.equal(r.rows.find(row=>row.url===EXACT).status,'expected');
 assert.equal(r.rows.find(row=>row.url.startsWith('https://theme')).scope,'outside');assert.equal(r.rows.find(row=>row.url.startsWith('https://theme')).status,'unexpected');assert.equal(r.rows.find(row=>row.url.startsWith('https://extra')).status,'unexpected');assert.equal(r.rows.find(row=>row.url.startsWith('javascript:')).status,'invalid');assert.equal(r.rows.find(row=>row.url.startsWith('javascript:')).safeHref,null);assert.equal(r.linksState,'problem');
});
test('missing destinations and changed repeated/native counts remain explicit problems',async()=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs');
 const missing=buildPublishedLinkReport({expectedHtml:expected,actualHtml:'<div id="pp-landing"></div>',expectedUrls:[EXACT]});assert.equal(missing.rows[0].status,'missing');assert.equal(missing.linksState,'problem');
 const changed=buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected.replace('data-pp-url','data-removed-url'),expectedUrls:[EXACT]});assert.equal(changed.rows[0].status,'mismatch');assert.equal(changed.rows[0].expectedRepeatedControls,1);assert.equal(changed.rows[0].repeatedControls,0);
});
test('safe links reject active schemes credentials and literal or encoded control characters without normalizing originals',async()=>{
 const {safeReportHref}=await import('../server/lifecycle/published-link-report.mjs');
 assert.equal(safeReportHref(EXACT),EXACT);
 for(const value of ['javascript:alert(1)','data:text/html,x','https://user:pass@site.example/','https://site.example/a\nb','https://site.example/%0Aevil','https://site.example/%7Fevil','https://site.example/\\evil',' https://site.example/'])assert.equal(safeReportHref(value),null,value);
});
test('row and byte limits mark incomplete output and retain full totals',async()=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs');
 const actual='<div id="pp-landing">'+Array.from({length:500},(_,i)=>'<a href="https://extra.example/'+i+'?q='+('x'.repeat(800))+'">Extra</a>').join('')+'</div>';
 const r=buildPublishedLinkReport({expectedHtml:expected,actualHtml:actual,expectedUrls:[EXACT]});assert.equal(r.truncated,true);assert.ok(r.rows.length<=200);assert.ok(Buffer.byteLength(JSON.stringify(r))<=131072);assert.equal(r.totalRows,501);assert.equal(r.linksState,'problem');
});
test('stored report reads privately from disk and revision/content/identity fences suppress stale URLs',async t=>{
 const {buildPublishedLinkReport,readLocalLinkReport}=await import('../server/lifecycle/published-link-report.mjs'),report=buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected,expectedUrls:[EXACT]}),f=await fixture(t,{report});
 f.app.store.enqueueJob({projectId:f.project.id,pageId:f.page.id,siteId:f.page.siteId,type:'page_check',idempotencyKey:'report-capture'});await f.app.tick();
 const response=await f.req(),body=await response.json();assert.equal(response.status,200);assert.equal(body.report.rows[0].url,EXACT);assert.equal(body.report.verificationState,'unknown');assert.equal(f.calls(),1);
 const local=await readLocalLinkReport(f.dir,f.app.store.getPage(f.page.id));assert.equal(local.rows[0].url,EXACT);
 for(const value of [f.app.store.listChecks(f.page.id),f.app.store.getPage(f.page.id).verification,f.app.store.listJobs(f.project.id)])assert.doesNotMatch(JSON.stringify(value),/PRIVATE_LINK_REPORT|localLinkReport|"rows"/);
 const support=await f.app.handle(new Request('http://127.0.0.1:4317/api/lifecycle/support/export',{method:'POST',headers:{Origin:'http://127.0.0.1:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},body:'{}'}));assert.doesNotMatch(await support.text(),/PRIVATE_LINK_REPORT|local-link-reports/);
 for(const patch of [{revision:f.page.revision+1},{fullUrl:'https://site.example/other/'},{wpId:42},{remoteSnapshot:{content:expected+'changed'}}])assert.equal((await readLocalLinkReport(f.dir,{...f.page,...patch})).state,'unavailable');
 f.app.store.updatePage(f.page.id,{title:'Changed'},f.page.revision);assert.equal((await f.req()).status,409);
});
test('private endpoint bounds and projects persisted report fields rather than returning arbitrary captured content',async t=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs'),report=buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected,expectedUrls:[EXACT]});report.rawHtml='PRIVATE_HTML_SOURCE';report.rows[0].rawHeaders='PRIVATE_HEADER_SOURCE';report.rows=Array.from({length:250},()=>({...report.rows[0]}));
 const f=await fixture(t,{report});f.app.store.enqueueJob({projectId:f.project.id,pageId:f.page.id,siteId:f.page.siteId,type:'page_check',idempotencyKey:'project-report'});await f.app.tick();const response=await f.req(),body=await response.json();assert.equal(body.report.state,'available');assert.ok(body.report.rows.length<=200);assert.equal(body.report.truncated,true);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_HTML_SOURCE|PRIVATE_HEADER_SOURCE/);assert.equal(f.app.store.listJobs(f.project.id)[0].state,'completed');
});
test('local report reflects aggregate check failure or unknown even when browser inspection succeeds',async t=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs');
 for(const clientState of ['problem','unknown']){
  const report=buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected,expectedUrls:[EXACT]}),f=await fixture(t,{report,clientState,browserState:'ok'});
  f.app.store.enqueueJob({projectId:f.project.id,pageId:f.page.id,siteId:f.page.siteId,type:'page_check',idempotencyKey:'aggregate-'+clientState});await f.app.tick();
  const stored=f.app.store.getPage(f.page.id),body=await(await f.req()).json();assert.equal(stored.verification.state,clientState);assert.equal(body.report.verificationState,clientState);
 }
});
test('private report endpoint rejects cross origin, missing custom header and arbitrary URL options',async t=>{
 const f=await fixture(t);assert.equal((await f.req('',{'X-PagePoster-Request':''})).status,403);assert.equal((await f.req('',{Origin:'https://evil.example'})).status,403);assert.equal((await f.req('&url=https://arbitrary.example/')).status,400);assert.equal(f.calls(),0);
 const remote=await f.app.handle(new Request('https://hosted.example/api/lifecycle/pages/'+f.page.id+'/link-report?expectedRevision='+f.page.revision,{headers:{Origin:'https://hosted.example','X-PagePoster-Request':'1'}}));assert.equal(remote.status,403);
});
test('existing public read yields private mismatch evidence without a second fetch or browser visit',async()=>{
 const {createBrowserVerifier}=await import('../server/lifecycle/browser-check.mjs');let reads=0,launches=0;
 const result=await createBrowserVerifier({executablePath:require('./browser-runtime.cjs').chromePath,chromium:{launch:async()=>{launches++;throw Error('must not launch');}},transport:async address=>{reads++;assert.equal(address,'https://site.example/page/');return {status:200,url:address,headers:{'content-type':'text/html'},text:'<div id="pp-landing"><h1>Missing destination</h1></div>'};}}).verifyPublished({url:'https://site.example/page/',expectedHtml:expected,expectedUrls:[EXACT]});
 assert.equal(result.state,'problem');assert.equal(result.localLinkReport.rows[0].url,EXACT);assert.equal(result.localLinkReport.rows[0].status,'missing');assert.equal(reads,1);assert.equal(launches,0);
});
test('sidecar write failure leaves actual check proof and job result intact without retrying a read or write',async t=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs'),f=await fixture(t,{report:buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected,expectedUrls:[EXACT]})});fs.writeFileSync(path.join(f.dir,'local-link-reports'),'fixture disk failure');f.app.store.enqueueJob({projectId:f.project.id,pageId:f.page.id,siteId:f.page.siteId,type:'page_check',idempotencyKey:'failed-sidecar'});await f.app.tick();const job=f.app.store.listJobs(f.project.id)[0];assert.equal(job.state,'completed');assert.equal(job.result.verification.state,'unknown');assert.equal(f.calls(),1);assert.equal((await (await f.req()).json()).report.state,'unavailable');
});

test('runs and queue open one private text-only report with safe links, busy and close fences',{timeout:25000},async t=>{
 const {buildPublishedLinkReport}=await import('../server/lifecycle/published-link-report.mjs'),report=buildPublishedLinkReport({expectedHtml:expected,actualHtml:expected.replace('</div>','<a href="javascript:window.PWNED=1">Unsafe</a></div>'),expectedUrls:[EXACT]}),f=await fixture(t,{report});
 f.app.store.enqueueJob({projectId:f.project.id,pageId:f.page.id,siteId:f.page.siteId,type:'page_check',idempotencyKey:'ui-capture'});await f.app.tick();f.app.store.createRecord(f.project.id,'autopilot',{state:'completed',stage:'completed',pageId:f.page.id,source:'html',links:[]});
 const http=require('node:http'),root=path.resolve(__dirname,'../dist'),server=http.createServer(async(req,res)=>{const origin='http://127.0.0.1:'+server.address().port,address=new URL(req.url,origin);if(address.pathname.startsWith('/api/lifecycle')){const response=await f.app.handle(new Request(address,{headers:{...req.headers,Origin:origin}}));res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());}const file=path.resolve(root,address.pathname.slice(1)||'autopilot.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const {chromium}=require('./browser-runtime.cjs').playwright,browser=await chromium.launch({executablePath:require('./browser-runtime.cjs').chromePath,headless:true}),context=await browser.newContext(),tab=await context.newPage();t.after(async()=>{await context.close();await browser.close();await new Promise(r=>server.close(r));});tab.setDefaultTimeout(3000);
 let external=0,writes=0,reportReads=0;await context.route('**/*',route=>{const request=route.request();if(!request.url().startsWith('http://127.0.0.1:')){external++;return route.abort();}if(request.method()!=='GET')writes++;if(request.url().includes('/link-report?'))reportReads++;return route.continue();});
 await tab.goto('http://127.0.0.1:'+server.address().port+'/autopilot.html');await tab.locator('#pq-dashboard-open').click();const action=tab.locator('[data-queue-item] [data-action=link-report]').first();await tab.locator('[data-queue-item] .ap-link-report-action summary').first().click();await action.waitFor();await action.click();await tab.locator('#ap-link-report tbody tr').first().waitFor();assert.match(await tab.locator('#ap-link-report').textContent(),/PRIVATE_LINK_REPORT/);assert.equal(await tab.locator('#ap-link-report a').getAttribute('href'),EXACT);assert.equal(await tab.locator('#ap-link-report a[href^="javascript:"]').count(),0);assert.equal(await tab.evaluate(()=>window.PWNED),undefined);assert.equal(await tab.locator('#ap-link-report').getAttribute('aria-busy'),'false');assert.match(await tab.locator('#ap-link-report').textContent(),/Невідомо/);
 await tab.locator('#ap-link-report-close').click();await action.focus();await action.click();await tab.locator('#ap-link-report tbody tr').first().waitFor();await tab.keyboard.press('Escape');assert.equal(await tab.locator('#ap-link-report').evaluate(el=>el.open),false);assert.equal(await action.evaluate(el=>document.activeElement===el),true);assert.equal(reportReads,2);assert.equal(external,0);assert.equal(writes,0);
 let release,slowReads=0;const gate=new Promise(resolve=>{release=resolve;});await tab.route('**/link-report?*',async route=>{if(route.request().url().includes('/'+f.page.id+'/')&&++slowReads===1)await gate;await route.continue();});
 const firstSlow=tab.waitForRequest(request=>request.url().includes('/'+f.page.id+'/link-report?'));await action.click();await firstSlow;assert.equal(await tab.locator('#ap-link-report').getAttribute('aria-busy'),'true');await tab.evaluate(pageId=>{for(let i=0;i<3;i++)window.dispatchEvent(new CustomEvent('pageposter:link-report',{detail:{pageId}}));},f.page.id);assert.equal(slowReads,1);await tab.locator('#ap-link-report-close').click();
 const other=f.app.store.createPage(f.project.id,{title:'Other report',siteId:f.page.siteId,wpId:42,fullUrl:'https://site.example/other/'});await tab.evaluate(pageId=>window.dispatchEvent(new CustomEvent('pageposter:link-report',{detail:{pageId}})),other.id);await tab.locator('#ap-link-report-body').getByText(/Звіт недоступний/).waitFor();const stale=tab.waitForResponse(response=>response.url().includes('/'+f.page.id+'/link-report?'));release();await stale;await tab.evaluate(()=>new Promise(requestAnimationFrame));assert.doesNotMatch(await tab.locator('#ap-link-report-body').textContent(),/PRIVATE_LINK_REPORT/);await tab.locator('#ap-link-report-close').click();await tab.unroute('**/link-report?*');
 await tab.route('**/link-report?*',async route=>{const response=await route.fetch();f.app.store.updatePage(f.page.id,{title:'Changed during read'},f.page.revision);await route.fulfill({response});});await action.click();await tab.locator('#ap-link-report-body').getByText(/Версія сторінки змінилася/).waitFor();assert.equal(await tab.locator('#ap-link-report tbody tr').count(),0);await tab.unroute('**/link-report?*');await tab.locator('#ap-link-report-close').click();
 await action.click();await tab.locator('#ap-link-report-body').getByText(/Звіт недоступний/).waitFor();await tab.evaluate(()=>window.dispatchEvent(new CustomEvent('pageposter:recovery-restored')));assert.equal(await tab.locator('#ap-link-report').evaluate(el=>el.open),false);assert.equal(await tab.locator('#ap-link-report tbody tr').count(),0);assert.equal(external,0);assert.equal(writes,0);
});
