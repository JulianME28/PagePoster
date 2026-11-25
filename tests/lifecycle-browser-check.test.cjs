'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const mod=import('../server/lifecycle/browser-check.mjs');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const URL='https://offers.example/go?a=%2F&b=2#part';
const html='<style>body{margin:0}#pp-landing{max-width:980px;margin:auto;padding:18px;box-sizing:border-box}a,button{display:inline-block;padding:12px}#details{margin-top:1000px}img{max-width:100%}</style><div id="pp-landing"><h1>Example</h1><nav><a href="#details">Details</a></nav><a class="pp-cta" href="https://offers.example/go?a=%2F&amp;b=2#part">View offer</a><button data-pp-url="https://offers.example/go?a=%2F&amp;b=2#part">View again</button><details class="pp-mobile-nav"><summary>Menu</summary><a href="#details">Details</a></details><section id="details"><h2>Details</h2></section></div>';
const verify=async input=>(await mod).createBrowserVerifier({chromium,executablePath}).verifyGenerated({html,expectedUrls:[URL],...input});
test('live browser verification refuses user URLs instead of treating DNS prechecks as Chromium isolation',async()=>{
 const {createBrowserVerifier}=await mod;let launched=0;
 const result=await createBrowserVerifier({chromium:{launch(){launched++;throw Error('must not launch');}}}).verifyPublished({url:'https://site.example/page/'});
 assert.equal(result.state,'unknown');assert.equal(result.code,'isolated_browser_unavailable');assert.equal(launched,0);
});
test('malformed or oversized HTML and unsafe artifact destinations are rejected before browser launch',async()=>{
 const {createBrowserVerifier}=await mod;let launched=0;const checker=createBrowserVerifier({chromium:{launch(){launched++;throw Error('must not launch');}}});
 for(const input of [{html:''},{html:'x'.repeat(1000001)},{html,expectedUrls:['javascript:alert(1)']},{html,artifactDir:'../artifacts'}]){
  await assert.rejects(checker.verifyGenerated(input),{code:'browser_validation'});
 }
 assert.equal(launched,0);
});
test('real desktop and mobile DOM preserve exact unique URLs and report script-driven controls as unverified',async()=>{
 const result=await verify({});
 assert.equal(result.scope,'offline-generated-html');assert.equal(result.layoutState,'ok');assert.equal(result.runtime.state,'unknown');assert.equal(result.publicPage.state,'unknown');
 assert.deepEqual(result.viewports.map(x=>[x.name,x.width]),[['desktop',1440],['mobile',390]]);
 for(const view of result.viewports){
  assert.equal(view.checks.find(c=>c.kind==='links').state,'ok');
  assert.equal(view.checks.find(c=>c.kind==='navigation').state,'ok');
  assert.equal(view.snapshot.externalLinks[0].url,URL);
  assert.equal(view.snapshot.externalLinks[0].nativeCount,1);
  assert.equal(view.snapshot.externalLinks[0].controlCount,2);
  assert.equal(view.snapshot.headings[0].text,'Example');
 }
});
test('real layout finds mobile horizontal overflow independently of desktop width',async()=>{
 const result=await verify({html:html.replace('<h1>','<div style="width:1100px;height:20px">Wide content</div><h1>')});
 assert.equal(result.layoutState,'problem');
 assert.equal(result.viewports[0].checks.find(c=>c.kind==='overflow').state,'ok');
 assert.equal(result.viewports[1].checks.find(c=>c.kind==='overflow').state,'problem');
});
test('customer tables inside a viewport-sized horizontal scroller do not count as page overflow',async()=>{
 const result=await verify({html:html.replace('<h1>','<div class="customer-table" style="max-width:100%;overflow-x:auto"><table style="width:560px"><tr><td>First</td><td>Second</td></tr></table></div><h1>')});
 const mobile=result.viewports.find(v=>v.name==='mobile');assert.equal(mobile.snapshot.scrollWidth,390);assert.equal(mobile.checks.find(c=>c.kind==='overflow').state,'ok');assert.deepEqual(mobile.snapshot.overflow,[]);
});
test('an oversized horizontal scroller still fails the mobile page-width check',async()=>{
 const result=await verify({html:html.replace('<h1>','<div style="width:900px;overflow-x:auto"><table style="width:1100px"><tr><td>Wide</td></tr></table></div><h1>')});assert.equal(result.viewports.find(v=>v.name==='mobile').checks.find(c=>c.kind==='overflow').state,'problem');
});
test('duplicate native addresses and broken hash targets cannot pass supported browser checks',async()=>{
 const result=await verify({html:html.replace('</div>','<a href="https://offers.example/go?a=%2F&amp;b=2#part">Duplicate</a><a href="#missing">Broken</a></div>')});
 assert.equal(result.layoutState,'problem');
 for(const view of result.viewports){
  assert.equal(view.checks.find(c=>c.kind==='links').state,'problem');
  assert.equal(view.checks.find(c=>c.kind==='navigation').state,'problem');
 }
});

