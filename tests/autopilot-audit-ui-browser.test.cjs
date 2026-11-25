'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
const browserOptions={timeout:25000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
async function workspace(t,options={}){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),calls=[],errors=[];
 const fixture={jobs:[],done:false,resumed:false,failedSnapshot:false,jobReads:0,launches:0};
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html',file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 if(options.storageFailure)await context.addInitScript(kind=>{const original=Storage.prototype[kind];Storage.prototype[kind]=function(name,...args){if(window.blockPendingStorage!==false&&name.startsWith('pageposter-autopilot-launch:'))throw new DOMException('Pending storage unavailable',kind==='getItem'?'SecurityError':'QuotaExceededError');return original.call(this,name,...args);};},options.storageFailure);
 if(options.holdFile)await context.addInitScript(()=>{const original=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){if(window.releaseAuditFile)return original.call(this);const pending=new Promise(resolve=>window.releaseAuditFile=()=>resolve(new TextEncoder().encode('<h1>OLDER FILE</h1>').buffer));return pending;};});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();calls.push({endpoint,method,body});let data;
  if(endpoint==='/projects')data={projects:[{id:'p1',name:'Первый',revision:1},{id:'p2',name:'Второй',revision:1}]};
  else if(endpoint==='/autopilot/status')data={source:{configured:true},aiConfigured:true};
  else if(/^\/projects\/p[12]\/jobs$/.test(endpoint)){
   fixture.jobReads++;
   if(options.failJobRead&&!fixture.failedJobRead){fixture.failedJobRead=true;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Временная ошибка чтения задач"}'});}
   data={jobs:fixture.jobs.filter(job=>job.projectId===endpoint.split('/')[2]).map(job=>({...job,state:fixture.done?'completed':job.state}))};
  }
  else if(endpoint==='/projects/p1/pages'){
   if((options.resume&&fixture.resumed||options.failFinalSnapshot&&fixture.done)&&!fixture.failedSnapshot){fixture.failedSnapshot=true;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Временная ошибка снимка"}'});}
   data={pages:options.published?[{id:'page1',projectId:'p1',title:'Страница',fullUrl:'https://published.example/page/',verification:{state:fixture.done?'problem':'ok',summary:fixture.done?'Новая проверка: ссылка недоступна':'Предыдущая проверка'}}]:[]};
  }
  else if(/^\/projects\/p[12]\/(?:pages|overview)$/.test(endpoint))data={pages:[],incidents:[]};
  else if(/^\/projects\/p[12]\/autopilot$/.test(endpoint)&&method==='GET')data={runs:options.resume&&endpoint.includes('/p1/')?[{id:'run1',projectId:'p1',state:fixture.resumed?'waiting_source':'failed',stage:'selecting',title:'Сохранённый запуск'}]:[]};
  else if(endpoint==='/autopilot/run1/resume'){fixture.resumed=true;data={run:{id:'run1',projectId:'p1',state:'queued',stage:'selecting',title:'Сохранённый запуск'}};}
  else if(endpoint==='/projects/p1/autopilot'&&method==='POST'){fixture.launches++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Ответ сервера потерян"}'});}
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/autopilot.html');await page.getByRole('heading',{name:'Первый',exact:true}).waitFor();await page.locator('#ap-results[aria-busy]').waitFor({state:'detached'});
 return {page,calls,fixture};
}
const launches=calls=>calls.filter(call=>call.endpoint==='/projects/p1/autopilot'&&call.method==='POST');

for(const failure of ['setItem','getItem'])test('initial paid launch is blocked until pending '+failure+' storage succeeds',browserOptions,async t=>{
 const {page,calls}=await workspace(t,{storageFailure:failure});await page.locator('[name=linkUrl]').fill('https://pending.example/?x=%2F');await page.locator('[name=linkAnchor]').fill('  Точный анкор  ');await page.locator('#ap-launch').click();
 await page.waitForFunction(()=>document.getElementById('ap-notice').textContent.length>0&&!document.querySelector('[name=linkUrl]').disabled);
 assert.equal(launches(calls).length,0,'A launch without a durable retry identity must never reach the paid endpoint');assert.match(await page.locator('#ap-notice').textContent(),/збереж|сховищ/i);
 await page.evaluate(()=>window.blockPendingStorage=false);
 const retry=page.locator('#ap-retry-launch');await (await retry.isVisible()?retry:page.locator('#ap-launch')).click();await page.getByText('Ответ сервера потерян',{exact:true}).waitFor();
 assert.equal(launches(calls).length,1);assert.deepEqual(JSON.parse(await page.evaluate(()=>sessionStorage.getItem('pageposter-autopilot-launch:p1:ai'))),launches(calls)[0].body);
});

for(const type of ['page_check','replace'])test('reload rediscovers active '+type+' jobs and reads their completed page snapshot',browserOptions,async t=>{
 const {page,fixture}=await workspace(t,{published:true});fixture.jobs=[{id:'job1',projectId:'p1',pageId:'page1',type,state:'running'}];await page.reload();await page.getByText('Предыдущая проверка',{exact:true}).waitFor();fixture.done=true;
 await page.getByText('Новая проверка: ссылка недоступна',{exact:true}).waitFor();assert.ok(fixture.jobReads>=2,'Server jobs must be discovered and polled after reload');
});

test('reloaded job keeps polling after the completed page snapshot fails once',browserOptions,async t=>{
 const {page,fixture}=await workspace(t,{published:true,failFinalSnapshot:true});fixture.jobs=[{id:'job1',projectId:'p1',pageId:'page1',type:'page_check',state:'running'}];await page.reload();await page.getByText('Предыдущая проверка',{exact:true}).waitFor();fixture.done=true;
 await page.getByText('Новая проверка: ссылка недоступна',{exact:true}).waitFor({timeout:10000});assert.equal(fixture.failedSnapshot,true);
});

test('initial server job discovery recovers a transient read failure automatically',browserOptions,async t=>{
 const {page,fixture}=await workspace(t,{published:true,failJobRead:true});await page.getByText('Предыдущая проверка',{exact:true}).waitFor();assert.equal(fixture.failedJobRead,true);assert.ok(fixture.jobReads>=2,'Failed discovery must retry even before any active job is known');
});

test('accepted resume survives a failed refresh without resubmitting the operation',browserOptions,async t=>{
 const {page,calls,fixture}=await workspace(t,{resume:true});await page.getByRole('button',{name:'Продовжити зі збереженого кроку',exact:true}).click();await page.getByText('Временная ошибка снимка',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-id="run1"]').getAttribute('data-state'),'queued','The acknowledged server run must replace the stale failed card immediately');
 await page.locator('[data-run-id="run1"][data-state="waiting_source"]').waitFor();assert.equal(fixture.failedSnapshot,true);assert.equal(calls.filter(call=>call.endpoint==='/autopilot/run1/resume').length,1);
});

test('late HTML file completion preserves newer manual input and its persisted draft',browserOptions,async t=>{
 const {page}=await workspace(t,{holdFile:true});await page.getByLabel('Готовий HTML',{exact:true}).check();await page.locator('#ap-html-file').setInputFiles({name:'old.html',mimeType:'text/html',buffer:Buffer.from('<h1>OLDER FILE</h1>')});await page.waitForFunction(()=>typeof window.releaseAuditFile==='function');
 const newer='<h1>NEWER USER EDIT</h1>';await page.locator('[name=customerHtml]').fill(newer);await page.evaluate(async()=>{window.releaseAuditFile();await Promise.resolve();await Promise.resolve();});assert.equal(await page.locator('[name=customerHtml]').inputValue(),newer);assert.equal(JSON.parse(await page.evaluate(()=>sessionStorage.getItem('pageposter-autopilot-drafts:v1'))).drafts.find(([id])=>id==='p1')[1].html.html,newer);
 const current='<h1>CURRENT FILE</h1>';await page.locator('#ap-html-file').setInputFiles({name:'current.html',mimeType:'text/html',buffer:Buffer.from(current)});await page.waitForFunction(value=>document.querySelector('[name=customerHtml]').value===value,current);assert.equal(await page.locator('#ap-html-file').inputValue(),'','The current read applies once and clears the file control');
});

test('successful recovery stops polling and blocks application actions until restart',browserOptions,async t=>{
 const {page,calls}=await workspace(t,{resume:true});await page.getByRole('button',{name:'Продовжити зі збереженого кроку',exact:true}).click();await page.getByText('Временная ошибка снимка',{exact:true}).waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('pageposter:recovery-restored')));
 assert.equal(await page.locator('#ap-check-pages').isDisabled(),true);assert.equal(await page.locator('#ap-launch').isDisabled(),true);assert.match(await page.locator('#ap-notice').textContent(),/перезапуст/i);
 const count=calls.length;await page.waitForTimeout(3300);assert.equal(calls.length,count,'No lifecycle polling may continue with a restored database waiting for restart');
});
