'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath,chromePath=require('./browser-runtime.cjs').chromePath;
const options={timeout:35000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
function evidenceDir(t){const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pp-ui-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('explicit parking releases only the chosen row and exposes an explicit resume action',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'needs_attention',stage:'installing',canApprove:false,canPark:true,error:{code:'BROWSER_CAPTCHA_REQUIRED',message:'Потрібна CAPTCHA'}});
 let parked=0,resumed=0;
 await page.route('**/project-queue/items/q1/park',route=>{assert.deepEqual(route.request().postDataJSON(),{});parked++;item.canPark=false;item.publicationParked=true;item.canResumeParked=true;return route.fulfill({json:{item}});});
 await page.route('**/autopilot/'+item.runId+'/resume',route=>{assert.deepEqual(route.request().postDataJSON(),{});resumed++;item.publicationParked=false;item.state='queued';return route.fulfill({json:{run:{id:item.runId}}});});
 await refreshWorkspace(page);assert.equal(parked,0);assert.equal(resumed,0);
 await page.locator('[data-queue-item=q1] [data-action=park]').click();await page.locator('[data-queue-item=q1] [data-action=resume-parked]').waitFor();assert.equal(parked,1);assert.equal(resumed,0);assert.equal(await page.locator('[data-queue-item=q1] [data-action=retry]').count(),0);
 await page.locator('[data-queue-item=q1] [data-action=resume-parked]').click();await page.locator('[data-queue-item=q1] [data-action=resume-parked]').waitFor({state:'detached'});assert.equal(resumed,1);
});

test('a fresh declined decision carries the exact server Trash retry revision',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'completed',stage:'completed',pageId:'page-proof',wpId:71,pageRevision:4,publishedStatus:'publish',fullUrl:'https://review.example/page/',manualReview:{state:'trash_failed',canTrash:true,retryTrashRevision:77}});fixture.overview.manualPublishedReview=true;
 await page.context().route('https://review.example/**',route=>route.fulfill({body:'Fixture'}));let sent;
 await page.route('**/project-queue/items/q1/published-review',route=>{sent=route.request().postDataJSON();item.manualReview={state:'trash_queued',canTrash:false};return route.fulfill({json:{manualReview:item.manualReview}});});
 await refreshWorkspace(page);await page.locator('[data-queue-item=q1] [data-action=published-review]').click();
 await page.locator('#pq-published-review-decline').click();await page.locator('#pq-published-review').waitFor({state:'hidden'});
 assert.deepEqual(sent,{decision:'declined',expectedPageRevision:4,expectedTrashRevision:77});
});

test('experimental AMP is a separate project action and does not start publication',options,async t=>{
 const {page,fixture,calls}=await workspace(t,{desktop:true});
 await page.route('**/projects/p1/amp-mode',route=>{
  assert.deepEqual(route.request().postDataJSON(),{enabled:true});fixture.overview.projects[0].ampMode=true;return route.fulfill({json:{enabled:true}});
 });
 await page.getByText('Дії проєкту',{exact:true}).first().click();
 await page.getByRole('button',{name:'Увімкнути AMP (експеримент)',exact:true}).first().click();
 await page.getByRole('button',{name:'Вимкнути AMP (експеримент)',exact:true}).first().waitFor({state:'attached'});
 assert.equal(calls.some(call=>call.endpoint?.endsWith('/queue/start')),false);
});
test('manual review opens the live page and saves a decision for its published revision',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),item=fixture.overview.projects[0].items[0];
 await page.locator('[data-queue-item=q1]').waitFor();
 Object.assign(item,{state:'completed',stage:'completed',pageId:'page-315',wpId:315,pageRevision:4,publishedStatus:'publish',fullUrl:'https://manual-review.example/live/',manualReview:{state:'pending',canTrash:true,canOpenEditor:true,editorUrl:'https://manual-review.example/wp-admin/post.php?post=315&action=edit'}});
 fixture.overview.manualPublishedReview=true;
 await page.context().route('https://manual-review.example/**',route=>route.fulfill({body:'Public fixture'}));
 let editorRequests=0;
 await page.route('**/project-queue/items/q1/open-wordpress',route=>{
  assert.deepEqual(route.request().postDataJSON(),{expectedPageRevision:4});
  editorRequests++;return route.fulfill({json:{opened:true}});
 });
 await page.route('**/project-queue/items/q1/published-review',route=>{
  assert.deepEqual(route.request().postDataJSON(),{decision:'declined',expectedPageRevision:4});
  item.manualReview.state='trash_queued';item.manualReview.canTrash=false;return route.fulfill({json:{manualReview:item.manualReview}});
 });
 await refreshWorkspace(page);
 await page.locator('[data-queue-item=q1] [data-action=published-review]').waitFor();
 const popup=page.waitForEvent('popup');
 await page.locator('[data-queue-item=q1] [data-action=published-review]').click();
 const live=await popup;await live.waitForLoadState();assert.equal(live.url(),item.fullUrl);await live.close();
 const review=page.getByRole('dialog',{name:'Ручна перевірка'});
 const opened=page.waitForResponse(response=>response.url().endsWith('/items/q1/open-wordpress'),{timeout:5000});
 await review.getByRole('button',{name:'Відкрити в WordPress',exact:true}).click({timeout:4000});
 assert.equal((await opened).status(),200);assert.equal(editorRequests,1);
 assert.equal(page.context().pages().length,1);
 await review.getByRole('button',{name:'Відхилити'}).click();
 const row=page.locator('[data-queue-item=q1]');
 await row.getByText('Перенесення в кошик',{exact:true}).waitFor();
 item.manualReview={state:'trashed',canTrash:false};item.fullUrl='';item.publishedStatus='trash';
 await refreshWorkspace(page);
 await row.getByText('У кошику WordPress',{exact:true}).waitFor();
 assert.equal(await row.locator('[data-action=published-review]').count(),0);
});
test('GEO suggestions include every ISO country from the first letter and keep the short code',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();
 const input=page.locator('#pq-default-geo');
 assert.equal(await input.getAttribute('list'),'pq-country-options');
 const suggestions=await input.evaluate(el=>[...el.list.options].map(option=>({code:option.value,name:option.textContent})));
 assert.equal(suggestions.length,249);
 assert.equal(new Set(suggestions.map(option=>option.code)).size,249);
 assert.deepEqual(suggestions.filter(option=>option.code.startsWith('N')).map(option=>option.code),['NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ']);
 assert.equal(suggestions.find(option=>option.code==='NZ').name,'Нова Зеландія');
 await input.fill('N');
 assert.equal(await input.evaluate(el=>[...el.list.options].some(option=>option.value==='NL')),true);
 await input.fill('NZ');assert.equal(await input.inputValue(),'NZ');
 await input.fill('PL, NZ');assert.equal(await input.inputValue(),'PL, NZ');
 for(const id of ['pq-row-geo','pq-requirements-geo'])assert.equal(await page.locator('#'+id).getAttribute('list'),'pq-country-options');
 assert.equal(calls.some(call=>/queue\/start|queue\/approve/.test(call.endpoint)),false);
});
test('a manual CAPTCHA owner is named and can continue without approving another queued page',options,async t=>{
 const {page,calls,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];Object.assign(item,{state:'needs_attention',stage:'publishing',canApprove:false,canRetry:true,error:{code:'BROWSER_CAPTCHA_REQUIRED',message:'Пройдіть CAPTCHA у поточному вікні.'}});Object.assign(fixture.overview.projects[0].items[1],{state:'queued',stage:'installing'});
 fixture.overview.publication={active:0,waiting:1,owner:{runId:'r1',title:'Polish page',blocked:true,manual:true,message:'Пройдіть CAPTCHA у поточному вікні WordPress. Наступні сторінки чекають.'}};
 await page.route('**/api/lifecycle/project-queue/items/q1/retry',async route=>{item.state='queued';item.error=null;fixture.overview.publication.owner.blocked=false;fixture.overview.publication.owner.manual=false;await route.fulfill({contentType:'application/json',body:JSON.stringify({item})});});
 await page.locator('#pq-dashboard-open').click();await page.locator('#pq-publication-owner').getByText(/CAPTCHA/).waitFor();assert.match(await page.locator('#pq-publication-owner').textContent(),/Polish page/);
 const control=page.locator('[data-queue-item=q1] [data-action=retry]');assert.equal(await control.textContent(),'Продовжити');const continued=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/lifecycle/project-queue/items/q1/retry');await control.click();assert.equal((await continued).status(),200);assert.equal(calls.some(call=>call.endpoint==='/project-queue/approve'),false);assert.equal(calls.some(call=>call.endpoint==='/projects/p1/queue/start'),false);
});

