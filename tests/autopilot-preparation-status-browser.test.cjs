'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
const options={timeout:25000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
const run=(state='running',extra={})=>({id:'run1',projectId:'p1',source:'ai',state,stage:'generating',hasHtml:false,reviewBeforePublish:true,title:'Нова сторінка',updatedAt:'2026-10-16T11:43:25Z',...extra});
const denied=()=>run('failed',{error:{code:'AI_ACCESS_DENIED',message:'Цей ключ не має доступу до вибраної моделі.'}});
async function workspace(t,runs=[]){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),calls=[],errors=[],fixture={runs};
 const server=http.createServer((req,res)=>{const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();calls.push({endpoint,method,body});let data;
  if(endpoint==='/projects')data={projects:[{id:'p1',name:'Проект'}]};
  else if(endpoint==='/autopilot/status')data={aiConfigured:true,source:{configured:false}};
  else if(endpoint==='/projects/p1/jobs')data={jobs:[]};
  else if(endpoint==='/projects/p1/pages'||endpoint==='/projects/p1/overview')data={pages:[]};
  else if(endpoint==='/projects/p1/autopilot'&&method==='GET')data={runs:fixture.runs};
  else if(endpoint==='/projects/p1/autopilot'&&method==='POST'){fixture.runs=[run()];data={run:fixture.runs[0]};}
  else if(endpoint==='/autopilot/run1/resume'){fixture.runs=[run('queued')];data={run:fixture.runs[0]};}
  else if(endpoint==='/autopilot/saved/html')data={html:'<h1>Сохранённый вариант</h1>',reviewToken:'saved-review'};
  else if(endpoint==='/autopilot/preview')data={html:'<h1>Мой HTML</h1>',title:'Мой HTML',reviewToken:'draft-review',warnings:[]};
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/autopilot.html');await page.getByRole('heading',{name:'Проект',exact:true}).waitFor();await page.locator('#ap-results[aria-busy]').waitFor({state:'detached'});return {page,calls,fixture};
}
const writes=calls=>calls.filter(call=>call.method==='POST');

test('failed OpenAI preparation stops the stage spinner and offers connections without another paid request',options,async t=>{
 const {page,calls,fixture}=await workspace(t),url='https://offer.example/?ref=%2F',anchor='  Точный анкор  ';
 await page.locator('[name=linkUrl]').fill(url);await page.locator('[name=linkAnchor]').fill(anchor);await page.locator('#ap-launch').click();await page.locator('[data-run-id="run1"][data-state="running"]').waitFor();fixture.runs=[denied()];await page.locator('[data-run-id="run1"][data-state="failed"]').waitFor();
 assert.notEqual(await page.locator('#ap-stage').getAttribute('data-status'),'loading','A terminal server failure must end preparation in the stage');assert.match(await page.locator('#ap-stage-empty-copy').textContent(),/OpenAI.*403/);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);assert.equal(await page.locator('#ap-stage-frame').isVisible(),false);
 await page.locator('#ap-stage-settings').click();await page.locator('#ap-settings[open]').waitFor();assert.equal(await page.locator('[name=apiKey]').evaluate(node=>node===document.activeElement),true);assert.equal(writes(calls).length,1,'Showing the failure and opening connections must not retry generation');assert.equal(await page.locator('[name=linkUrl]').inputValue(),url);assert.equal(await page.locator('[name=linkAnchor]').inputValue(),anchor);
});

test('reload presents the latest failed preparation with a connections action instead of an empty prompt',options,async t=>{
 const {page,calls}=await workspace(t,[denied()]);assert.match(await page.locator('#ap-stage-empty-copy').textContent(),/OpenAI.*403/);assert.equal(await page.locator('#ap-stage').getAttribute('data-status'),'error');assert.equal(await page.locator('#ap-stage-settings').isVisible(),true);
 await page.locator('[data-run-id="run1"]').getByRole('button',{name:'Перевірити підключення OpenAI',exact:true}).click();await page.locator('#ap-settings[open]').waitFor();assert.deepEqual(writes(calls),[]);
});

test('a failed run does not replace an awaiting-review snapshot or grant publication to the failed run',options,async t=>{
 const saved=run('awaiting_review',{id:'saved',stage:'selecting',hasHtml:true,title:'Сохранённый вариант',updatedAt:'2026-10-16T11:40:00Z'}),{page,calls}=await workspace(t,[denied(),saved]);
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Сохранённый вариант',exact:true}).waitFor();assert.equal(await page.locator('#ap-stage').getAttribute('data-status'),'ready');assert.equal(await page.locator('#ap-stage-publish').isEnabled(),true);assert.deepEqual(writes(calls),[]);
});

test('a background generation failure preserves a newly reviewed HTML draft',options,async t=>{
 const {page,calls,fixture}=await workspace(t,[run()]);await page.getByLabel('Готовий HTML',{exact:true}).check();await page.locator('[name=customerHtml]').fill('<h1>Мой HTML</h1>');await page.locator('#ap-launch').click();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Мой HTML',exact:true}).waitFor();fixture.runs=[denied()];await page.locator('[data-run-id="run1"][data-state="failed"]').waitFor();
 assert.equal(await page.locator('#ap-stage').getAttribute('data-status'),'ready');assert.equal(await page.locator('#ap-stage-publish').isEnabled(),true);assert.equal(await page.locator('[name=customerHtml]').inputValue(),'<h1>Мой HTML</h1>');assert.equal(writes(calls).filter(call=>call.endpoint!=='/autopilot/preview').length,0);
});

test('explicit resume tracks the same preparation until it stops again without creating another launch',options,async t=>{
 const {page,calls,fixture}=await workspace(t,[denied()]);await page.locator('[data-run-id="run1"]').getByRole('button',{name:'Продовжити зі збереженого кроку',exact:true}).click();await page.locator('[data-run-id="run1"][data-state="queued"]').waitFor();assert.equal(await page.locator('#ap-stage').getAttribute('data-status'),'loading');fixture.runs=[denied()];await page.locator('[data-run-id="run1"][data-state="failed"]').waitFor();assert.equal(await page.locator('#ap-stage').getAttribute('data-status'),'error');assert.deepEqual(writes(calls).map(call=>call.endpoint),['/autopilot/run1/resume']);
});


test('output format failures show the exact safe field and never claim the page was saved',options,async t=>{
 const failure=run('failed',{error:{code:'AI_OUTPUT_INVALID',issues:[{code:'AI_TEXT_INVALID',fieldPath:'sections.2.body'}],message:'ИИ вернул слишком короткий текст. Поле: sections.2.body. Сторінку не підготовлено; посилання й анкори збережено.'}});
 const {page,calls}=await workspace(t,[failure]);
 assert.match(await page.locator('#ap-stage-empty-copy').textContent(),/sections\.2\.body/);
 assert.doesNotMatch(await page.locator('#ap-stage-empty-copy').textContent(),/Готові результати збережено/);
 assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);assert.deepEqual(writes(calls),[]);
});
test('old generic output errors are explained without pretending the failed page is saved',options,async t=>{
 const {page}=await workspace(t,[run('failed',{error:{code:'AI_OUTPUT_INVALID',message:'Не вдалося завершити крок. Готові результати збережено. Код: AI_OUTPUT_INVALID'}})]);
 const text=await page.locator('#ap-stage-empty-copy').textContent();assert.match(text,/Сторінку не підготовлено/);assert.doesNotMatch(text,/Готові результати збережено/);
});
