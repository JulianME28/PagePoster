'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath,chromePath=require('./browser-runtime.cjs').chromePath;
const browserOptions={timeout:45000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
async function workspace(t,options={}){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),calls=[],errors=[];
 const fixture={projects:[{id:'p1',name:'Первый',revision:1},{id:'p2',name:'Второй',revision:1}],pages:[],jobs:[],jobReads:0,launches:0};
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html',file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end('Missing');}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 t.after(async()=>{await context.close();await browser.close();await new Promise(r=>server.close(r));assert.deepEqual(errors,[]);});
 if(options.storageBlocked)await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Storage is blocked','SecurityError');};});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();calls.push({endpoint,method,body});let data;
  if(endpoint==='/projects')data={projects:fixture.projects};
  else if(endpoint==='/autopilot/status')data={source:{configured:false},aiConfigured:true};
  else if(/^\/projects\/p[12]\/pages$/.test(endpoint)){
   if(options.failFinalSnapshot&&fixture.replacementReads>=3&&!fixture.snapshotFailed){fixture.snapshotFailed=true;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Последнее обновление временно недоступно"}'});}
   data={pages:fixture.pages.filter(p=>p.projectId===endpoint.split('/')[2])};
  }
  else if(/^\/projects\/p[12]\/overview$/.test(endpoint))data={pages:fixture.pages.filter(p=>p.projectId===endpoint.split('/')[2]).map(p=>({pageId:p.id,verification:p.verification})),incidents:[]};
  else if(/^\/projects\/p[12]\/autopilot$/.test(endpoint)&&method==='GET')data={runs:[]};
  else if(/^\/projects\/p[12]\/autopilot$/.test(endpoint)&&method==='POST'){fixture.launches++;if(options.failedLaunch)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Ответ сервера потерян"}'});data={run:{id:'run1',projectId:endpoint.split('/')[2],state:'waiting_source',stage:'selecting'}};}
  else if(endpoint==='/autopilot/preview')data={html:'<h1>Материал</h1>',title:'Материал',warnings:['Изменён элемент.'],reviewToken:'review-fixture'};
  else if(endpoint==='/pages/page1/placements')data={pageRevision:4,placements:[{id:'cta',label:'Кнопка',url:'https://old.example/?x=%2F',anchor:'Кнопка',anchorEditable:true}]};
  else if(endpoint==='/pages/page1/proposals')data={proposal:{id:'proposal1',revision:1,diff:[{label:'Кнопка',before:{url:'https://old.example/?x=%2F'},after:{url:body.changes[0].url}}]}};
  else if(endpoint==='/proposals/proposal1/confirm'){fixture.jobs=[{id:'replace1',projectId:'p1',pageId:'page1',type:'replace',state:'queued'}];data={job:fixture.jobs[0]};}
  else if(/^\/projects\/p[12]\/jobs$/.test(endpoint)){
   fixture.jobReads++;if(fixture.jobs.length)fixture.replacementReads=(fixture.replacementReads||0)+1;
   if(options.replacement&&fixture.replacementReads===2)fixture.jobs=[{id:'replace1',projectId:'p1',pageId:'page1',type:'replace',state:'completed'},{id:'verify1',projectId:'p1',pageId:'page1',type:'page_check',state:'running'}];
   if(options.replacement&&fixture.replacementReads>=3){fixture.jobs=fixture.jobs.map(j=>({...j,state:'completed'}));fixture.pages[0].verification={state:'problem',summary:'Новая проверка: ссылка недоступна',checkedAt:'2026-10-15T15:00:00Z'};}
   data={jobs:fixture.jobs.filter(j=>j.projectId===endpoint.split('/')[2])};
  }
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/autopilot.html');await page.getByRole('heading',{name:'Первый',exact:true}).waitFor();
 return {page,calls,fixture};
}
async function loaded(page,name){await page.getByRole('heading',{name,exact:true}).waitFor();await page.locator('#ap-launch-form').waitFor({state:'attached'});}

test('workspace keeps exact per-project drafts, mode, row edits and selection after reload; HTML needs a fresh review',browserOptions,async t=>{
 const {page}=await workspace(t),url='https://offer.example/?x=%2F&tag=a&tag=b#part',anchor='  Точный анкор  ',html='<html><body><h1>Свой материал</h1><p>  Точный текст  </p></body></html>';
 await page.locator('[name=linkUrl]').fill(url);await page.locator('[name=linkAnchor]').fill(anchor);await page.locator('#ap-add-link').click();await page.reload();await loaded(page,'Первый');assert.equal(await page.locator('.ap-link-row').count(),2,'Added rows persist immediately');
 await page.locator('[name=linkUrl]').nth(1).fill('https://remove.example/');await page.locator('[name=linkAnchor]').nth(1).fill('Удаляем');await page.getByRole('button',{name:'Видалити посилання',exact:true}).nth(1).click();
 await page.reload();await loaded(page,'Первый');assert.equal(await page.locator('[name=linkUrl]').inputValue(),url,'Editing a draft must survive reload without first switching projects');assert.equal(await page.locator('[name=linkAnchor]').inputValue(),anchor);assert.equal(await page.locator('.ap-link-row').count(),1);
 await page.getByLabel('Готовий HTML',{exact:true}).check();await page.locator('[name=customerHtml]').fill(html);await page.getByLabel('Лише перекрити хедер і футер сайту',{exact:true}).check();
 await page.locator('#ap-launch').click();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал',exact:true}).waitFor();await page.locator('[name=acceptHtmlChanges]').check();
 await page.reload();await loaded(page,'Первый');assert.equal(await page.getByLabel('Готовий HTML',{exact:true}).isChecked(),true);assert.equal(await page.locator('[name=customerHtml]').inputValue(),html);assert.equal(await page.getByLabel('Лише перекрити хедер і футер сайту',{exact:true}).isChecked(),true);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true,'Restored drafts require a new HTML preview');assert.equal(await page.locator('#ap-html-review').isVisible(),false);assert.ok(!(await page.evaluate(()=>sessionStorage.getItem('pageposter-autopilot-drafts:v1'))).includes('reviewToken'),'Draft cache must not grant HTML publication approval');
 await page.getByRole('button',{name:'Второй',exact:true}).click();await page.locator('[name=linkUrl]').fill('https://second.example/?keep=%2f');await page.locator('[name=linkAnchor]').fill('Второй');
 await page.reload();await loaded(page,'Второй');assert.equal(await page.locator('[name=linkAnchor]').inputValue(),'Второй');
 await page.locator('#ap-all').click();await page.reload();await page.getByRole('heading',{name:'Усі сторінки',exact:true}).waitFor();assert.equal(await page.locator('#ap-composer').isVisible(),false);
 await page.getByRole('button',{name:'Первый',exact:true}).click();assert.equal(await page.locator('[name=customerHtml]').inputValue(),html);await page.getByLabel('ШІ за посиланнями й анкорами',{exact:true}).check();assert.equal(await page.locator('[name=linkUrl]').inputValue(),url);assert.equal(await page.locator('[name=linkAnchor]').inputValue(),anchor);
});

test('an unresolved launch restores its exact pending payload and idempotency key ahead of edited drafts',browserOptions,async t=>{
 const {page,calls}=await workspace(t,{failedLaunch:true});await page.locator('[name=linkUrl]').fill('https://pending.example/?x=%2F');await page.locator('[name=linkAnchor]').fill('  Pending  ');await page.locator('#ap-launch').click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();
 const first=calls.find(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').body;await page.locator('[name=linkUrl]').fill('https://different.example/');assert.equal(await page.locator('#ap-launch').isDisabled(),true);await page.locator('#ap-retry-launch').click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();assert.deepEqual(calls.filter(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').at(-1).body,first,'The saved retry must keep the unresolved payload even if the fields were edited');await page.locator('[name=linkUrl]').fill('https://different.example/');await page.getByRole('button',{name:'Второй',exact:true}).click();await page.getByRole('button',{name:'Первый',exact:true}).click();
 assert.equal(await page.locator('[name=linkUrl]').inputValue(),first.links[0].url,'Unresolved request must win over a later in-memory draft');await page.reload();await loaded(page,'Первый');await page.locator('#ap-retry-launch').click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();assert.deepEqual(calls.filter(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').at(-1).body,first);
});

test('blocked browser storage is reported honestly while the in-memory draft stays usable',browserOptions,async t=>{
 const {page}=await workspace(t,{storageBlocked:true});await page.locator('[name=linkUrl]').fill('https://draft.example/');await page.locator('[name=linkAnchor]').fill('В памяти');
 assert.match(await page.locator('#ap-draft-state').textContent(),/не збереж|недоступ/i);await page.getByRole('button',{name:'Второй',exact:true}).click();await page.getByRole('button',{name:'Первый',exact:true}).click();assert.equal(await page.locator('[name=linkAnchor]').inputValue(),'В памяти');
});

test('confirmed replacement polls the write and its follow-up verification until the new result is visible',browserOptions,async t=>{
 const {page,fixture}=await workspace(t,{replacement:true});fixture.pages=[{id:'page1',projectId:'p1',revision:4,title:'Страница',fullUrl:'https://published.example/page/',verification:{state:'ok',summary:'Старая проверка',checkedAt:'2026-10-15T12:00:00Z'}}];await page.getByRole('button',{name:'Первый',exact:true}).click();
 await page.getByRole('button',{name:'Замінити посилання',exact:true}).click();await page.locator('[name=replacementSelected]').check();await page.locator('[name=replacementUrl]').fill('https://new.example/?x=%2F');await page.getByRole('button',{name:'Показати зміни',exact:true}).click();await page.getByRole('button',{name:'Підтвердити заміну',exact:true}).click();
 await page.getByText('Новая проверка: ссылка недоступна',{exact:true}).waitFor({timeout:12000});assert.ok(fixture.jobReads>=3,'Poll must continue through the generated page_check job');
});


test('replacement polling retries a failed final snapshot after all server jobs have completed',browserOptions,async t=>{
 const {page,fixture}=await workspace(t,{replacement:true,failFinalSnapshot:true});fixture.pages=[{id:'page1',projectId:'p1',revision:4,title:'Страница',fullUrl:'https://published.example/page/',verification:{state:'ok',summary:'Старая проверка',checkedAt:'2026-10-15T12:00:00Z'}}];await page.getByRole('button',{name:'Первый',exact:true}).click();
 await page.getByRole('button',{name:'Замінити посилання',exact:true}).click();await page.locator('[name=replacementSelected]').check();await page.locator('[name=replacementUrl]').fill('https://new.example/?x=%2F');await page.getByRole('button',{name:'Показати зміни',exact:true}).click();await page.getByRole('button',{name:'Підтвердити заміну',exact:true}).click();
 await page.getByText('Новая проверка: ссылка недоступна',{exact:true}).waitFor({timeout:15000});assert.equal(fixture.snapshotFailed,true,'Fixture must fail the first completed-job snapshot');assert.ok(fixture.jobReads>=4,'An unsuccessful final snapshot must retain the polling state for retry');
});

test('saved retry bypasses invalid edited AI fields and keeps the original pending payload',browserOptions,async t=>{
 const {page,calls}=await workspace(t,{failedLaunch:true}),retry=page.locator('#ap-retry-launch');assert.equal(await retry.isVisible(),false);
 await page.locator('[name=linkUrl]').fill('https://pending.example/?x=%2F');await page.locator('[name=linkAnchor]').fill('  Pending  ');await page.locator('#ap-launch').click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();
 const first=calls.find(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').body;await page.locator('[name=linkUrl]').fill('broken');await page.locator('[name=linkAnchor]').fill('');
 assert.equal(await page.locator('#ap-launch-form').evaluate(form=>form.checkValidity()),false);assert.equal(await retry.isVisible(),true,'An unresolved request must expose a separate saved-request retry');assert.equal(await retry.getAttribute('type'),'button');assert.equal(await retry.isEnabled(),true);
 await retry.click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();assert.deepEqual(calls.filter(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').at(-1).body,first);assert.equal(await page.locator('[name=linkUrl]').inputValue(),first.links[0].url);
 await page.getByLabel('Готовий HTML',{exact:true}).check();assert.equal(await retry.isVisible(),false);await page.getByLabel('ШІ за посиланнями й анкорами',{exact:true}).check();assert.equal(await retry.isVisible(),true);await page.getByRole('button',{name:'Второй',exact:true}).click();assert.equal(await retry.isVisible(),false);
});

test('saved retry restores reviewed HTML after edits without a new preview, review token, or launch identity',browserOptions,async t=>{
 const {page,calls}=await workspace(t,{failedLaunch:true}),retry=page.locator('#ap-retry-launch'),html='<html><body><h1>Принятый материал</h1><p>  Точный текст  </p></body></html>';
 await page.getByLabel('Готовий HTML',{exact:true}).check();await page.locator('[name=customerHtml]').fill(html);await page.getByLabel('Лише перекрити хедер і футер сайту',{exact:true}).check();await page.locator('#ap-launch').click();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал',exact:true}).waitFor();await page.locator('[name=acceptHtmlChanges]').check();
 await page.locator('#ap-stage-publish').click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();const first=calls.find(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST').body;
 await page.locator('[name=customerHtml]').fill('<h1>Непросмотренное изменение</h1>');assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);assert.equal(await retry.isVisible(),true,'Edited HTML must not make a saved reviewed request impossible to retry');assert.equal(await retry.isEnabled(),true);
 await retry.click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();const launches=calls.filter(c=>c.endpoint==='/projects/p1/autopilot'&&c.method==='POST');assert.equal(launches.length,2);assert.deepEqual(launches[1].body,first);assert.equal(await page.locator('[name=customerHtml]').inputValue(),html);assert.equal(calls.filter(c=>c.endpoint==='/autopilot/preview').length,1,'Retry uses the accepted HTML review');
});