test('editorial browser verification expects separate content and chrome groups, not arbitrary duplicates',async()=>{
 const editorial=html.replace('id="pp-landing"','id="pp-landing" class="pp-editorial-v2"').replace('<h1>','<header><a href="'+URL.replace(/&/g,'&amp;')+'">Brand</a></header><h1>');
 const result=await verify({html:editorial});
 assert.ok(result.viewports.every(v=>v.checks.find(c=>c.kind==='links').state==='ok'));
 const broken=await verify({html:editorial.replace('</header>','<a href="'+URL.replace(/&/g,'&amp;')+'">Extra</a></header>')});
 assert.ok(broken.viewports.every(v=>v.checks.find(c=>c.kind==='links').state==='problem'));
});
test('offline context makes no network connections from scripts frames refresh styles images or event handlers',async t=>{
 let requests=0;const server=http.createServer((req,res)=>{requests++;res.end('unexpected');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const local='http://127.0.0.1:'+server.address().port+'/probe';
 const source='<meta http-equiv="refresh" content="0;url='+local+'"><base href="'+local+'"><iframe src="'+local+'"></iframe><style>@import url("'+local+'");</style><script>fetch("'+local+'");window.__pwned=true</script>'+html.replace('<h1>','<img src="'+local+'" onerror="fetch(\''+local+'\')"><h1>');
 const result=await verify({html:source});
 assert.equal(requests,0);
 assert.ok(result.sanitized.removedActiveElements>=4);
 assert.equal(result.viewports[0].snapshot.scriptCount,0);
 assert.equal(result.runtime.state,'unknown');
});
test('screenshots are viewport-bounded PNG files generated only inside the chosen artifact directory',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const result=await verify({artifactDir:dir});
 for(const view of result.viewports){
  const relative=path.relative(fs.realpathSync.native(dir),fs.realpathSync.native(view.screenshot.path));
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const bytes=fs.readFileSync(view.screenshot.path);assert.equal(bytes.subarray(1,4).toString(),'PNG');
  assert.equal(bytes.readUInt32BE(16),view.width);assert.equal(bytes.readUInt32BE(20),view.height);
 }
});

test('stalled browser context cannot hold the verifier indefinitely',{timeout:3000},async()=>{
 const {createBrowserVerifier}=await mod;
 const checker=createBrowserVerifier({chromium:{launch:async()=>({newContext:()=>new Promise(()=>{}),close:async()=>{}})},executablePath,timeoutMs:1000});
 const result=await checker.verifyGenerated({html,expectedUrls:[URL]});
 assert.equal(result.state,'unknown');assert.equal(result.code,'browser_timeout');
});
test('destinations that exist only in invisible controls do not pass the CTA check',async()=>{
 const result=await verify({html:html+'<style>a,button{display:none!important}</style>'});
 assert.equal(result.layoutState,'problem');
 for(const view of result.viewports)assert.equal(view.checks.find(c=>c.kind==='cta_targets').state,'problem');
});
