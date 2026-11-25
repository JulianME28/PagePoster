'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('./browser-runtime.cjs').playwright;
const chrome=require('./browser-runtime.cjs').chromePath;
const endpoint='/autopilot/donor-exclusions',privateText='PRIVATE_POLICY_REFERENCE';
const entry=(id='ban-1',patch={})=>({id,revision:3,origin:'https://blocked.example',type:'manual',code:'MANUAL_BAN',reason:'Ручна заборона',observedAt:'2026-11-03T10:00:00Z',expiresAt:null,releasedAt:null,active:true,legacy:false,canRelease:true,...patch});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function workspace(t,options={}){
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-background-networking','--no-first-run']}),page=await browser.newPage({viewport:{width:1440,height:1000}}),root=path.resolve(__dirname,'../dist'),calls=[],errors=[],external=[];
 const fixture={items:[entry()],total:1,...options};
 t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);});page.setDefaultTimeout(3500);page.on('pageerror',error=>errors.push(error.message));
 if(options.desktop)await page.addInitScript(()=>{window.pageposterDesktop={};});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!=='http://workspace.example'){external.push(url.origin);return route.abort();}
  if(!url.pathname.startsWith('/api/')){const file=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));assert.ok(file.startsWith(root+path.sep));return fs.existsSync(file)?route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)}):route.fulfill({status:404,body:''});}
  const routePath=url.pathname.replace('/api/lifecycle',''),method=request.method(),body=request.postDataJSON();calls.push({path:routePath,method,body,query:Object.fromEntries(url.searchParams)});let data={};
  if(routePath===endpoint&&method==='GET'){await fixture.beforeList?.(url);data=fixture.list?fixture.list(url):{total:fixture.total,offset:Number(url.searchParams.get('offset')||0),limit:30,items:fixture.items};}
  else if(routePath===endpoint+'/ban'||routePath===endpoint+'/release'){await fixture.beforeWrite?.(body);if(fixture.conflict)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'CONFLICT',error:'Застаріла версія '+privateText})});if(routePath.endsWith('/release'))fixture.items=fixture.items.filter(item=>item.id!==body.id);else fixture.items=[entry('new-ban',{origin:'https://new.example',revision:1})];fixture.total=fixture.items.length;data={item:fixture.items[0]||entry('released',{active:false,releasedAt:'2026-11-03T11:00:00Z'})};}
  else if(routePath==='/projects')data={projects:[{id:'p1',name:'Перший',workflowType:'html'},{id:'p2',name:'Другий',workflowType:'html'}]};
  else if(routePath==='/autopilot/status')data={source:{configured:true},aiConfigured:true};
  else if(routePath==='/project-queue')data=fixture.queue||{projects:[],generation:{active:0,waiting:0},publication:{active:0,waiting:0}};
  else if(routePath==='/projects/p1/autopilot')data={runs:fixture.runs||[]};
  else if(routePath==='/autopilot/run-1/donors')data=fixture.catalogue;
  else if(routePath.endsWith('/pages')||routePath.endsWith('/overview'))data={pages:[]};
  else if(routePath.endsWith('/autopilot'))data={runs:[]};
  else if(routePath.endsWith('/jobs'))data={jobs:[]};
  else if(routePath==='/api/ai/status')data={configured:true};
  else data={source:{configured:false}};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://workspace.example/');await page.waitForFunction(()=>document.querySelector('#ap-title').textContent==='Перший');await page.locator('#ap-results[aria-busy]').waitFor({state:'detached'});
 async function open(){await page.locator('#ap-settings-open').click();await page.locator('#ap-exclusions-open').click();await page.locator('#ap-exclusions[open]').waitFor();await page.locator('#ap-exclusions-list[aria-busy="false"]').waitFor();}
 return {page,calls,fixture,open,writes:()=>calls.filter(c=>['POST','PATCH','DELETE'].includes(c.method))};
}