test('publishing retry is shown only for the server-confirmed safe recovery case',options,async t=>{
 const {page,calls,fixture}=await workspace(t),project=fixture.overview.projects[0],item=project.items[0];Object.assign(item,{state:'failed',stage:'publishing',canApprove:false,canRetry:true,error:{code:'unsafe_address',message:'DNS rejected before request'}});
 project.items.push(...['creating','dispatching','uncertain'].map((phase,index)=>({...item,id:'locked-'+index,runId:'locked-run-'+index,title:'Locked '+phase,canRetry:false,...(phase==='uncertain'?{state:'uncertain'}:{})})));
 await page.route('**/api/lifecycle/project-queue/items/q1/retry',route=>{item.state='queued';item.canRetry=false;item.error=null;return route.fulfill({contentType:'application/json',body:JSON.stringify({item})});});
 await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item=q1] .pq-error').getByText('DNS rejected before request',{exact:true}).waitFor();const retry=page.locator('[data-queue-item=q1] [data-action=retry]');assert.equal(await retry.count(),1);assert.equal(await retry.textContent(),'Повторити');assert.equal(await page.locator('[data-queue-item^="locked-"] [data-action=retry]').count(),0);
 item.canRetry=false;await refreshWorkspace(page);await retry.waitFor({state:'detached'});item.canRetry=true;await refreshWorkspace(page);await retry.waitFor();
 const request=page.waitForRequest(value=>value.url().endsWith('/project-queue/items/q1/retry'));await retry.click();await request;assert.equal(calls.some(call=>call.endpoint==='/project-queue/approve'),false);
 Object.assign(item,{state:'failed',canRetry:false});await refreshWorkspace(page);await page.locator('[data-queue-item=q1] .pq-state.failed').waitFor();assert.equal(await page.locator('[data-queue-item=q1] [data-action=retry]').count(),0);
});
async function refreshWorkspace(page){const menu=page.locator('.pq-workspace-actions > .pq-more');if(!await menu.getAttribute('open'))await menu.locator('summary').click();await page.locator('#pq-refresh').click();}
test('ordinary retries require the server capability and include failed rows without a run',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),project=fixture.overview.projects[0],item=project.items[0];
 Object.assign(item,{state:'paused',stage:'selecting',canApprove:false,canRetry:false});project.paused=true;
 await refreshWorkspace(page);assert.equal(await page.locator('[data-queue-item=q1] [data-action=retry]').count(),0);
 project.paused=false;Object.assign(item,{state:'failed',stage:'importing',runId:null,canRetry:true});
 await page.route('**/project-queue/items/q1/retry',route=>{assert.deepEqual(route.request().postDataJSON(),{});item.state='queued';item.canRetry=false;return route.fulfill({json:{item}});});
 await refreshWorkspace(page);const retry=page.locator('[data-queue-item=q1] [data-action=retry]');await retry.waitFor();
 const sent=page.waitForRequest(request=>request.url().endsWith('/items/q1/retry'));await retry.click();await sent;
});
test('an unsent draft offers publication while an ambiguous send offers reconciliation',options,async t=>{
 const {page,fixture}=await workspace(t),[draft,sent]=fixture.overview.projects[0].items;
 Object.assign(draft,{state:'uncertain',stage:'publishing',canApprove:false,canRetry:true,publication:{state:'draft',checkpoint:'draft',postId:7633,canReconcile:false}});
 Object.assign(sent,{state:'uncertain',stage:'publishing',canApprove:false,canRetry:false,publication:{state:'verification_unknown',checkpoint:'dispatching',postId:7634,canReconcile:true}});
 await page.locator('#pq-dashboard-open').click();
 const draftRow=page.locator('[data-queue-item=q1]'),sentRow=page.locator('[data-queue-item=q2]');
 await draftRow.getByRole('button',{name:'Продовжити публікацію',exact:true}).waitFor();
 assert.equal(await draftRow.locator('[data-action=reconcile]').count(),0);
 assert.equal(await sentRow.getByRole('button',{name:'Звірити стан',exact:true}).count(),1);
 assert.equal(await sentRow.locator('[data-action=retry]').count(),0);
});
test('the published robots warning offers explicit queue continuation',options,async t=>{
 const {page,calls,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'needs_attention',stage:'checking',canContinueQueue:true,fullUrl:'https://published.example/page/',verification:{state:'problem',summary:'Є проблеми: robots'},publication:{state:'crawl_blocked',checkpoint:'published',revision:17,canReconcile:false}});
 await page.route('**/project-queue/items/q1/continue-crawl-blocked',route=>{item.canContinueQueue=false;item.state='completed';return route.fulfill({contentType:'application/json',body:JSON.stringify({item})});});
 await page.locator('#pq-dashboard-open').click();
 const row=page.locator('[data-queue-item=q1]'),advance=row.getByRole('button',{name:'Залишити й продовжити чергу',exact:true});
 await row.getByText('Опубліковано · Googlebot заблоковано',{exact:true}).waitFor();
 assert.equal(await row.locator('[data-action=reconcile]').count(),0);
 const posted=page.waitForRequest(request=>request.url().endsWith('/continue-crawl-blocked'));
 await advance.click();assert.deepEqual((await posted).postDataJSON(),{expectedRevision:17});await advance.waitFor({state:'detached'});
 assert.equal(await row.getByText('Опубліковано · Googlebot заблоковано',{exact:true}).count(),1);
 assert.equal(calls.some(call=>/approve|\/queue\/start/.test(call.endpoint)),false);
});
test('a confirmed publication offers a fresh public check without opening reconciliation',options,async t=>{
 const {page,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'needs_attention',stage:'checking',canRecheckPublished:true,fullUrl:'https://published.example/page/',verification:{state:'problem',summary:'Є проблеми: noindex'},publication:{state:'verification_unknown',checkpoint:'published',revision:17,canReconcile:true}});
 await page.route('**/autopilot/r1/reconcile',route=>{item.canRecheckPublished=false;item.state='checking';return route.fulfill({contentType:'application/json',body:'{"observation":"published"}'});});
 await page.locator('#pq-dashboard-open').click();
 const row=page.locator('[data-queue-item=q1]');
 assert.equal(await row.locator('[data-action=reconcile]').count(),0);
 const posted=page.waitForRequest(request=>request.url().endsWith('/autopilot/r1/reconcile'));
 await row.getByRole('button',{name:'Перевірити опубліковану сторінку',exact:true}).click();
 assert.deepEqual((await posted).postDataJSON(),{expectedRevision:17});
 assert.equal(await page.locator('#ap-reconciliation').evaluate(dialog=>dialog.open),false);
});
test('workspace is modeless and filters real rows without losing a hidden selection into publication',options,async t=>{
 const {page,calls}=await workspace(t);await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"]').waitFor();
 assert.equal(await page.locator('#pq-dashboard').evaluate(el=>el.matches(':modal')),false);
 await page.locator('#pq-search').fill('german');assert.equal(await page.locator('[data-queue-item]').count(),0);
 await page.locator('#pq-search').fill('Polish');assert.equal(await page.locator('[data-queue-item]').count(),1);
 await page.locator('[data-queue-item="q1"] input[type=checkbox]').check();
 assert.equal(await page.locator('#pq-approve-selected').isEnabled(),false,'Unchecked content cannot be approved through bulk selection');
 await page.locator('#pq-filter-geo').selectOption('DE');assert.equal(await page.locator('[data-queue-item]').count(),0);
 assert.match(await page.locator('#pq-selection-count').textContent(),/0/);
 assert.equal(calls.some(call=>call.endpoint==='/project-queue/approve'),false);
 await page.locator('#pq-reset-filters').click();assert.equal(await page.locator('[data-queue-item]').count(),2);
 await page.getByText('Вигляд і експорт',{exact:true}).click();await page.locator('#pq-density').selectOption('compact');assert.equal(await page.locator('#pq-dashboard').getAttribute('data-density'),'compact');
});
test('inspector identifies project and donor, reviews next page and downloads the exact ready HTML',options,async t=>{
 const {page,fixture}=await workspace(t);fixture.overview.projects[0].items[0].selectedSite={baseUrl:'https://donor.example/',dr:30,traffic:100,geo:['PL']};
 await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"] [data-action="preview"]').click();
 await page.locator('#pq-mark-reviewed:enabled').waitFor();assert.match(await page.locator('#pq-review-context').textContent(),/AI проєкт.*pl.*PL.*donor.example/);
 assert.equal(await page.locator('#pq-review').evaluate(el=>el.matches(':modal')),false);
 const download=page.waitForEvent('download');await page.locator('#pq-review-download').click();const file=await download;
 const stream=await file.createReadStream(),parts=[];for await(const part of stream)parts.push(part);assert.match(Buffer.concat(parts).toString(),/<h1>Reviewed page<\/h1>/);
 await page.locator('#pq-mark-next').click();assert.match(await page.locator('#pq-review-title').textContent(),/Generating page/);
 assert.equal(await page.locator('#pq-approve-selected').isDisabled(),true);
});
test('a missing donor shows the exact filter funnel beside its page',options,async t=>{
 const {page,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];
 item.state='needs_attention';item.error={code:'SOURCE_EMPTY',message:'Немає вільних донорів.'};item.selectionDiagnostics={criteria:{geo:'SK',minDr:null,minTraffic:50},total:100,geo:14,dr:14,eligible:3,reserved:3,available:0};
 await page.locator('#pq-dashboard-open').click();const row=page.locator('[data-queue-item="'+item.id+'"]');
 await row.getByText(/Гео: SK/).waitFor();assert.match(await row.textContent(),/трафік: від 50/);assert.match(await row.textContent(),/за гео: 14/i);assert.match(await row.textContent(),/за DR: 14/);assert.match(await row.textContent(),/за трафіком: 3/);assert.match(await row.textContent(),/зайнято: 3/);assert.match(await row.textContent(),/вільно: 0/);
});
async function workspace(t,{desktop=false,showScrollbars=false,empty=false,deferQueue=false,legacy=false}={}){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),calls=[],errors=[],fixture={projects:[{id:'p1',name:'AI проєкт',workflowType:'ai'},{id:'p2',name:'HTML проєкт',workflowType:'html'}],preview:{items:[{key:'one',title:'Polish page',source:'ai',language:'pl',geo:'PL',siteSelection:{minDr:30,minTraffic:100,geo:'PL'},links:[{url:'https://example.com/',anchor:'Exact anchor'}],editorial:{format:'article',topic:'casino',language:'pl'}}],issues:[],source:{kind:'table'}},overview:{projects:[{projectId:'p1',name:'AI проєкт',type:'ai',paused:false,priority:5,counts:{total:2,waiting:0,generating:1,ready:1,publishing:0,completed:0,attention:0},items:[{id:'q1',key:'one',title:'Polish page',language:'pl',geo:'PL',state:'ready',stage:'selecting',runId:'r1',canApprove:true},{id:'q2',key:'two',title:'Generating page',language:'de',geo:'DE',state:'generating',stage:'generating',runId:'r2',canApprove:false}]}],generation:{active:1,waiting:2},publication:{active:0,waiting:3}},failImport:true};
 if(empty){fixture.projects=[];fixture.overview={projects:[],generation:{active:0,waiting:0},publication:{active:0,waiting:0}};}
 if(legacy){fixture.projects=[{id:'p1',name:'AI проєкт'}];fixture.overview.projects=[];}
 if(deferQueue)fixture.queueGate=new Promise(resolve=>{fixture.releaseQueue=()=>{fixture.queueGate=null;resolve();};});
 const server=http.createServer((req,res)=>{const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run'],...(showScrollbars?{ignoreDefaultArgs:['--hide-scrollbars']}:{})}),context=await browser.newContext({viewport:{width:1400,height:1000}});t.after(async()=>{fixture.releaseQueue?.();await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();calls.push({endpoint,method,body});if(method==='POST'&&req.headers()['x-pageposter-request']!=='1')return route.fulfill({status:403,contentType:'application/json',body:'{"error":"Missing request verification header"}'});let data;
  if(endpoint==='/projects'&&method==='GET')data={projects:fixture.projects};
  else if(endpoint==='/projects'&&method==='POST'){const project={id:'p3',...body};fixture.projects.push(project);data={project};}
  else if(endpoint==='/autopilot/status')data={source:{configured:true},aiConfigured:true};
  else if(endpoint==='/project-import/capabilities')data={version:1,local:{html:true,csv:true,paste:true},google:{mode:'user',connected:true,sheets:{available:true,reason:'Читання доступне у фікстурі.'},drive:{available:true,reason:'Читання доступне у фікстурі.'}}};
  else if(endpoint==='/project-import/preview')data=fixture.preview;
  else if(endpoint==='/project-queue/import'){if(fixture.failImport){fixture.failImport=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Temporary import failure"}'});}data={project:{id:'p3',name:body.name,workflowType:body.type},batch:{count:body.items.length}};fixture.projects.push(data.project);}
  else if(endpoint==='/project-queue'){if(fixture.queueGate)await fixture.queueGate;data=fixture.overview;}
  else if(endpoint==='/projects/p1/queue/start'){assert.equal(body.planToken,fixture.overview.projects[0].publicationPlan.token);data={queued:2,reused:false};fixture.overview.projects[0].publicationPlan={token:null,count:2,blockedReason:'Публікація виконується.'};for(const item of fixture.overview.projects[0].items)item.state='queued';}
  else if(endpoint==='/autopilot/r1/html')data={html:'<!doctype html><html><body><h1>Reviewed page</h1></body></html>',reviewToken:'exact-r1-review'};
  else if(endpoint==='/project-queue/approve')data={queued:body.items.length};
  else if(/^\/projects\/p1\/queue$/.test(endpoint)){fixture.overview.projects[0].paused=body.action==='pause';if(body.priority!==undefined)fixture.overview.projects[0].priority=body.priority;data=fixture.overview;}
  else if(endpoint.endsWith('/jobs'))data={jobs:[]};else if(endpoint.endsWith('/pages')||endpoint.endsWith('/overview'))data={pages:[]};else if(endpoint.endsWith('/autopilot'))data={runs:[]};
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 if(desktop)await context.addInitScript(()=>{window.pageposterDesktop={showAppMenu:async()=>({opened:true})};});
 const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/autopilot.html');if(empty)await page.locator('#pq-projects > .pq-empty').waitFor();else await page.locator('#ap-title').getByText('AI проєкт',{exact:true}).waitFor({state:'attached'});return {page,calls,fixture};
}

test('desktop opens the table and separates a new page from a saved preview; settings keep advanced functions reachable',options,async t=>{
 const {page}=await workspace(t,{desktop:true});await page.locator('[data-queue-item="q1"]').waitFor();assert.equal(await page.locator('#ap-launch-form').isVisible(),false);
 await page.locator('#pq-project-filter').selectOption('p1');await page.locator('#pq-dashboard-close').click();await page.locator('#ap-launch-form').waitFor();assert.equal(await page.locator('#pq-dashboard').isVisible(),false);assert.equal(await page.locator('#ap-stage-frame').isVisible(),false);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);
 await page.locator('#ap-composer-bar button').click();await page.locator('[data-queue-item="q1"]').waitFor();
 await page.locator('#ap-settings-open').click();assert.equal(await page.locator('#ap-source-form').isVisible(),true);assert.equal(await page.locator('#ap-key-form').isVisible(),false);
 await page.locator('[data-settings-tab="ai"]').click();assert.match(await page.locator('#ap-ai-state').textContent(),/Ключ збережено/);await page.locator('#ap-key-editor > summary').click();assert.equal(await page.locator('#ap-key-form').isVisible(),true);
 await page.locator('[data-settings-tab="advanced"]').click();assert.equal(await page.locator('#ap-backup-open').isVisible(),true);assert.equal(await page.locator('#ap-browser-mode').isVisible(),true);
});

test('desktop hides duplicate and inapplicable toolbar actions and clears selection immediately',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});await page.locator('[data-queue-item="q1"]').waitFor();
 assert.equal(await page.locator('#pq-import-more').count(),0);
 assert.equal(await page.locator('#ap-app-menu').count(),0,'The desktop header has no app-menu button');
 for(const id of ['pq-approve-selected','pq-edit-requirements','pq-selection-count','pq-reset-filters','ap-runtime'])assert.equal(await page.locator('#'+id).isVisible(),false,id);
 const checkbox=page.locator('[data-queue-item="q1"] input[type=checkbox]');await checkbox.check();
 assert.equal(await page.locator('#pq-approve-selected').isVisible(),true);assert.equal(await page.locator('#pq-approve-selected').isDisabled(),true);
 await page.locator('#pq-clear-selection').click();assert.equal(await checkbox.isChecked(),false);assert.equal(await page.locator('#pq-approve-selected').isVisible(),false);
 await page.locator('#pq-search').fill('Polish');assert.equal(await page.locator('#pq-reset-filters').isVisible(),true);await page.locator('#pq-reset-filters').click();assert.equal(await page.locator('#pq-reset-filters').isVisible(),false);
 await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');await page.locator('#pq-source').selectOption('files');assert.equal(await page.locator('#pq-template').isVisible(),false);await page.locator('#pq-source').selectOption('csv');assert.equal(await page.locator('#pq-template').isVisible(),true);
 assert.equal(calls.some(call=>/queue\/start|queue\/approve/.test(call.endpoint)),false);
});

