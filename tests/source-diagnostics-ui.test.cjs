'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('./browser-runtime.cjs').playwright;

// Fails if the visible shortage conflates input rows, unique donors and ownership.
test('queue shortage explains source row failures and distinct unavailable donor reasons without writes',async t=>{
 const browser=await chromium.launch({executablePath:require('./browser-runtime.cjs').chromePath,headless:true,args:['--disable-background-networking']}),page=await browser.newPage({viewport:{width:1440,height:900}}),dist=path.resolve(__dirname,'../dist'),errors=[];let posts=0;
 t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);});page.on('pageerror',error=>errors.push(error.message));
 const diagnostics={criteria:{minDr:20,minTraffic:50,geo:'SK'},total:8,geo:5,dr:4,eligible:3,reserved:3,available:0,
  input:{unit:'rows',nonempty:12,disabled:1,invalidUrl:1,invalidRow:1,missingCredentials:2,privateValue:'PRIVATE_DIAGNOSTIC'},
  unknown:{unit:'origins',dr:1,traffic:2,geo:3},unavailable:{unit:'origins',published:1,reserved:1,excluded:1,other:0}};
 const item={id:'modern',runId:'run-modern',pageId:'page-modern',key:'modern',title:'Exact source shortage',source:'html',language:'sk',geo:'SK',state:'needs_attention',stage:'selecting',canApprove:false,canSetDestination:false,error:{code:'SOURCE_EMPTY',message:'Потрібен інший донор.'},selectionDiagnostics:diagnostics};
 const {input,unknown,unavailable,...legacyDiagnostics}=diagnostics;
 const overview={projects:[{projectId:'p1',name:'Diagnostics',type:'html',counts:{total:2,attention:2},items:[item,{...item,id:'legacy',runId:'run-legacy',title:'Legacy shortage',selectionDiagnostics:legacyDiagnostics}]}],generation:{active:0,waiting:0},publication:{active:0,waiting:0}};
 await page.route('**/*',route=>{
  const request=route.request(),u=new URL(request.url());if(request.method()==='POST')posts++;
  if(u.origin!=='http://workspace.example')return route.abort();
  if(u.pathname.startsWith('/api/')){const endpoint=u.pathname.replace('/api/lifecycle','');let data={projects:[],runs:[],pages:[],jobs:[],source:{configured:false}};
   if(endpoint==='/projects')data={projects:[{id:'p1',name:'Diagnostics',workflowType:'html'}]};else if(endpoint==='/project-queue')data=overview;
   return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  }
  const file=path.join(dist,u.pathname==='/'?'autopilot.html':u.pathname);return fs.existsSync(file)?route.fulfill({contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)}):route.fulfill({status:404,body:''});
 });
 await page.goto('http://workspace.example/');await page.locator('#pq-dashboard-open').click();
 const row=page.locator('[data-queue-item="modern"]');await row.waitFor();const text=await row.textContent();
 assert.match(text,/Унікальні донори: 8/);assert.match(text,/Непорожні рядки джерела: 12/);
 assert.match(text,/вимкнено: 1/);assert.match(text,/некоректний URL: 1/);assert.match(text,/пошкоджені рядки: 1/);assert.match(text,/без даних для входу: 2/);
 assert.match(text,/уже опубліковано: 1/);assert.match(text,/зарезервовано: 1/);assert.match(text,/історичні відмови: 1/);assert.match(text,/інші причини: 0/);
 assert.match(text,/Невідомі метрики \(унікальні донори\): DR: 1; трафік: 2; гео: 3/);assert.doesNotMatch(text,/PRIVATE_DIAGNOSTIC/);
 const legacy=await page.locator('[data-queue-item="legacy"]').textContent();assert.match(legacy,/за гео: 5/i);assert.match(legacy,/вільно: 0/);assert.doesNotMatch(legacy,/Непорожні рядки|Невідомі метрики|уже опубліковано/);assert.equal(posts,0);
});