test('source settings expose the global stop-list with text-only reasons and expiry',async t=>{
 const f=await workspace(t,{desktop:true,items:[entry('temp',{type:'transient',reason:'<img src=x onerror=alert(1)>',expiresAt:'2026-11-03T12:15:00Z',credentialRef:privateText,password:privateText,cookies:privateText}),entry('legacy',{legacy:true,reason:'Потрібен перегляд'})],total:2});await f.open();
 const text=await f.page.locator('#ap-exclusions').textContent();assert.match(text,/Стоп-лист донорів/);assert.match(text,/Тимчасово недоступний до/);assert.match(text,/<img src=x/);assert.match(text,/перегляд/i);assert.match(text,/опублікован|невизначен/);assert.doesNotMatch(text,new RegExp(privateText));assert.equal(await f.page.locator('#ap-exclusions img').count(),0);assert.equal(await f.page.locator('.ap-sidebar #ap-exclusions-open').count(),0);assert.equal(f.writes().length,0);
 for(const width of [390,320]){await f.page.setViewportSize({width,height:844});const size=await f.page.locator('#ap-exclusions').evaluate(d=>({scroll:d.scrollWidth,width:d.clientWidth,right:d.getBoundingClientRect().right,left:d.getBoundingClientRect().left}));assert.ok(size.scroll<=size.width+1&&size.left>=0&&size.right<=width+1,JSON.stringify(size));}
});

test('ban and release are single local revision-bound writes followed by a list refresh',async t=>{
 const f=await workspace(t);await f.open();await f.page.getByRole('button',{name:'Повернути до підбору',exact:true}).click();await f.page.locator('#ap-exclusions-list').getByText(/немає/i).waitFor();assert.deepEqual(f.writes()[0],{path:endpoint+'/release',method:'POST',body:{id:'ban-1',expectedRevision:3},query:{}});
 await f.page.locator('#ap-exclusions-origin').fill('new.example');await f.page.locator('#ap-exclusions-form button[type=submit]').click();await f.page.locator('#ap-exclusions-list').getByText('https://new.example',{exact:true}).waitFor();assert.deepEqual(f.writes()[1],{path:endpoint+'/ban',method:'POST',body:{origin:'new.example',expectedRevision:0},query:{}});assert.equal(f.calls.filter(c=>c.path===endpoint&&c.method==='GET').length,3);assert.equal(f.writes().length,2);
});

test('legacy migration preview can explicitly release a zero-revision historical restriction',async t=>{
 const f=await workspace(t,{items:[entry('legacy-policy',{type:'security',legacy:true,revision:0})]});await f.open();await f.page.getByRole('button',{name:'Повернути до підбору',exact:true}).click();await f.page.locator('#ap-exclusions-list').getByText(/немає/i).waitFor();assert.deepEqual(f.writes()[0].body,{id:'legacy-policy',expectedRevision:0});
});

test('history distinguishes advisory plugin facts, expired cooldowns and deliberate releases',async t=>{
 const f=await workspace(t,{items:[entry('advisory',{type:'plugin',reason:'Публікація з visual fallback доступна',expiresAt:'2026-11-04T10:00:00Z'}),entry('expired',{type:'transient',active:false,canRelease:false,expiresAt:'2026-11-02T10:00:00Z'}),entry('released',{active:false,canRelease:false,releasedAt:'2026-11-03T11:00:00Z'})],total:3});await f.open();await f.page.locator('#ap-exclusions-state').selectOption('all');await f.page.locator('#ap-exclusions-list[aria-busy="false"]').waitFor();const rows=f.page.locator('#ap-exclusions-list .ap-donor-row');assert.match(await rows.nth(0).textContent(),/Зауваження чинне до/);assert.doesNotMatch(await rows.nth(0).textContent(),/Тимчасово недоступний/);assert.match(await rows.nth(1).textContent(),/Строк минув/);assert.match(await rows.nth(2).textContent(),/Знято:/);assert.equal(await rows.nth(1).getByRole('button').count(),0);assert.equal(await rows.nth(2).getByRole('button').count(),0);assert.equal(f.writes().length,0);
});

test('stale release refreshes the displayed revision and never retries the write',async t=>{
 const f=await workspace(t);await f.open();f.fixture.conflict=true;f.fixture.items=[entry('ban-1',{revision:8,reason:'Оновлена заборона'})];await f.page.getByRole('button',{name:'Повернути до підбору',exact:true}).click();await f.page.locator('#ap-exclusions-list').getByText(/Оновлена заборона/).waitFor();assert.match(await f.page.locator('#ap-exclusions-note').textContent(),/змінив|оновлен|повтор/i);assert.doesNotMatch(await f.page.locator('#ap-exclusions').textContent(),new RegExp(privateText));assert.equal(f.writes().length,1);f.fixture.conflict=false;await f.page.getByRole('button',{name:'Повернути до підбору',exact:true}).click();await f.page.locator('#ap-exclusions-list').getByText(/немає/i).waitFor();assert.equal(f.writes()[1].body.expectedRevision,8);
});