test('desktop ZIP preview accepts 24 mixed-region HTML pages and rejects damaged loose HTML before sending',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 const {zip}=require('./fixtures/project-normalizer.cjs');
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 const importer=createProjectImporter();
 await page.route('**/project-import/preview',async route=>{
  const data=await importer.preview(route.request().postDataJSON());
  await route.fulfill({json:data});
 });
 await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();
 await page.locator('#pq-type').selectOption('html');
 await page.locator('#pq-source').selectOption('files');
 await page.locator('#pq-html-files').setInputFiles({name:'bad.html',mimeType:'text/html',buffer:Buffer.from([0xc3,0x28])});
 await page.locator('#pq-files-status').getByText('Файли не завантажені.',{exact:true}).waitFor();
 assert.match(await page.locator('#pq-import-note').textContent(),/кодування/);
 await page.locator('#pq-source').selectOption('project-file');
 const entries=Array.from({length:24},(_,index)=>{
  const language=index%2?'pl':'en-NZ',prefix=index%2?'pl':'nz';
  const html='<!doctype html><html lang="'+language+'"><head><link rel="stylesheet" href="../assets/main.css"></head><body><h1>Page '+index+'</h1></body></html>';
  return ['pages/'+prefix+'-guide-'+index+'.html',index%2?Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(html,'utf16le')]):html];
 });
 const archive=zip([...entries,['assets/main.css','h1 { color: #102030; }']]);
 await page.locator('#pq-project-file').setInputFiles({name:'mixed.zip',mimeType:'application/zip',buffer:archive});
 await page.locator('#pq-project-file-status').getByText(/HTML-файлів: 24/).waitFor();
 const preview=page.waitForResponse(response=>response.url().endsWith('/project-import/preview'));
 await page.locator('#pq-preview-import').click();
 const result=await (await preview).json();
 assert.deepEqual(result.issues,[]);
 assert.equal(result.items.length,24);
 assert.ok(result.items.every((item,index)=>item.geo===(index%2?'PL':'NZ')&&item.html.includes('#102030')));
 await page.locator('#pq-import-count').getByText(/Сторінок: 24/).waitFor();
 assert.equal(calls.some(call=>/project-queue\/import|queue\/start|queue\/approve/.test(call.endpoint)),false);
});

