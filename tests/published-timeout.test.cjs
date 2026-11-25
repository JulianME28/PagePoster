'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mod=import('../server/lifecycle/browser-check.mjs'),snapshots=import('../server/lifecycle/published-snapshot.mjs');
const executablePath=require('./browser-runtime.cjs').chromePath,url='https://site.example/page/';
const html='<div id="pp-landing"><h1>Prepared page</h1><p>Readable content.</p></div>';
const response=(address,text,type='text/html')=>({status:200,url:address,headers:{'content-type':type},text});
const delay=(ms,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(Object.assign(Error('fixture cancellation'),{code:'network_timeout'}));}if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
function browserFixture({launchMs=0,stallContext=false}={}){
 let launches=0,closed=0;
 const chromium={launch:async()=>{launches++;await delay(launchMs);return {version:()=> 'fixture',close:async()=>{closed++;},newContext:async()=>{
  if(stallContext)return new Promise(()=>{});
  const locator={first(){return this;},count:async()=>0};
  const page={setDefaultTimeout(){},goto:async()=>{},locator:()=>locator,evaluate:async fn=>fn.name==='snapshot'?{markerCount:1,markerVisible:true,headings:[{visible:true}],externalLinks:[],invalidControls:[],navigation:[],overflow:[],scrollWidth:1440,viewportWidth:1440}:fn.toString().includes('data-pp-mounted')?false:true};
  return {addInitScript:async()=>{},route:async()=>{},routeWebSocket:async()=>{},newPage:async()=>page,close:async()=>{}};
 }};}};
 return {chromium,get launches(){return launches;},get closed(){return closed;}};
}
test('asset preparation cannot spend the separate Chromium phase budget',async()=>{
 const published='<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">'+html,driver=browserFixture({launchMs:700});
 const transport=async(address,init)=>{if(address===url)return response(address,published);await delay(650,init.signal);return response(address,'#pp-landing{color:#17202a}','text/css');};
 const result=await(await mod).createBrowserVerifier({chromium:driver.chromium,executablePath,timeoutMs:1000,transport}).verifyPublished({url,expectedHtml:published,expectedUrls:[]});
 assert.equal(result.state,'ok',JSON.stringify(result));assert.equal(driver.launches,1);
 assert.equal(result.progress.stage,'cleanup');assert.equal(result.progress.budgetMs,1000);assert.equal(result.network.fetchedAssets,2);
});
test('asset HTTP reads are bounded at four while CSS imports and cascade retain source order',async()=>{
 const published='<link rel="stylesheet" href="/first.css"><link rel="stylesheet" href="/second.css"><style>.inline{color:green}</style>'+html+Array.from({length:6},(_,i)=>'<img src="/image'+i+'.png">').join('');
 let active=0,peak=0;
 const transport=async(address,init)=>{active++;peak=Math.max(peak,active);try{await delay(address.endsWith('first.css')?80:20,init.signal);if(address.endsWith('first.css'))return response(address,'@import url("/import.css");.first{color:red}','text/css');if(address.endsWith('second.css'))return response(address,'.second{color:blue}','text/css');if(address.endsWith('import.css'))return response(address,'.imported{color:black}','text/css');return {...response(address,'','image/png'),body:Buffer.from([1])};}finally{active--;}};
 const prepared=await(await snapshots).preparePublished(response(url,published),transport);
 assert.equal(peak,4);assert.equal(prepared.network.fetchedAssets,9);assert.equal(prepared.network.failedAssets,0);
 assert.ok(prepared.html.indexOf('.imported{')<prepared.html.indexOf('.first{'));
 assert.ok(prepared.html.indexOf('.first{')<prepared.html.indexOf('.second{'));
 assert.ok(prepared.html.indexOf('.second{')<prepared.html.indexOf('.inline{'));
});
test('concurrent asset admission preserves the eighty-URL cap and shared response cache',async()=>{
 const published=html+Array.from({length:100},(_,i)=>'<img src="/image'+i+'.png">').join('')+'<img src="/image0.png">';let reads=0,active=0,peak=0;
 const prepared=await(await snapshots).preparePublished(response(url,published),async(address,init)=>{reads++;active++;peak=Math.max(peak,active);try{await delay(2,init.signal);return {...response(address,'','image/png'),body:Buffer.from([1])};}finally{active--;}});
 assert.equal(reads,80);assert.ok(peak<=4);assert.equal(prepared.network.fetchedAssets,80);assert.equal(prepared.network.blockedAssets,20);
});
test('parallel reads retain the combined eight-MiB content and asset limit',async()=>{
 const published=html+Array.from({length:9},(_,i)=>'<img src="/large'+i+'.png">').join(''),body=Buffer.alloc(1024*1024);
 const prepared=await(await snapshots).preparePublished(response(url,published),async address=>({...response(address,'','image/png'),body}));
 assert.equal(prepared.network.fetchedAssets,7);assert.equal(prepared.network.failedAssets,2);
 assert.equal((prepared.html.match(/data:image\/png;base64,/g)||[]).length,7);
});
test('bounded preparation reports safe read timeout progress without starting Chromium',async()=>{
 const driver=browserFixture(),transport=async(_address,init)=>{await delay(1500,init.signal);return response(url,html);};
 const result=await(await mod).createBrowserVerifier({chromium:driver.chromium,executablePath,timeoutMs:1000,preparationTimeoutMs:1000,transport}).verifyPublished({url,expectedHtml:html,expectedUrls:[],compareVisual:true});
 assert.equal(result.code,'public_read_timeout');assert.equal(result.state,'unknown');assert.equal(result.visual.state,'unknown');assert.equal(driver.launches,0);
 assert.deepEqual(Object.keys(result.progress).sort(),['budgetMs','elapsedMs','stage']);assert.equal(result.progress.stage,'public_read');assert.equal(result.progress.budgetMs,1000);assert.ok(result.progress.elapsedMs>=900&&result.progress.elapsedMs<=1600);
});
test('bounded asset preparation cancels queued reads and retains partial safe counts',async()=>{
 const published=Array.from({length:9},(_,i)=>'<link rel="stylesheet" href="/style'+i+'.css">').join('')+html,driver=browserFixture();let reads=0;
 const transport=async(address,init)=>{if(address===url)return response(address,published);reads++;await delay(1500,init.signal);return response(address,'.ready{color:black}','text/css');};
 const result=await(await mod).createBrowserVerifier({chromium:driver.chromium,executablePath,timeoutMs:1000,preparationTimeoutMs:1000,transport}).verifyPublished({url,expectedHtml:published,expectedUrls:[],compareVisual:true});
 assert.equal(result.code,'public_assets_timeout');assert.equal(result.progress.stage,'public_assets');assert.equal(result.visual.state,'unknown');assert.equal(driver.launches,0);assert.equal(reads,4);assert.equal(result.network.fetchedAssets,0);
 await delay(10);assert.equal(reads,4,'Cancelled queued resources must not reach transport');
});
test('a stalled Chromium phase still has its own deadline and safe progress',async()=>{
 const driver=browserFixture({stallContext:true});
 const result=await(await mod).createBrowserVerifier({chromium:driver.chromium,executablePath,timeoutMs:1000,transport:async()=>response(url,html)}).verifyPublished({url,expectedHtml:html,expectedUrls:[]});
 assert.equal(result.code,'browser_timeout');assert.equal(result.progress.stage,'public_render');assert.equal(result.progress.budgetMs,1000);assert.ok(driver.closed>0);
});