test('search, active/all and pagination only read the requested list page',async t=>{
 const f=await workspace(t,{total:65,list:url=>({total:65,offset:Number(url.searchParams.get('offset')),limit:30,items:[entry('page-'+url.searchParams.get('offset'))]})});await f.open();await f.page.locator('#ap-exclusions-next').click();await f.page.waitForFunction(()=>document.querySelector('#ap-exclusions-count').textContent.includes('31'));assert.equal(f.calls.filter(c=>c.path===endpoint).at(-1).query.offset,'30');await f.page.locator('#ap-exclusions-state').selectOption('all');await f.page.waitForFunction(()=>document.querySelector('#ap-exclusions-count').textContent.includes('1–'));await f.page.locator('#ap-exclusions-search').fill('blocked');await f.page.waitForResponse(r=>r.url().includes('search=blocked'));const latest=f.calls.filter(c=>c.path===endpoint).at(-1);assert.deepEqual(latest.query,{search:'blocked',offset:'0',limit:'30',state:'all'});assert.equal(f.writes().length,0);
});

test('duplicate submits are ignored and closed or changed-project reads cannot replace a new session',async t=>{
 const f=await workspace(t);await f.open();const gate=deferred(),started=deferred();f.fixture.beforeWrite=async()=>{started.resolve();await gate.promise;};await f.page.locator('#ap-exclusions-origin').fill('new.example');await f.page.locator('#ap-exclusions-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await started.promise;assert.equal(f.writes().length,1);await f.page.getByRole('button',{name:'Закрити стоп-лист',exact:true}).click();gate.resolve();await f.page.waitForResponse(r=>r.url().endsWith('/ban'));assert.equal(await f.page.locator('#ap-exclusions[open]').count(),0);
 f.fixture.beforeWrite=null;const read=deferred(),readStarted=deferred();f.fixture.beforeList=async()=>{readStarted.resolve();await read.promise;};await f.page.locator('#ap-exclusions-open').click();await readStarted.promise;await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('pageposter:project-selected',{detail:{projectId:'p2'}})));read.resolve();await f.page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/donor-exclusions'));assert.equal(await f.page.locator('#ap-exclusions[open]').count(),0);assert.equal(await f.page.locator('#ap-exclusions-list').textContent(),'');
});

test('queue diagnostics show optional policy counts safely alongside ownership totals',async t=>{
 const diagnostic={total:10,geo:10,dr:10,eligible:10,reserved:8,available:2,unavailable:{published:1,reserved:1,excluded:6,other:0,manual:2,temporary:1,credentials:1,visual:1,security:1,credentialRef:privateText}};
 const f=await workspace(t,{queue:{projects:[{projectId:'p1',name:'Перший',type:'html',counts:{total:1,attention:1},items:[{id:'item-1',title:'Немає донора',source:'html',state:'needs_attention',selectionDiagnostics:diagnostic}]}],generation:{active:0,waiting:0},publication:{active:0,waiting:0}}});await f.page.locator('#pq-dashboard-open').click();const row=f.page.locator('[data-queue-item="item-1"]');await row.waitFor();const text=await row.textContent();for(const expression of [/ручні заборони: 2/i,/тимчасові відмови: 1/i,/дані для входу: 1/i,/вигляд: 1/i,/безпека: 1/i,/опубліковано: 1/i])assert.match(text,expression);assert.doesNotMatch(text,new RegExp(privateText));assert.equal(f.writes().length,0);
});

test('partial policy diagnostics display valid optional counters and ignore malformed values',async t=>{
 const selectionDiagnostics={total:2,geo:2,dr:2,eligible:2,reserved:2,available:0,unavailable:{published:1,reserved:0,excluded:1,other:0,manual:1,credentials:privateText,temporary:-1,visual:1.5}};
 const f=await workspace(t,{queue:{projects:[{projectId:'p1',name:'Перший',type:'html',counts:{total:1,attention:1},items:[{id:'partial-policy',title:'Часткова діагностика',state:'needs_attention',selectionDiagnostics}]}],generation:{active:0,waiting:0},publication:{active:0,waiting:0}}});await f.page.locator('#pq-dashboard-open').click();const row=f.page.locator('[data-queue-item="partial-policy"]');await row.waitFor();const text=await row.textContent();assert.match(text,/ручні заборони: 1/i);assert.doesNotMatch(text,new RegExp(privateText));assert.doesNotMatch(text,/тимчасові відмови: -1|вигляд: 1.5/);
});