test('a DOCX hyperlink opens in project preview with source row and no queue or AI request',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 const {linkedDocx}=require('./fixtures/project-normalizer.cjs');
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 const importer=createProjectImporter();
 await page.route('**/project-import/preview',async route=>route.fulfill({json:await importer.preview(route.request().postDataJSON())}));
 await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();
 await page.locator('#pq-source').selectOption('project-file');
 const input=page.locator('#pq-project-file');
 assert.match(await input.getAttribute('accept'),/\.docx/);
 await input.setInputFiles({name:'Campaign.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:linkedDocx()});
 await page.locator('#pq-project-file-status').getByText(/Campaign\.docx.*Генерація AI/).waitFor();
 const preview=page.waitForResponse(response=>response.url().endsWith('/project-import/preview'));
 await page.locator('#pq-preview-import').click();
 const result=await (await preview).json();
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.items[0].links,[{url:'https://example.com/?x=%2F&y=2',anchor:'Exact anchor'}]);
 assert.deepEqual(result.items[0].provenance.source,{kind:'table',file:'Campaign.docx',row:2});
 await page.locator('#pq-import-rows').getByText('Word Page',{exact:true}).waitFor();
 assert.equal(calls.some(call=>/project-queue\/import|queue\/start|queue\/approve|\/ai\//.test(call.endpoint)),false);
});

test('one uploaded archive maps and queues the project without source controls or publication',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 const {zip}=require('./fixtures/project-normalizer.cjs');
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 const importer=createProjectImporter();
 let mapping;
 await page.route('**/api/ai/project-columns',route=>{mapping=route.request().postDataJSON();return route.fulfill({json:{columns:['file','slug','donor','']}});});
 await page.route('**/project-import/preview',async route=>route.fulfill({json:await importer.preview(route.request().postDataJSON())}));
 await page.locator('#pq-import-open').click();
 assert.equal(await page.locator('#pq-source').isVisible(),false);
 assert.equal(await page.locator('#pq-type').isVisible(),false);
 const html='<h1>Exact archived page</h1>';
 const buffer=zip([['landing.html',html],['instructions.csv','Source asset,Requested path,Website to use,Password\nlanding.html,exact-path,https://example.org/,private-fixture']]);
 const imported=page.waitForResponse(response=>response.url().endsWith('/project-queue/import'));
 await page.locator('#pq-auto-file').setInputFiles({name:'Campaign.zip',mimeType:'application/zip',buffer});
 assert.equal((await imported).status(),503);
 assert.deepEqual(mapping,{headers:['Source asset','Requested path','Website to use',''],hasHtml:true});
 const result=calls.find(call=>call.endpoint==='/project-queue/import').body;
 assert.equal(result.name,'Campaign');
 assert.equal(result.type,'html');
 assert.equal(result.items[0].html,html);
 assert.equal(result.items[0].slug,'exact-path');
 assert.equal(result.items[0].donor,'https://example.org/');
 assert.doesNotMatch(JSON.stringify(result),/private-fixture/);
 await page.getByText('Temporary import failure',{exact:true}).waitFor();
 const retried=page.waitForResponse(response=>response.url().endsWith('/project-queue/import'));
 await page.locator('#pq-auto-retry').click();
 assert.equal((await retried).status(),200);
 assert.deepEqual(calls.filter(call=>call.endpoint==='/project-queue/import').at(-1).body,result);
 await page.locator('#pq-import-dialog').waitFor({state:'hidden'});
 await page.locator('#pq-dashboard-close').click();
 await page.locator('#pq-import-open').click();
 const reimported=page.waitForResponse(response=>response.url().endsWith('/project-queue/import'));
 await page.locator('#pq-auto-file').setInputFiles({name:'Campaign.zip',mimeType:'application/zip',buffer});
 await reimported;
 assert.equal(calls.filter(call=>call.endpoint==='/project-queue/import').at(-1).body.idempotencyKey,result.idempotencyKey);
 assert.equal(calls.some(call=>/queue\/start|queue\/approve/.test(call.endpoint)),false);
});

test('a Markdown brief shows exact links and source lines before queue admission',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 const importer=createProjectImporter();
 await page.route('**/project-import/preview',async route=>route.fulfill({json:await importer.preview(route.request().postDataJSON())}));
 await page.locator('#pq-import-open').click();
 await page.locator('#pq-manual-import > summary').click();
 await page.locator('#pq-source').selectOption('project-file');
 const url='https://example.com/?x=%2F&y=2',anchor='Exact "anchor"';
 const brief=Buffer.from('\n## Сторінка: Campaign page\n- Посилання: '+url+'\n- Анкор: '+anchor+'\n- Мова: pl\n- Гео: PL');
 await page.locator('#pq-project-file').setInputFiles({name:'Campaign.md',mimeType:'text/markdown',buffer:brief});
 await page.locator('#pq-project-file-status').getByText(/Сторінок у ТЗ: 1/).waitFor();
 const preview=page.waitForResponse(response=>response.url().endsWith('/project-import/preview'));
 await page.locator('#pq-preview-import').click();
 const result=await (await preview).json();
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.items[0].links,[{url,anchor}]);
 assert.deepEqual(result.items[0].provenance.source,{kind:'table',file:'Campaign.md',row:2});
 const row=page.locator('#pq-import-rows tr').filter({hasText:'Campaign page'});
 await row.getByText('Посилання й анкори (1)',{exact:true}).click({timeout:5000});
 await row.getByText(url,{exact:true}).waitFor({state:'visible',timeout:5000});
 await row.getByText(anchor,{exact:true}).waitFor({state:'visible',timeout:5000});
 assert.equal(calls.some(call=>/project-queue\/import|queue\/start|queue\/approve|\/ai\//.test(call.endpoint)),false);
});

test('ZIP export takes only selected visible pages and downloads the prepared archive',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{desktop:true});
 const project=fixture.overview.projects[0],items=project.items;
 for(const [index,item] of items.entries()){item.pageId='page-'+index;item.pageRevision=3;}
 const {createPreparedArchive}=await import('../server/lifecycle/prepared-archive.mjs');
 const archive=createPreparedArchive([{key:items[0].key,language:items[0].language,geo:items[0].geo,
  prepared:{title:items[0].title,html:'<h1>Exact HTML</h1>',audit:{placeholderCount:0},warnings:[]}}]);
 let payload;
 await page.route('**/project-queue/export-prepared',async route=>{
  payload=route.request().postDataJSON();
  await route.fulfill({contentType:'application/zip',body:archive});
 });
 await refreshWorkspace(page);
 await page.locator('[data-queue-item=q1] input[type=checkbox]').check();
 await page.locator('.pq-workspace-actions > .pq-more > summary').click();
 const downloaded=page.waitForEvent('download');
 await page.locator('#pq-export-prepared').click();
 const file=await downloaded;
 assert.equal(file.suggestedFilename(),'pageposter-prepared.zip');
 const stream=await file.createReadStream(),parts=[];
 for await(const part of stream)parts.push(part);
 assert.deepEqual(Buffer.concat(parts),archive);
 assert.deepEqual(payload,{items:[{id:'q1',pageId:'page-0',pageRevision:3}]});
 assert.equal(calls.some(call=>/queue\/start|queue\/approve/.test(call.endpoint)),false);
});

