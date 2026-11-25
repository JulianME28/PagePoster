'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const pw=require('./browser-runtime.cjs').playwrightPath,chrome=require('./browser-runtime.cjs').chromePath;
const options={timeout:30000,skip:!(fs.existsSync(pw)&&fs.existsSync(chrome))};
const html='<!doctype html><html><head><title>Layered hero</title><style>:root{--text:#faf9fc}body{margin:0;color:var(--text);background:#0b0e19}.hero{position:relative;isolation:isolate;overflow:hidden;height:360px;background:#11121c}.art{position:absolute;inset:0;width:100%;height:100%;z-index:-3;background:#3868bd}.hero::before{content:"";position:absolute;inset:0;z-index:-2;background:linear-gradient(90deg,rgba(9,12,21,.94),transparent)}.hero::after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse at 82% 92%,#bc123522,transparent 42%)}.copy{padding:44px}h1{margin:0;font:600 36px/1.2 Arial}p{font:16px/1.6 Arial}.outside{position:relative;z-index:4}</style></head><body><section class="hero"><div class="art"></div><div class="copy"><h1>Readable hero title</h1><p>Original light text above the background layers.</p></div></section></body></html>';
test('import keeps negative hero layer order and exact visible pixels inside its isolated container',options,async t=>{
 const browser=await require(pw).chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1000,height:700}});await context.route('**/*',r=>r.abort());const page=await context.newPage();
 await page.setContent(html);const original=await page.locator('.hero').screenshot();
 const {prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');const prepared=prepareCustomerHtml({html,chromeMode:'overlay-only'});
 assert.doesNotMatch(prepared.warnings.join(' '),/z-index/,'Preserved layers need no warning about changing their order');
 await page.setContent(renderPage(prepared.config).html);
 const layers=await page.locator('.hero').evaluate(node=>({art:getComputedStyle(node.querySelector('.art')).zIndex,before:getComputedStyle(node,'::before').zIndex,after:getComputedStyle(node,'::after').zIndex,color:getComputedStyle(node.querySelector('h1')).color,contain:getComputedStyle(document.querySelector('#pp-imported-content')).contain,isolation:getComputedStyle(document.querySelector('#pp-imported-content')).isolation}));
 assert.deepEqual(layers,{art:'-3',before:'-2',after:'-1',color:'rgb(250, 249, 252)',contain:'layout paint',isolation:'isolate'});
 assert.deepEqual(await page.locator('.hero').screenshot(),original,'The original hero must not acquire a dark overlay above its text');
});
test('embedded font faces survive import while executable font sources and descriptors are removed',async()=>{
 const {prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');
 const source='<style>@font-face{font-family:AviReading;src:url("data:font/woff2;base64,d09GMgAAAAA=") format("woff2");font-weight:400 800;font-style:normal;font-display:swap}body{font-family:AviReading,Arial}</style><h1>Same typography</h1>';
 const result=renderPage(prepareCustomerHtml({html:source,chromeMode:'overlay-only'}).config).html;
 assert.equal(result.includes('@font-face{'),true);assert.equal(result.includes('data:font/woff2;base64,d09GMgAAAAA='),true);assert.equal(result.includes('font-weight:400 800'),true);assert.equal(/format\(["']?woff2/.test(result),true);
 for(const src of ['javascript:alert(1)','data:text/html;base64,PHNjcmlwdD4=','data:image/svg+xml;base64,PHN2Zz4=']){const bad=renderPage(prepareCustomerHtml({html:'<style>@font-face{font-family:Bad;src:url("'+src+'");behavior:url(evil)}</style><h1>Safe</h1>',chromeMode:'overlay-only'}).config).html;assert.equal(/@font-face|javascript:|data:text\/html|data:image\/svg|[;{]behavior:/.test(bad),false,src);}
});
test('embedded assets within the total HTML budget are not silently discarded by a smaller URL limit',async()=>{
 const {prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs'),data='data:image/png;base64,'+Buffer.alloc(85000,1).toString('base64');
 const result=renderPage(prepareCustomerHtml({html:'<h1>Bundled picture</h1><img src="'+data+'">',chromeMode:'overlay-only'}).config).html;
 assert.equal(result.includes('src="'+data+'"'),true,'A valid-sized package must retain its embedded picture');
});