for(const submitted of ['https://blocked.example/','https://blocked.example/blog/'])test('re-banning a released donor normalizes conflict history for '+submitted,async t=>{
 const previous=entry('released-ban',{revision:3,active:false,releasedAt:'2026-11-03T11:00:00Z',canRelease:false}),f=await workspace(t,{items:[],total:0,list:url=>({offset:0,limit:30,total:url.searchParams.get('state')==='all'&&url.searchParams.get('search')==='https://blocked.example'?1:0,items:url.searchParams.get('state')==='all'&&url.searchParams.get('search')==='https://blocked.example'?[previous]:[]})});
 await f.open();f.fixture.beforeWrite=body=>{f.fixture.conflict=body.expectedRevision!==3;};await f.page.locator('#ap-exclusions-origin').fill(submitted);await f.page.locator('#ap-exclusions-form button[type=submit]').click();await f.page.locator('#ap-exclusions-note').getByText(/Стоп-лист змінився/).waitFor();await f.page.locator('#ap-exclusions-list[aria-busy="false"]').waitFor();assert.equal(await f.page.locator('#ap-exclusions-search').inputValue(),'https://blocked.example');assert.equal(await f.page.locator('#ap-exclusions-state').inputValue(),'all');assert.equal(await f.page.locator('#ap-exclusions-list .ap-donor-row').count(),1);assert.equal(f.writes().length,1);
 await f.page.locator('#ap-exclusions-form button[type=submit]').click();await f.page.locator('#ap-exclusions-note').getByText(/Ручну заборону збережено/).waitFor();assert.equal(f.writes().length,2);assert.equal(f.writes()[1].body.expectedRevision,3);assert.equal(f.writes()[1].body.origin,submitted);
});

test('catalogue displays policy expiry and keeps a hard-banned donor unavailable even with all enabled',async t=>{
 const run={id:'run-1',projectId:'p1',state:'awaiting_review',pageId:'page-1',title:'Матеріал',hasHtml:false,canSetDestination:true,destinationRevision:2};
 const f=await workspace(t,{runs:[run],catalogue:{run,token:'catalogue-token',destinationRevision:2,total:1,offset:0,limit:30,criteria:{},candidates:[{id:'blocked',baseUrl:'https://blocked.example/',available:false,matchesCriteria:true,exclusion:{type:'manual',reason:'Заборонено вручну',expiresAt:null,canRelease:true,credentialRef:privateText}}]}});await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('pageposter:choose-donor',{detail:{projectId:'p1',runId:'run-1'}})));await f.page.locator('#ap-donor-list .ap-donor-row').waitFor();assert.match(await f.page.locator('#ap-donor-list').textContent(),/Заборонено вручну/);assert.equal(await f.page.locator('[data-donor-choice="blocked"]').isDisabled(),true);await Promise.all([f.page.waitForResponse(r=>r.url().includes('/donors?')&&r.url().includes('all=1')),f.page.locator('#ap-donor-all').check()]);assert.equal(await f.page.locator('[data-donor-choice="blocked"]').isDisabled(),true);assert.doesNotMatch(await f.page.locator('#ap-donor-list').textContent(),new RegExp(privateText));assert.equal(f.writes().length,0);
});

test('manual catalogue shows a numbered locale reserve without selecting it',async t=>{
 const run={id:'run-1',projectId:'p1',state:'awaiting_review',pageId:'page-1',title:'Матеріал',hasHtml:false,canSetDestination:true,destinationRevision:2};
 const f=await workspace(t,{runs:[run],catalogue:{run,token:'catalogue-token',destinationRevision:2,total:0,offset:0,limit:30,criteria:{geo:'GB'},candidates:[]}});
 await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('pageposter:choose-donor',{detail:{projectId:'p1',runId:'run-1'}})));
 await f.page.locator('#ap-donor-list').getByText(/донорів немає/).waitFor();
 f.fixture.catalogue={...f.fixture.catalogue,total:1,candidates:[{id:'reserve',baseUrl:'https://reserve.example/',available:true,matchesCriteria:false,warning:'Сайт можна обрати вручну.',recommendation:{group:'locale',reason:'GB → англомовна локаль (NZ).',primary:false,reserveRank:1}}]};
 await f.page.locator('#ap-donor-all').check();
 const row=f.page.locator('#ap-donor-list .ap-donor-row');
 await row.getByText('Резерв №1 · GB → англомовна локаль (NZ).',{exact:true}).waitFor();
 assert.match(await row.textContent(),/Сайт можна обрати вручну/);
 assert.equal(await row.getByRole('button',{name:'Обрати',exact:true}).isEnabled(),true);
 assert.equal(f.writes().length,0);
});