test('desktop inspector groups exports and preview sizes while retaining exact download and Escape focus',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});await page.locator('[data-queue-item="q1"] [data-action=preview]').click();await page.locator('#pq-review-copy:enabled').waitFor({state:'attached'});
 const menu=page.locator('#pq-review-export-menu');assert.equal(await menu.count(),1);assert.equal(await page.locator('#pq-review-copy').isVisible(),false);assert.equal(await page.locator('#pq-review-mobile').isVisible(),false);
 await menu.locator('summary').click();await page.locator('#pq-review-download').focus();await page.keyboard.press('Escape');assert.equal(await menu.evaluate(n=>n.open),false);assert.equal(await page.locator('#pq-review').isVisible(),true);assert.equal(await menu.locator('summary').evaluate(n=>n===document.activeElement),true);
 await menu.locator('summary').click();const downloaded=page.waitForEvent('download');await page.locator('#pq-review-download').click();const stream=await (await downloaded).createReadStream(),parts=[];for await(const part of stream)parts.push(part);assert.equal(Buffer.concat(parts).toString(),'<!doctype html><html><body><h1>Reviewed page</h1></body></html>');assert.equal(await menu.evaluate(n=>n.open),false);
 await page.locator('#pq-review-view-menu > summary').click();await page.locator('#pq-review-mobile').click();assert.equal(await page.locator('#pq-review-mobile').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#pq-review-view-menu').evaluate(n=>n.open),false);
 assert.equal(calls.some(call=>/queue\/start|queue\/approve/.test(call.endpoint)),false);
});
test('requirements dialog sends explicit zero and clear operations and resets its checkboxes between uses',options,async t=>{
 const {page,calls,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];item.canEditRequirements=true;item.requirementsRevision='rev-one';
 await page.route('**/api/lifecycle/project-queue/requirements',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'CONFLICT',error:'Сторінка змінилася'})}));
 await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"] input').check();await page.locator('#pq-edit-requirements').click();
 await page.locator('#pq-requirements-dr-change').check();await page.locator('#pq-requirements-dr').fill('0');await page.locator('#pq-requirements-traffic-change').check();await page.locator('#pq-requirements-traffic').fill('');
 const response=page.waitForRequest(request=>request.url().endsWith('/project-queue/requirements'));await page.locator('#pq-requirements-apply').click();const payload=(await response).postDataJSON();assert.deepEqual(payload,{items:[{id:'q1',expectedRevision:'rev-one'}],changes:{minDr:0,minTraffic:null}});await page.locator('#pq-requirements-note').getByText('Сторінка змінилася',{exact:true}).waitFor();
 await page.locator('#pq-requirements-close').click();await page.locator('#pq-edit-requirements').click();assert.equal(await page.locator('#pq-requirements-dr').isDisabled(),true);assert.equal(await page.locator('#pq-requirements-dr-change').isChecked(),false);assert.equal(calls.some(call=>call.endpoint==='/project-queue/approve'),false);
});
test('filtered project language edit sends only the displayed group and explains locked AI language',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),[polish,german]=fixture.overview.projects[0].items;
 Object.assign(polish,{source:'html',canEditRequirements:true,canEditLanguage:true,requirementsRevision:'rev-pl'});
 Object.assign(german,{source:'ai',canEditRequirements:true,canEditLanguage:false,requirementsRevision:'rev-de'});
 await page.route('**/project-queue/requirements',route=>route.fulfill({status:409,json:{code:'CONFLICT',error:'Fixture conflict'}}));
 await refreshWorkspace(page);
 const menu=page.locator('[data-queue-project=p1] .pq-more');
 await menu.locator('summary').click();
 await menu.getByRole('button',{name:/Змінити мову/}).click();
 assert.equal(await page.locator('#pq-requirements-language-change').isDisabled(),true);
 assert.match(await page.locator('#pq-requirements-language-help').textContent(),/нової генерації/);
 await page.locator('#pq-requirements-close').click();
 await page.locator('#pq-filter-geo').selectOption('PL');
 if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click();
 await menu.getByRole('button',{name:/Змінити мову/}).click();
 await page.locator('#pq-requirements-language-change').check();
 await page.locator('#pq-requirements-language').fill('en-NZ');
 const request=page.waitForRequest(request=>request.url().endsWith('/project-queue/requirements'));
 await page.locator('#pq-requirements-apply').click();
 assert.deepEqual((await request).postDataJSON(),{items:[{id:'q1',expectedRevision:'rev-pl'}],changes:{language:'en-NZ'}});
});

test('proxy traffic is available per project and per page with scope and IP limitations',options,async t=>{
 const {page}=await workspace(t,{desktop:true});
 const requests=[];
 await page.route('**/proxy/usage',async route=>{
  const body=route.request().postDataJSON();requests.push(body);
  const total={bytesSent:120,bytesReceived:350,requests:3,connections:4};
  await route.fulfill({json:{usage:{total,byScope:{browser:total,verification:{bytesSent:0,bytesReceived:0,requests:0,connections:0}},attempts:[{attemptId:'attempt-1',total}],cost:null},
   route:body.runId?{label:'Проксі 1',ip:'8.8.8.8',country:'PL',checkedAt:'2026-11-06T10:00:00Z'}:null}});
 });
 const menu=page.locator('[data-queue-project=p1] .pq-more');
 await menu.locator('summary').click();
 await menu.getByRole('button',{name:'Трафік проксі',exact:true}).click();
 const dialog=page.locator('#pq-proxy-usage');
 await dialog.getByText(/350/).first().waitFor();
 assert.match(await dialog.textContent(),/Тариф.*невідомі/i);
 await dialog.getByRole('button',{name:'Закрити',exact:true}).click();
 await page.locator('[data-queue-item=q1] [data-action=preview]').click();
 await page.locator('#pq-inspector-details').getByRole('button',{name:'Трафік проксі',exact:true}).click();
 await dialog.getByText(/8\.8\.8\.8/).waitFor();
 assert.match(await dialog.textContent(),/Остання перевірка.*PL/);
 assert.deepEqual(requests,[{projectId:'p1'},{projectId:'p1',runId:'r1'}]);
});

test('CSV exports only the filtered rows and protects formula-like page titles',options,async t=>{
 const {page,fixture}=await workspace(t);fixture.overview.projects[0].items[0].title='=HYPERLINK("https://example.com")';await page.locator('#pq-dashboard-open').click();await page.locator('#pq-filter-geo').selectOption('PL');await page.getByText('Вигляд і експорт',{exact:true}).click();const event=page.waitForEvent('download');await page.locator('#pq-export').click();const file=await event,stream=await file.createReadStream(),parts=[];for await(const part of stream)parts.push(part);const csv=Buffer.concat(parts).toString();assert.match(csv,/'=HYPERLINK/);assert.doesNotMatch(csv,/Generating page/);assert.match(csv,/Polish|PL/);
});
test('changing one queue row during polling retains keyboard focus and the expanded project menu',options,async t=>{
 const {page,fixture}=await workspace(t);await page.locator('#pq-dashboard-open').click();const section=page.locator('[data-queue-project="p1"]'),menu=section.locator('.pq-more');await menu.locator('summary').click();const priority=section.getByLabel('Пріоритет проєкту AI проєкт');await priority.focus();fixture.overview.projects[0].items[0].title='Changed with menu open';await section.getByText('Changed with menu open',{exact:true}).waitFor();assert.equal(await menu.evaluate(node=>node.open),true);assert.equal(await priority.evaluate(node=>node===document.activeElement),true);
 const check=page.locator('[data-queue-item="q1"] input');await check.focus();fixture.overview.projects[0].items[1].title='Another change';await section.getByText('Another change',{exact:true}).waitFor();assert.equal(await check.evaluate(node=>node===document.activeElement),true);
 const all=section.locator('thead input');await all.focus();fixture.overview.projects[0].items[1].title='Change with header focused';await section.getByText('Change with header focused',{exact:true}).waitFor();assert.equal(await all.evaluate(node=>node===document.activeElement),true);
});
test('a delayed replacement response from page A cannot open over page B inspector',options,async t=>{
 const {page,fixture}=await workspace(t),items=fixture.overview.projects[0].items;for(let i=0;i<2;i++)Object.assign(items[i],{pageId:'page-'+i,state:'completed',fullUrl:'https://published.example/page-'+i});
 await page.route('**/api/lifecycle/projects/p1/pages',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({pages:items.map(item=>({id:item.pageId,projectId:'p1',title:item.title,fullUrl:item.fullUrl,verification:{state:'ok'}}))})}));
 let release,entered;const started=new Promise(resolve=>entered=resolve);await page.route('**/api/lifecycle/pages/page-0/placements',route=>{release=()=>route.fulfill({contentType:'application/json',body:JSON.stringify({pageRevision:1,placements:[]})});entered();});
 await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"] [data-action="preview"]').click();await page.locator('#pq-inspector-details').getByRole('button',{name:'Замінити посилання',exact:true}).click();await started;
 await page.locator('[data-queue-item="q2"] .pq-row-open').focus();await page.keyboard.press('Enter');await page.locator('#pq-review-title').getByText('Generating page',{exact:true}).waitFor();const response=page.waitForResponse(value=>value.url().endsWith('/page-0/placements'));await release();await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('#ap-replacement').isVisible(),false);assert.match(await page.locator('#pq-review-title').textContent(),/Generating page/);
});
test('a changed page disables stale inspector HTML tools until its current preview is opened',options,async t=>{
 const {page,fixture}=await workspace(t);await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"] [data-action="preview"]').click();await page.locator('#pq-review-copy:enabled').waitFor();fixture.overview.projects[0].items[0].title='Changed after opening';await page.locator('#pq-review-note').getByText(/Сторінка змінилась/).waitFor();assert.equal(await page.locator('#pq-review-copy').isDisabled(),true);assert.equal(await page.locator('#pq-review-download').isDisabled(),true);assert.equal(await page.locator('#pq-mark-next').isDisabled(),true);
});
test('legacy published HTML can be inspected and exported without granting publication approval',options,async t=>{
 const {page,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];Object.assign(item,{runId:null,pageId:'old-page',fullUrl:'https://old.example/page/',state:'completed',canApprove:false,verification:{state:'problem',summary:'Перевірте robots'}});await page.route('**/api/lifecycle/pages/old-page',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({page:{remoteSnapshot:{content:'<!doctype html><html><body><h1>Exact old page</h1></body></html>'}}})}));await page.locator('#pq-dashboard-open').click();await page.locator('#pq-filter-state').selectOption('attention');await page.locator('[data-queue-item="q1"] [data-action="preview"]').click();await page.frameLocator('#pq-review-frame').getByRole('heading',{name:'Exact old page'}).waitFor();assert.equal(await page.locator('#pq-mark-reviewed').isDisabled(),true);assert.equal(await page.locator('#pq-review-download').isEnabled(),true);
});

