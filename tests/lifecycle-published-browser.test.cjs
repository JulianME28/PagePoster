'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('./browser-runtime.cjs').playwright;
const runtime=require('../dist/page-runtime.js');
const mod=import('../server/lifecycle/browser-check.mjs');
const executablePath=require('./browser-runtime.cjs').chromePath,url='https://site.example/offer/',partner='https://partner.example/go?a=%2f&offer=7#offer';
const html=runtime.prepare('<style>body{margin:0}#pp-landing{max-width:980px;margin:auto;padding:18px;box-sizing:border-box}a,button{display:inline-block;padding:12px}#details{margin-top:1200px}.pp-mobile-nav{display:none}@media(max-width:650px){.pp-mobile-nav{display:block}.pp-desktop-nav{display:none}}</style><div id="pp-landing"><h1>Fresh title</h1><nav class="pp-desktop-nav"><a href="#details">Details</a></nav><details class="pp-mobile-nav"><summary>Menu</summary><a href="#details">Details</a></details><a class="pp-cta" href="https://partner.example/go?a=%2f&amp;offer=7#offer">Exact anchor</a><button data-pp-url="https://partner.example/go?a=%2f&amp;offer=7#offer">Repeat offer</button><footer><a class="pp-brand" href="https://partner.example/go?a=%2f&amp;offer=7#offer">Brand name</a></footer><section id="details"><h2>Details</h2><p>Fresh content.</p></section></div>');
async function verify(published=html,options={}){
 const calls=[];const transport=async(address,init)=>{calls.push({address,init});if(address!==url)throw Error('Unexpected request');return {status:200,url,headers:{'content-type':'text/html'},text:published};};
 const result=await (await mod).createBrowserVerifier({chromium,executablePath,transport,timeoutMs:20000}).verifyPublished({url,page:{fullUrl:url,remoteSnapshot:{content:html}},expectedUrls:[partner],...options});return {result,calls};
}
test('published constrained runtime verifies only desktop controls and exact intercepted click destinations',async()=>{
 const {result,calls}=await verify();assert.equal(result.state,'ok',JSON.stringify(result));assert.equal(result.scope,'public-snapshot');
 assert.deepEqual(result.viewports.map(v=>[v.name,v.width,v.height]),[['desktop',1440,900]]);
 for(const view of result.viewports){assert.equal(view.checks.find(c=>c.kind==='clicks').state,'ok');assert.equal(view.clicks.length,3);assert.ok(view.clicks.every(c=>c.destination===partner&&c.state==='ok'));}
 assert.ok(result.viewports.every(v=>v.checks.every(c=>c.kind!=='mobile_menu')));assert.equal(calls.length,1);assert.ok(calls.every(c=>!c.init.headers.authorization&&!c.init.headers.cookie));
});
test('published stale content and missing runtime cannot be reported verified',async()=>{
 for(const source of [html.replace('Fresh title','Old title'),html.replace(/<script[\s\S]*?<\/script>/,'')]){const {result}=await verify(source);assert.equal(result.state,'problem');assert.equal(result.code,'content_mismatch');}
});
test('CSS-blocked mobile menu does not affect desktop-only public verification',async()=>{
 const {result}=await verify(html+'<style>@media(max-width:650px){.pp-mobile-nav summary{pointer-events:none}}</style>');assert.equal(result.state,'ok');assert.deepEqual(result.viewports.map(v=>v.name),['desktop']);
});
test('desktop published clicks ignore hidden responsive duplicates but verify visible exact destinations',async()=>{
 const published=html.replace('<footer>','<button class="mobile-only" data-pp-url="https://partner.example/go?a=%2f&amp;offer=7#offer">Mobile offer</button><footer>')+'<style>@media(min-width:651px){.mobile-only{display:none}}</style>';
 const {result,calls}=await verify(published,{expectedHtml:published,compareVisual:true});
 assert.equal(result.state,'ok',JSON.stringify(result));assert.equal(result.visual.state,'ok');
 const desktop=result.viewports[0];assert.equal(desktop.checks.find(c=>c.kind==='cta_targets').state,'ok');
 assert.equal(desktop.clicks.length,3);assert.ok(desktop.clicks.every(c=>c.destination===partner&&c.state==='ok'));
 assert.ok(desktop.clicks.every(c=>c.anchor!=='Mobile offer'));assert.equal(calls.length,1);
});
test('a destination available only through a hidden mobile control is not verified on desktop',async()=>{
 const mobile='https://mobile-only.example/offer',published=html.replace('<footer>','<a class="mobile-only" href="'+mobile+'">Mobile destination</a><footer>')+'<style>@media(min-width:651px){.mobile-only{display:none}}</style>';
 const {result}=await verify(published,{expectedHtml:published,expectedUrls:[partner,mobile]});
 assert.equal(result.viewports[0].checks.find(c=>c.kind==='links').state,'ok');
 assert.equal(result.viewports[0].checks.find(c=>c.kind==='cta_targets').state,'problem');
 assert.equal(result.state,'problem');assert.ok(result.viewports[0].clicks.every(c=>c.anchor!=='Mobile destination'));
});
test('unsupported executable site script is removed and keeps published status unknown',async()=>{
 const {result,calls}=await verify(html+'<script>fetch("http://127.0.0.1:1/leak");window.__pwned=true</script>');assert.equal(result.state,'unknown');assert.equal(result.code,'unsupported_page_scripts');assert.equal(calls.length,1);assert.equal(result.network.untrustedScripts,1);
});
test('loopback public addresses are rejected before a browser or transport can be used',async()=>{
 let calls=0;const {createBrowserVerifier}=await mod;const verifier=createBrowserVerifier({chromium:{launch(){calls++;throw Error('unexpected');}},transport:async()=>{calls++;throw Error('unexpected');}});
 const result=await verifier.verifyPublished({url:'https://127.0.0.1/secret',expectedHtml:html});assert.equal(result.state,'problem');assert.equal(result.code,'unsafe_address');assert.equal(calls,0);
});
test('published screenshot is one real bounded desktop PNG',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-published-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const {result}=await verify(html,{artifactDir:dir});assert.equal(result.state,'ok');assert.equal(result.viewports.length,1);for(const v of result.viewports){const bytes=fs.readFileSync(v.screenshot.path);assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),1440);assert.equal(bytes.readUInt32BE(20),900);}
});

