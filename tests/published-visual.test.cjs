'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const runtime=require('../dist/page-runtime.js'),mod=import('../server/lifecycle/browser-check.mjs');
const path=require('node:path'),{spawnSync}=require('node:child_process');
const executablePath=require('./browser-runtime.cjs').chromePath,url='https://site.example/offer/';
const style='<style>body{margin:0}#pp-landing{box-sizing:border-box;width:100%;max-width:980px;margin:0 auto;padding:24px;background:#fff;color:#17202a;font-family:Arial,sans-serif;font-size:20px;line-height:1.5}#pp-landing h1{font-size:36px;line-height:1.2}#pp-landing h2{font-size:28px}#pp-landing p{margin:20px 0}</style>';
const body='<div id="pp-landing"><h1>Prepared page title</h1><p>The prepared page includes enough readable content to compare its typography and responsive layout in the published snapshot.</p><h2>Required details</h2><p>These details should remain readable and fit inside the content wrapper on desktop and mobile screens.</p></div>';
const html=style+body;
async function verify(published=html,options={},engine=chromium){
 const calls=[],transport=async(address,init)=>{calls.push({address,init});if(address!==url)throw Error('Fixture asset unavailable');return {status:200,url,headers:{'content-type':'text/html',...(options.headers||{})},text:published};};
 const result=await(await mod).createBrowserVerifier({chromium:engine,executablePath,transport,timeoutMs:20000}).verifyPublished({url,expectedHtml:html,expectedUrls:[],compareVisual:true,...options});
 return {result,calls};
}
test('published verification creates only desktop public and prepared-baseline contexts',async()=>{
 const contexts=[],engine={launch:async options=>{
  const browser=await chromium.launch(options);
  return new Proxy(browser,{get(target,key){if(key==='newContext')return async settings=>{contexts.push(settings.viewport);return target.newContext(settings);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 }};
 const {result,calls}=await verify(html,{},engine);
 assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
 assert.deepEqual(result.visual.viewports.map(v=>[v.name,v.state]),[['desktop','ok']]);
 assert.deepEqual(result.viewports.map(v=>[v.name,v.width,v.height]),[['desktop',1440,900]]);
 assert.deepEqual(contexts,[{width:1440,height:900},{width:1440,height:900}]);
 assert.equal(calls.length,1);
 const legacy=await verify(html,{compareVisual:false},engine);assert.equal(legacy.result.visual,undefined);
 assert.deepEqual(contexts,[{width:1440,height:900},{width:1440,height:900},{width:1440,height:900}]);
});
test('mobile-only visual defects do not affect desktop published verification',async()=>{
 const {result}=await verify(html+'<style>@media(max-width:650px){#pp-landing{opacity:0;width:1800px}}</style>');
 assert.equal(result.state,'ok',JSON.stringify(result));assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
 assert.deepEqual(result.visual.viewports.map(v=>v.name),['desktop']);
});
test('WordPress prose apostrophes do not prevent matching the desktop text samples',async()=>{
 const expected=html.replace('The prepared page includes',"The operator's guide includes");
 const {result}=await verify(expected.replace("operator's","operator’s"),{expectedHtml:expected});
 assert.equal(result.state,'ok',JSON.stringify(result.visual));
 assert.equal(result.visual?.state,'ok');
});
test('visual aggregation requires one conclusive desktop result and stays unknown without it',async()=>{
 const {combineVisualViewports}=await import('../server/lifecycle/published-visual.mjs');
 for(const state of ['ok','problem','unknown'])assert.equal(combineVisualViewports([{name:'desktop',state,code:'fixture_'+state}]).state,state);
 assert.equal(combineVisualViewports([]).state,'unknown');
 assert.equal(combineVisualViewports([{name:'mobile',state:'problem',code:'fixture_problem'}]).state,'unknown');
});
test('visual comparison confirms missing CSS rather than relying on source-style mismatch',async()=>{
 const {result}=await verify(body);assert.equal(result.visual?.state,'problem',JSON.stringify(result));
 assert.ok(result.visual.viewports.every(v=>v.state==='problem'));
});
test('visual comparison confirms large typography and wrapper-layout changes',async()=>{
 for(const css of ['#pp-landing,#pp-landing h1,#pp-landing h2{font-size:7px!important}','#pp-landing{width:150px!important}']){
  const {result}=await verify(html+'<style>'+css+'</style>');assert.equal(result.visual?.state,'problem',JSON.stringify(result.visual));
 }
});
test('visual comparison confirms text hidden, same-color text and severe content clipping',async()=>{
 for(const css of ['#pp-landing{opacity:0}','#pp-landing{color:#fff}','#pp-landing{height:24px;overflow:hidden}']){
  const {result}=await verify(html+'<style>'+css+'</style>');assert.equal(result.visual?.state,'problem',JSON.stringify(result.visual));
 }
});
test('small font, spacing and color noise does not become a visual failure',async()=>{
 const {result}=await verify(html+'<style>#pp-landing{font-size:20.2px;padding:25px;color:#18212b}#pp-landing h1{font-size:36.2px}</style>');
 assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
});
test('explicit visible descendants remain visible inside a visibility-hidden wrapper',async()=>{
 const {result}=await verify(html+'<style>#pp-landing{visibility:hidden}#pp-landing h1,#pp-landing h2,#pp-landing p{visibility:visible}</style>');
 assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
});
test('readable text on a translucent background is not mistaken for white-on-white content',async()=>{
 const {result}=await verify(html+'<style>#pp-landing p{background:rgba(0,0,0,.8);color:#fff}</style>');
 assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
});
test('failed or unsupported assets make even a visually broken snapshot unknown',async()=>{
 for(const source of ['<link rel="stylesheet" href="/missing.css">','<link rel="stylesheet" href="https://outside.example/theme.css">']){
  const {result}=await verify(source+html+'<style>#pp-landing{opacity:0}</style>');assert.equal(result.visual?.state,'unknown',JSON.stringify(result.visual));
 }
});
test('untrusted scripts and a blocked required runtime cannot authorize visual cleanup',async()=>{
 const untrusted=await verify(html+'<script>document.body.remove()</script><style>#pp-landing{opacity:0}</style>');
 assert.equal(untrusted.result.visual?.state,'unknown',JSON.stringify(untrusted.result.visual));
 const expected=runtime.prepare(html),blocked=await verify(expected+'<style>#pp-landing{opacity:0}</style>',{expectedHtml:expected,headers:{'content-security-policy':"script-src 'none'"}});
 assert.equal(blocked.result.visual?.state,'unknown',JSON.stringify(blocked.result.visual));
});
test('public CSP that blocks prepared styles cannot produce a successful visual comparison',async()=>{
 const {result}=await verify(html,{headers:{'content-security-policy':"style-src 'none'"}});
 assert.equal(result.visual?.state,'unknown',JSON.stringify(result.visual));
});
test('baseline and published render share the same constrained fetched asset bytes',async()=>{
 const expected=runtime.prepare('<link rel="stylesheet" href="/prepared.css">'+body),calls=[];
 const transport=async(address,init)=>{
  calls.push({address,init});
  if(address===url)return {status:200,url,headers:{'content-type':'text/html'},text:expected};
  if(address==='https://site.example/prepared.css')return {status:200,url:address,headers:{'content-type':'text/css'},text:style.slice(7,-8)};
  throw Error('Unexpected fixture request');
 };
 const {result}=await verify(expected,{expectedHtml:expected,transport});
 assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
 assert.deepEqual(calls.map(c=>c.address),[url,'https://site.example/prepared.css']);
 assert.ok(calls.every(c=>c.init.sameOriginOnly&&!c.init.headers.authorization&&!c.init.headers.cookie));
});
test('an extra exact public Clean Links runtime is allowed only after behavior verification',async()=>{
 const expected=runtime.prepare(html),php=require('./qa/php-runtime.cjs').resolvePHP56();
 const rendered=spawnSync(php,['-n',path.join(__dirname,'fixtures/clean-links-published.php')],{encoding:'utf8',input:expected,env:{...process.env,PP_CANVAS_PLUGIN:path.resolve(__dirname,'../wordpress/pageposter-clean-links/pageposter-clean-links.php')},windowsHide:true,timeout:30000});
 assert.equal(rendered.status,0,rendered.stderr||rendered.stdout);
 const passed=await verify(rendered.stdout,{expectedHtml:expected});
 assert.ok(passed.result.viewports.every(v=>v.checks.some(c=>c.kind==='clean_links_runtime'&&c.state==='ok')));
 assert.equal(passed.result.visual?.state,'ok',JSON.stringify(passed.result.visual));
 const {runtimeHash}=await import('../server/lifecycle/published-snapshot.mjs');
 const blocked=await verify(rendered.stdout,{expectedHtml:expected,headers:{'content-security-policy':"script-src 'sha256-"+runtimeHash+"'"}});
 assert.equal(blocked.result.visual?.state,'unknown',JSON.stringify(blocked.result.visual));
 const missing=await verify(expected,{expectedHtml:rendered.stdout});
 assert.equal(missing.result.visual?.state,'unknown',JSON.stringify(missing.result.visual));
});
test('navigation, link, indexing and pointer interaction failures do not imply a visual problem',async()=>{
 const expected=html.replace('</div>','<a href="https://partner.example/offer">Readable offer</a><a href="#missing">Details</a></div>');
 const published='<meta name="robots" content="noindex">'+expected.replace('https://partner.example/offer','https://other.example/offer')+'<style>#pp-landing a{pointer-events:none}</style>';
 const {result}=await verify(published,{expectedHtml:expected,expectedUrls:['https://partner.example/offer']});
 assert.equal(result.state,'problem');assert.equal(result.visual?.state,'ok',JSON.stringify(result.visual));
});
test('unavailable or invalid visual baseline remains unknown',async()=>{
 const {result}=await verify(html,{expectedHtml:undefined,page:{}});assert.equal(result.visual?.state,'unknown');
});