test('project queue shows individual selected donors and starts only the displayed complete project plan',options,async t=>{
 const {page,calls,fixture}=await workspace(t),project=fixture.overview.projects[0];project.publicationPlan={token:null,count:2,blockedReason:'Дочекайтеся підбору всіх сайтів.'};project.items[0].selectedSite={baseUrl:'https://polish-donor.example/',dr:45,traffic:2500,geo:['PL']};
 await page.locator('#pq-dashboard-open').click();const section=page.locator('[data-queue-project="p1"]'),start=()=>section.locator('[data-action="start-project"]');await section.getByText('polish-donor.example',{exact:true}).waitFor();assert.match(await section.locator('[data-queue-item="q1"] .pq-site').textContent(),/DR: 45/);assert.equal(await start().isDisabled(),true);
 project.items[1]={...project.items[1],state:'ready',stage:'installing',selectedSite:{baseUrl:'https://german-donor.example/',dr:38,traffic:1800,geo:['DE']}};project.publicationPlan={token:'a'.repeat(64),count:2,blockedReason:''};await refreshWorkspace(page);await section.getByText('german-donor.example',{exact:true}).waitFor();assert.equal(await start().isEnabled(),true);
 await start().click();await page.locator('#pq-dashboard-note').getByText(/2/).waitFor();const starts=calls.filter(call=>call.endpoint==='/projects/p1/queue/start');assert.equal(starts.length,1);assert.deepEqual(starts[0].body,{planToken:'a'.repeat(64)});assert.equal(calls.some(call=>call.endpoint==='/project-queue/approve'),false);
});
test('queue shows the replacement donor and the reason a previous site was skipped',options,async t=>{
 const {page,fixture}=await workspace(t);const item=fixture.overview.projects[0].items[0];item.selectedSite={baseUrl:'https://replacement.example/',dr:45,traffic:2000,geo:['PL']};item.skippedSites=[{baseUrl:'https://denied.example/',code:'CLEAN_LINKS_INSTALL_FORBIDDEN'},{baseUrl:'https://login-denied.example/',code:'bootstrap_auth_failed'}];
 await page.locator('#pq-dashboard-open').click();const cell=page.locator('[data-queue-item="q1"] .pq-site');await cell.getByText('replacement.example',{exact:true}).waitFor();assert.match(await cell.textContent(),/denied\.example/);assert.match(await cell.textContent(),/встановлення плагіна/);assert.match(await cell.textContent(),/login-denied\.example.*дані.*входу/);
});
test('donor history distinguishes redirect, page and timeout failures from plugin permission',options,async t=>{
 const {page,fixture}=await workspace(t),item=fixture.overview.projects[0].items[0];
 item.selectedSite={baseUrl:'https://replacement.example/'};
 item.skippedSites=[{baseUrl:'https://redirect.example/',code:'BROWSER_ORIGIN_BLOCKED'},{baseUrl:'https://unavailable.example/',code:'BROWSER_PAGE_UNAVAILABLE'},{baseUrl:'https://server-error.example/',code:'BROWSER_PAGE_UNAVAILABLE',httpStatus:500},{baseUrl:'https://timeout.example/',code:'network_timeout'}];
 await page.locator('#pq-dashboard-open').click();const cell=page.locator('[data-queue-item="q1"] .pq-site');await cell.getByText('replacement.example',{exact:true}).waitFor();
 assert.match(await cell.textContent(),/redirect\.example.*переадресац/);
 assert.match(await cell.textContent(),/unavailable\.example.*відкрити WordPress/);
 assert.match(await cell.textContent(),/server-error\.example.*HTTP 500/);
 assert.match(await cell.textContent(),/timeout\.example.*час.*очікування/);
 assert.doesNotMatch(await cell.textContent(),/встановлення плагіна/);
});
test('automatic queue refresh preserves project scrollbars and the outer dialog position while data changes',options,async t=>{
 const {page,fixture}=await workspace(t),project=fixture.overview.projects[0];project.items=Array.from({length:35},(_,index)=>({id:'scroll-'+index,key:'row-'+index,title:'Scrollable page '+index,language:'en',geo:'PL',state:'running',stage:'installing',runId:'run-'+index,selectedSite:{baseUrl:'https://donor-'+index+'.example/',dr:30,traffic:1000,geo:['PL']}}));
 fixture.overview.projects.push({...project,projectId:'p2',name:'Second scroll project',items:project.items.map(item=>({...item,id:'second-'+item.id}))});
 await page.addStyleTag({content:'#pq-dashboard .pq-table{min-width:1400px}'});await page.locator('#pq-dashboard-open').click();
 const wrap=page.locator('[data-queue-project="p1"] .pq-table-wrap');await wrap.evaluate(node=>{node.scrollTop=650;node.scrollLeft=160;window.__queueScrollElement=node;});await page.evaluate(()=>document.scrollingElement.scrollTop=90);
 const before=await wrap.evaluate(node=>({top:node.scrollTop,left:node.scrollLeft})),outer=await page.evaluate(()=>document.scrollingElement.scrollTop);assert.ok(before.top>0);assert.ok(before.left>0);assert.ok(outer>0);
 project.items[0].title='Updated while scrolling';await page.locator('[data-queue-item="scroll-0"] .pq-row-title').getByText('Updated while scrolling',{exact:true}).waitFor({state:'attached'});
 assert.equal(await wrap.evaluate(node=>node===window.__queueScrollElement),true,'Polling must retain the actual scrollbar element while it is being dragged');assert.deepEqual(await wrap.evaluate(node=>({top:node.scrollTop,left:node.scrollLeft})),before);assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),outer);
 const table=await wrap.locator('table').elementHandle();project.items[0].updatedAt='2026-10-24T12:00:00Z';const refresh=await page.waitForResponse(response=>new URL(response.url()).pathname==='/api/lifecycle/project-queue'&&response.request().method()==='GET');await refresh.finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await table.evaluate(node=>node===window.__queueScrollElement.firstElementChild),true,'An unchanged poll must not recreate the table or interrupt user input');
});

