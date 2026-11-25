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

test('card count and extended language persist and submit exact repeated pairs',options,async t=>{
 const {page,calls}=await workspace(t);
 await page.locator('[name=linkUrl]').fill('https://a.example/?keep=%2F');await page.locator('[name=linkAnchor]').fill('Exact label');
 await page.locator('#ap-card-count').fill('10');await page.locator('#ap-editorial-language').selectOption('nl');
 await page.reload();await page.locator('#ap-card-count').waitFor();assert.equal(await page.locator('#ap-card-count').inputValue(),'10');
 assert.equal(await page.locator('#ap-editorial-language').inputValue(),'nl');await page.locator('#ap-launch').click();await page.locator('[data-run-id="run1"]').waitFor();
 const sent=writes(calls).find(call=>call.endpoint==='/projects/p1/autopilot').body;assert.equal(sent.links.length,10);assert.equal(sent.editorial.language,'nl');
 assert.ok(sent.links.every(pair=>pair.url==='https://a.example/?keep=%2F'&&pair.anchor==='Exact label'));
});

test('editorial custom brief persists on reload and is submitted exactly; HTML mode ignores hidden required topic',options,async t=>{
 const {page,calls}=await workspace(t);
 await page.locator('[name=linkUrl]').fill('https://example.org/?keep=%2F');await page.locator('[name=linkAnchor]').fill('opaque123');
 await page.locator('#ap-editorial-language').selectOption('pl');await page.locator('#ap-editorial-format').selectOption('discussion');await page.locator('#ap-editorial-topic').selectOption('custom');
 await page.locator('#ap-editorial-custom').fill('Cash games versus tournaments');
 await page.reload();await page.locator('#ap-editorial-custom').waitFor();
 assert.equal(await page.locator('#ap-editorial-language').inputValue(),'pl');assert.equal(await page.locator('#ap-editorial-format').inputValue(),'discussion');assert.equal(await page.locator('#ap-editorial-custom').inputValue(),'Cash games versus tournaments');
 await page.locator('#ap-editorial-custom').fill('');await page.locator('#ap-launch').click();assert.equal(writes(calls).length,0);
 await page.getByLabel('Готовий HTML',{exact:true}).check();await page.locator('[name=customerHtml]').fill('<h1>Existing HTML</h1>');await page.locator('#ap-launch').click();
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Мой HTML',exact:true}).waitFor();
 assert.equal(writes(calls).filter(c=>c.endpoint==='/autopilot/preview').length,1);
 await page.getByLabel('ШІ за посиланнями й анкорами',{exact:true}).check();
 await page.locator('#ap-editorial-custom').fill('Cash games versus tournaments');await page.locator('#ap-launch').click();
 await page.locator('[data-run-id="run1"]').waitFor();
 const sent=writes(calls).find(c=>c.endpoint==='/projects/p1/autopilot').body;
 assert.deepEqual(sent.editorial,{language:'pl',format:'discussion',topic:'custom',customTopic:'Cash games versus tournaments'});assert.equal(sent.reviewBeforePublish,true);
 assert.equal(sent.links[0].url,'https://example.org/?keep=%2F');
});