test('actual public CSP that blocks the runtime cannot become a successful script check',async()=>{
 const {createBrowserVerifier}=await mod;
 const result=await createBrowserVerifier({chromium,executablePath,transport:async()=>({status:200,url,headers:{'content-type':'text/html','content-security-policy':"script-src 'none'"},text:html})}).verifyPublished({url,expectedHtml:html,expectedUrls:[partner]});
 assert.equal(result.state,'problem');assert.ok(result.viewports.some(v=>v.checks.some(c=>c.kind==='runtime'&&c.state==='problem')));
});
test('same-origin fetched theme stylesheet can expose a broken CTA and raw binary images load',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const published='<link rel="stylesheet" href="/theme.css">'+html.replace('<h1>','<img src="/logo.png" alt="Logo"><h1>');
 const calls=[];const transport=async(address,init)=>{calls.push({address,init});if(address===url)return {status:200,url,headers:{'content-type':'text/html'},text:published};if(address==='https://site.example/theme.css')return {status:200,url:address,headers:{'content-type':'text/css'},text:'.pp-cta{pointer-events:none}',body:Buffer.from('.pp-cta{pointer-events:none}')};if(address==='https://site.example/logo.png')return {status:200,url:address,headers:{'content-type':'image/png'},body:bytes,text:bytes.toString('utf8')};throw Error('unexpected');};
 const result=await (await mod).createBrowserVerifier({chromium,executablePath,transport,timeoutMs:20000}).verifyPublished({url,expectedHtml:published,expectedUrls:[partner]});
 assert.equal(result.state,'problem');assert.equal(result.network.fetchedAssets,2);assert.equal(result.network.failedAssets,0);assert.ok(result.viewports.every(v=>v.clicks.find(c=>c.anchor==='Exact anchor').state==='problem'));assert.ok(calls.every(c=>c.init.sameOriginOnly&&!c.init.headers.authorization&&!c.init.headers.cookie));
});
test('private asset URLs and remote CSS imports never reach the trusted transport',async()=>{
 const {result,calls}=await verify(html+'<style>@import url("https://other.example/theme.css");body{background-image:url(https://127.0.0.1/private)}</style><img src="https://169.254.169.254/latest" alt="outside">');
 assert.equal(result.state,'unknown');assert.equal(result.code,'published_assets_incomplete');assert.equal(calls.length,1);assert.ok(result.network.blockedAssets>=3);
});

test('theme CSS that hides a required heading prevents a verified public snapshot',async()=>{
 const {result}=await verify(html+'<style>#pp-landing h1{display:none}</style>');assert.equal(result.state,'problem');assert.ok(result.viewports.every(v=>v.checks.some(c=>c.kind==='required_content'&&c.state==='problem')));
});
test('a Chromium launch finishing after the deadline is closed without creating a context',{timeout:4000},async()=>{
 let closed=0,contexts=0;
 const checker=(await mod).createBrowserVerifier({executablePath,timeoutMs:1000,transport:async()=>({status:200,url,headers:{'content-type':'text/html'},text:html}),chromium:{launch:async()=>{await new Promise(r=>setTimeout(r,1200));return {newContext:async()=>{contexts++;throw Error('must not be reached');},close:async()=>{closed++;}};}}});
 const result=await checker.verifyPublished({url,expectedHtml:html,expectedUrls:[partner]});assert.equal(result.code,'browser_timeout');await new Promise(r=>setTimeout(r,450));assert.equal(contexts,0);assert.equal(closed,1);
});

test('native links opening a new tab are intercepted in the original context without a popup visit',async()=>{
 const published=html.replace('<a class="pp-cta"','<a target="_blank" class="pp-cta"');const {result,calls}=await verify(published,{expectedHtml:published});assert.equal(result.state,'ok');assert.equal(calls.length,1);assert.ok(result.viewports.every(v=>v.clicks.every(c=>c.destination===partner)));
});

test('published Ukrainian text is rendered as UTF-8 when a source fragment has no charset meta',async()=>{
 const published=html.replace('Fresh title','Український заголовок');const {result}=await verify(published,{expectedHtml:published});assert.equal(result.state,'ok');assert.ok(result.viewports.every(v=>v.snapshot.headings[0].text==='Український заголовок'));
});