test('a 1000-row refresh updates the changed row without rebuilding the rest of the table', options, async t => {
 const { page, fixture } = await workspace(t, { showScrollbars: true });
 const project = fixture.overview.projects[0];
 project.items = Array.from({ length: 1000 }, (_, index) => ({
  id: 'large-' + index, title: (index % 10 ? 'Article ' : 'Guide ') + index,
  language: 'pl', geo: 'PL', state: 'completed',
  pageId: 'page-' + index, fullUrl: 'https://donor.example/' + index,
 }));
 project.counts = { total: 1000, completed: 1000 };
 fixture.overview.projects.push({ projectId: 'p2', name: 'Second project', items: [
  { id: 'second', title: 'Other project', state: 'waiting', geo: 'DE' },
 ] });
 await page.locator('#pq-dashboard-open').click();
 const wrap = page.locator('[data-queue-project=p1] .pq-table-wrap');
 const menu = wrap.locator('[data-queue-item=large-10] details');
 await menu.locator('summary').click();
 const before = await menu.evaluate(element => {
  const scroller = element.closest('.pq-table-wrap');
  scroller.scrollTop = 700;
  element.querySelector('summary').focus({ preventScroll: true });
  window.c03Table = { element, scroller, created: 0 };
  const createElement = document.createElement.bind(document);
  document.createElement = (name, ...args) => {
   if (name === 'tr') window.c03Table.created++;
   return createElement(name, ...args);
  };
  return scroller.scrollTop;
 });
 project.items[999].title = 'Article updated';
 await page.locator('#pq-refresh').evaluate(button => button.click());
 await wrap.locator('[data-queue-item=large-999]').getByText('Article updated', { exact: true }).waitFor({ state: 'attached' });
 const state = await page.evaluate(() => {
  const { element, scroller, created } = window.c03Table;
  return { created, open: element.open && element.isConnected,
   focused: document.activeElement === element.querySelector('summary'), top: scroller.scrollTop };
 });
 assert.equal(state.open, true);
 assert.equal(state.focused, true);
 assert.equal(state.top, before);
 assert.ok(state.created <= 2, 'Only the changed row and its table header may be constructed, found ' + state.created);
 await page.addStyleTag({ content: '.pq-table-wrap::-webkit-scrollbar{width:16px}.pq-table-wrap::-webkit-scrollbar-thumb{min-height:24px;background:#8995a6}' });
 await wrap.scrollIntoViewIfNeeded();
 const thumb = await wrap.evaluate(element => {
  element.scrollTop = 0;
  const bounds = element.getBoundingClientRect();
  const width = element.offsetWidth - element.clientWidth - 2 * element.clientLeft;
  return { width, x: bounds.left + element.clientLeft + element.clientWidth + width / 2, y: bounds.top + element.clientTop + 8 };
 });
 assert.ok(thumb.width > 0, 'The browser must expose a scrollbar for the drag check');
 await page.mouse.move(thumb.x, thumb.y);
 await page.mouse.down();
 try {
  await page.mouse.move(thumb.x, thumb.y + 50, { steps: 5 });
  await page.waitForFunction(() => window.c03Table.scroller.scrollTop > 0);
  const dragged = await wrap.evaluate(element => element.scrollTop);
  project.items[999].title = 'Article updated during drag';
  await page.locator('#pq-refresh').evaluate(button => button.click());
  await wrap.locator('[data-queue-item=large-999]').getByText('Article updated during drag', { exact: true }).waitFor({ state: 'attached' });
  // The native scrollbar can round by one pixel while its thumb is held and
  // a changed row updates the total table height. The scroll container must stay.
  assert.equal(await wrap.evaluate((element, top) => element === window.c03Table.scroller && Math.abs(element.scrollTop - top) <= 1, dragged), true);
 } finally {
  await page.mouse.up();
 }
 await page.locator('#pq-project-filter').selectOption('p1');
 await page.locator('#pq-search').fill('Article');
 assert.equal(await page.locator('[data-queue-item]').count(), 900);
 await page.locator('#pq-search').fill('');
 await page.locator('#pq-project-filter').selectOption('p2');
 assert.equal(await page.locator('[data-queue-item=second]').count(), 1);
 assert.equal(await page.locator('[data-queue-item^=large-]').count(), 0);
});

test('import previews exact per-page settings, blocks invalid rows and retries one immutable import while queues are busy',options,async t=>{
 const {page,calls,fixture}=await workspace(t);await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-name').fill('October pages');await page.locator('#pq-text').fill('key,title,url,anchor,language,geo\none,Polish page,https://example.com/,Exact anchor,pl,PL');await page.locator('#pq-default-language').selectOption('pl');await page.locator('#pq-default-geo').fill('PL');await page.locator('#pq-preview-import').click();await page.locator('#pq-import-rows').getByText('Polish page',{exact:true}).waitFor();assert.equal(await page.locator('#pq-commit-import').isEnabled(),true);assert.match(await page.locator('#pq-import-count').textContent(),/1/);const evidence=evidenceDir(t);await page.locator('#pq-import-dialog').evaluate(dialog=>dialog.scrollTop=0);await page.screenshot({path:path.join(evidence,'queue-import.png'),fullPage:true});
 const preview=calls.find(call=>call.endpoint==='/project-import/preview');assert.equal(preview.body.type,'ai');assert.equal(preview.body.defaults.language,'pl');assert.equal(preview.body.defaults.geo,'PL');await page.locator('#pq-commit-import').click();await page.getByText('Temporary import failure',{exact:true}).waitFor();await page.locator('#pq-commit-import').click();await page.locator('#pq-import-dialog').waitFor({state:'hidden'});const imports=calls.filter(call=>call.endpoint==='/project-queue/import');assert.equal(imports.length,2);assert.deepEqual(imports[1].body,imports[0].body);assert.equal(imports[0].body.items[0].language,'pl');assert.match(imports[0].body.idempotencyKey,/^[\da-f-]{36}$/i);
 await page.locator('#pq-dashboard-close').click();await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-text').fill('bad row');fixture.preview={items:[],issues:[{row:2,message:'Missing anchor'}],source:{kind:'table'}};await page.locator('#pq-preview-import').click();await page.locator('#pq-import-issues').getByText('Missing anchor',{exact:false}).waitFor();assert.equal(await page.locator('#pq-commit-import').isDisabled(),true);
});

test('publication accepts only the exact explicitly reviewed row and invalidates review on changed queue data',options,async t=>{
 const {page,calls,fixture}=await workspace(t);fixture.overview.projects[0].items[0].warnings=['Вбудований скрипт видалено.'];await page.locator('#pq-dashboard-open').click();await page.locator('[data-queue-item="q1"]').waitFor();assert.equal(await page.locator('#pq-approve-selected').isDisabled(),true);assert.match(await page.locator('#pq-generation').textContent(),/1.*2/);assert.match(await page.locator('#pq-publication').textContent(),/0.*3/);
 const evidence=evidenceDir(t);await page.screenshot({path:path.join(evidence,'queue-dashboard.png'),fullPage:false});await page.locator('[data-queue-item="q1"] [data-action=preview]').click();await page.frameLocator('#pq-review-frame').getByRole('heading',{name:'Reviewed page'}).waitFor();await page.locator('#pq-review-warnings').getByText('Вбудований скрипт видалено.',{exact:true}).waitFor();assert.equal(await page.locator('#pq-review-frame').getAttribute('sandbox'),'allow-scripts');await page.locator('#pq-mark-reviewed').click();await page.locator('[data-queue-item="q1"] input[type=checkbox]').check();await page.locator('#pq-approve-selected').click();await page.getByText(/Передано на публікацію/).waitFor();assert.deepEqual(calls.find(call=>call.endpoint==='/project-queue/approve').body,{items:[{id:'q1',reviewToken:'exact-r1-review'}]});
 await page.locator('[data-queue-item="q1"] [data-action=preview]').click();await page.frameLocator('#pq-review-frame').getByRole('heading',{name:'Reviewed page'}).waitFor();await page.locator('#pq-mark-reviewed').click();fixture.overview.projects[0].items[0].title='Changed page';await refreshWorkspace(page);await page.locator('[data-queue-item="q1"]').getByText('Changed page',{exact:true}).waitFor();assert.equal(await page.locator('#pq-approve-selected').isDisabled(),true);await page.locator('[data-action=pause]').click();await page.getByRole('button',{name:'Продовжити проєкт',exact:true}).waitFor();assert.equal(calls.some(call=>call.endpoint==='/projects/p1/queue'&&call.body.action==='pause'),true);
});

test('typed projects lock their single-page source and HTML imports carry local files without AI calls',options,async t=>{
 const {page,calls,fixture}=await workspace(t);assert.equal(await page.locator('.ap-source-choice').isVisible(),false);await page.getByRole('button',{name:'HTML проєкт',exact:true}).click();assert.equal(await page.locator('#ap-html-inputs').isVisible(),true);assert.equal(await page.locator('.ap-source-choice').isVisible(),false);
 await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');await page.locator('#pq-source').selectOption('files');const html='<html lang="de"><body><h1>File page</h1></body></html>';await page.locator('#pq-html-files').setInputFiles({name:'page.html',mimeType:'text/html',buffer:Buffer.from(html)});fixture.preview={items:[{key:'page.html',title:'File page',source:'html',html,language:'de',geo:'DE',siteSelection:{geo:'DE'}}],issues:[],source:{kind:'files'}};await page.locator('#pq-preview-import').click();await page.locator('#pq-import-rows').getByText('File page',{exact:true}).waitFor();const request=calls.filter(call=>call.endpoint==='/project-import/preview').at(-1);assert.equal(request.body.type,'html');assert.deepEqual(request.body.files,[{name:'page.html',html}]);assert.equal(calls.some(call=>call.endpoint.startsWith('/api/ai/')),false);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
});

test('HTML table rows can map local files and Google Drive files while preserving their own settings',options,async t=>{
 const {page,calls}=await workspace(t);await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');await page.locator('#pq-source').selectOption('text');await page.locator('#pq-text').fill('key,title,file,language,geo\none,File page,page.html,de,DE');await page.locator('#pq-html-attachment').selectOption('files');const html='<h1>Mapped page</h1>';await page.locator('#pq-html-files').setInputFiles({name:'page.html',mimeType:'text/html',buffer:Buffer.from(html)});await page.locator('#pq-preview-import').click();await page.locator('#pq-import-rows').getByText('Polish page',{exact:true}).waitFor();const local=calls.filter(call=>call.endpoint==='/project-import/preview').at(-1).body;assert.match(local.text,/page.html,de,DE/);assert.deepEqual(local.files,[{name:'page.html',html}]);
 await page.locator('#pq-source').selectOption('sheets');await page.locator('#pq-sheet-url').fill('https://docs.google.com/spreadsheets/d/fixture');await page.locator('#pq-sheet-range').fill('Pages!A1:H10');await page.locator('#pq-html-attachment').selectOption('drive');await page.locator('#pq-drive-url').fill('https://drive.google.com/drive/folders/folder');await page.locator('#pq-preview-import').click();await page.locator('#pq-import-rows').getByText('Polish page',{exact:true}).waitFor();const remote=calls.filter(call=>call.endpoint==='/project-import/preview').at(-1).body;assert.equal(remote.spreadsheetUrl,'https://docs.google.com/spreadsheets/d/fixture');assert.equal(remote.range,'Pages!A1:H10');assert.equal(remote.driveUrl,'https://drive.google.com/drive/folders/folder');assert.equal(remote.files,undefined);assert.equal(remote.text,undefined);
});

test('desktop project heading has no empty-project shortcut and keeps management and import',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true});
 assert.equal(await page.locator('#ap-new-project').count(),0);
 await page.getByRole('button',{name:'Керувати проєктами',exact:true}).click();
 await page.locator('#ap-project-manager[open]').waitFor();
 await page.getByRole('button',{name:'Закрити керування проєктами',exact:true}).click();
 await page.getByRole('button',{name:'Імпорт проєкту',exact:true}).click();
 await page.locator('#pq-import-dialog[open]').waitFor();
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
});

test('an empty desktop starts a single page without an unavailable project shortcut or silent creation',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true,empty:true});
 await page.getByRole('button',{name:'Додати одну сторінку',exact:true}).click();
 await page.locator('#ap-project-dialog[open]').waitFor();
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
 await page.getByRole('button',{name:'Закрити створення проєкту',exact:true}).click();
 assert.equal(await page.locator('#pq-dashboard').isVisible(),true);
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
 await page.getByRole('button',{name:'Додати одну сторінку',exact:true}).click();
 await page.locator('#ap-project-dialog input[name=projectName]').fill('Перша сторінка');
 await page.locator('#ap-project-form button[type=submit]').click();
 await page.locator('#ap-launch-form').waitFor();
 assert.equal(await page.locator('#pq-dashboard').isVisible(),false);
 assert.equal(calls.filter(call=>call.endpoint==='/projects'&&call.method==='POST').length,1);
 assert.equal(calls.some(call=>/queue\/start|queue\/approve|autopilot\/launch/.test(call.endpoint)),false);
});

test('project selection advice names real controls instead of a removed shortcut',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true});
 fixture.overview.projects.push({projectId:'p2',name:'HTML проєкт',type:'html',items:[],counts:{total:0}});
 await page.locator('#pq-dashboard-open').click();
 await page.locator('[data-queue-project=p2]').waitFor();
 await page.getByRole('button',{name:'Додати одну сторінку',exact:true}).click();
 const hint=await page.locator('#pq-dashboard-note').textContent();
 assert.doesNotMatch(hint,/«\+»|плюс/i);assert.match(hint,/Імпорт проєкту/);
});

test('the removed project shortcut is absent on mobile too',options,async t=>{
 const {page}=await workspace(t,{desktop:true});await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('.ap-mobile-new').count(),0);
});

test('one-page creation waits for queue discovery instead of treating loading as no projects',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{desktop:true,deferQueue:true});
 assert.equal(await page.locator('#pq-dashboard-close').isDisabled(),true);
 assert.equal(await page.locator('#ap-project-dialog').isVisible(),false);
 fixture.releaseQueue();await page.locator('[data-queue-item=q1]').waitFor();
 await page.locator('#pq-dashboard-close').click();await page.locator('#ap-launch-form').waitFor();
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
});

test('an old project outside the typed queue opens its own composer without creating another project',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true,legacy:true});await page.locator('#pq-projects > .pq-empty').waitFor();
 await page.locator('#pq-dashboard-close').click();await page.locator('#ap-launch-form').waitFor();
 assert.equal(await page.locator('#ap-project-dialog').isVisible(),false);
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
});
test('one queued project cannot hide another empty legacy project when adding a page',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{desktop:true});fixture.projects[1]={id:'p2',name:'Старий проєкт'};
 await refreshWorkspace(page);await page.locator('#pq-project-filter').selectOption('');await page.locator('#pq-dashboard-close').click();
 await page.locator('#pq-dashboard-note').getByText(/Оберіть доступний проєкт/).waitFor();
 assert.equal(await page.locator('#ap-launch-form').isVisible(),false);
 assert.equal(await page.locator('#ap-project-dialog').isVisible(),false);
 assert.equal(calls.some(call=>call.endpoint==='/projects'&&call.method==='POST'),false);
});

test('a queued close event cannot clear a reopened first-page dialog intent',options,async t=>{
 const {page,calls}=await workspace(t,{desktop:true,empty:true});await page.locator('#pq-dashboard-close').click();
 await page.evaluate(()=>{document.getElementById('ap-project-dialog').close();window.dispatchEvent(new Event('pageposter:queue-project-create'));});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.locator('#ap-project-dialog input[name=projectName]').fill('Повторне відкриття');
 await page.locator('#ap-project-form button[type=submit]').click();await page.locator('#ap-launch-form').waitFor();
 assert.equal(await page.locator('#pq-dashboard').isVisible(),false);
 assert.equal(calls.filter(call=>call.endpoint==='/projects'&&call.method==='POST').length,1);
});

test('a parked creation without a confirmed identity exposes its reason rather than an impossible resume',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'needs_attention',publicationParked:true,canResumeParked:false,parkedResumeBlockedReason:'WordPress не підтвердив ID створеної сторінки.'});
 await refreshWorkspace(page);
 const row=page.locator('[data-queue-item=q1]');
 assert.equal(await row.locator('[data-action=resume-parked]').count(),0);
 await row.getByText(item.parkedResumeBlockedReason,{exact:true}).waitFor();
});

test('a paused preview with a stored token describes read-only access instead of prompting approval',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true});fixture.overview.projects[0].items[0].canApprove=false;
 await refreshWorkspace(page);await page.locator('[data-queue-item=q1] [data-action=preview]').click();
 await page.frameLocator('#pq-review-frame').getByRole('heading',{name:'Reviewed page'}).waitFor();
 assert.equal(await page.locator('#pq-mark-reviewed').isDisabled(),true);
 assert.match(await page.locator('#pq-review-note').textContent(),/недоступне|лише/i);
});

test('queue search finds the displayed HTML and table filenames with opaque task keys',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true});
 fixture.overview.projects[0].items[0].provenance={kind:'archive',source:{file:'campaign-landing.html',tableFile:'instructions-2026.csv',row:2}};
 await refreshWorkspace(page);
 await page.locator('#pq-search').fill('campaign-landing.html');
 await page.locator('[data-queue-item=q1]').waitFor();
 assert.equal(await page.locator('[data-queue-item=q2]').count(),0);
 await page.locator('#pq-search').fill('instructions-2026.csv');
 await page.locator('[data-queue-item=q1]').waitFor();
});

test('CSV reports the visible manual review result and confirmed trash is not an active publication',options,async t=>{
 const {page,fixture}=await workspace(t,{desktop:true}),item=fixture.overview.projects[0].items[0];
 Object.assign(item,{state:'completed',fullUrl:'https://published.example/page/',manualReview:{state:'approved'}});
 await refreshWorkspace(page);await page.locator('[data-queue-item=q1]').getByText('Опубліковано · схвалено',{exact:true}).waitFor();
 await page.getByText('Вигляд і експорт',{exact:true}).click();
 const downloading=page.waitForEvent('download');await page.locator('#pq-export').click();
 const csv=fs.readFileSync(await(await downloading).path(),'utf8');assert.match(csv,/Опубліковано · схвалено/);
 item.manualReview={state:'trashed'};item.fullUrl='';
 await refreshWorkspace(page);await page.locator('#pq-filter-state').selectOption('completed');
 assert.equal(await page.locator('[data-queue-item=q1]').count(),0);
});
