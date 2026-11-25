'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const url='https://site.example/page/',partner='https://partner.example/offer?x=1%2B2';
const runtime=require('../dist/page-runtime.js');
const executablePath=require('./browser-runtime.cjs').chromePath;
const base=runtime.prepare('<style>body{margin:0}#pp-landing{font:20px Arial;background:white;color:#111;padding:24px}</style><div id="pp-landing"><h1>Prepared title</h1><a href="'+partner+'">Offer</a><button data-pp-url="'+partner+'">Repeated offer</button></div>');
async function verify(html,expected=base,options={}){
 const {createBrowserVerifier}=await import('../server/lifecycle/browser-check.mjs');
 return createBrowserVerifier({chromium,executablePath,timeoutMs:20000,transport:async()=>({status:200,url,headers:{'content-type':'text/html'},text:html})}).verifyPublished({url,expectedHtml:expected,expectedUrls:[partner],...options});
}
test('link report separates our exact URL groups, native hrefs, repeated controls and theme extras',async()=>{
 const result=await verify('<a href="https://wordpress.org/">Theme documentation</a>'+base);
 assert.equal(result.state,'problem');
 assert.deepEqual(result.linkSummary,{expectedUrls:1,ourUrls:1,nativeHrefs:1,repeatedControls:1,outsideUrls:1,unexpectedOurUrls:0});
 const {safePublishedEvidence}=await import('../server/lifecycle/published-diagnostics.mjs');
 assert.deepEqual(safePublishedEvidence(result).linkSummary,result.linkSummary);
 const serialized=JSON.stringify(safePublishedEvidence(result));assert.ok(!serialized.includes(partner));assert.ok(!serialized.includes('wordpress.org'));
});
test('hidden required content at the end of a long page is checked without visual cleanup mode',async()=>{
 const expected=base.replace('</div>',Array.from({length:120},(_,i)=>'<h4>Section '+i+'</h4><p>Visible details.</p>').join('')+'<table><tr><td>Final comparison</td></tr></table><details open><summary>Final FAQ</summary><p>Answer</p></details><footer>Final footer</footer></div>');
 for(const selector of ['h4:last-of-type','table','summary','footer']){
  const result=await verify(expected+'<style>'+selector+'{display:none}</style>',expected);
  assert.equal(result.state,'problem',selector);
  assert.equal(result.viewports[0].checks.find(c=>c.kind==='required_content').state,'problem',selector);
 }
});
test('unexpected URLs inside the customer wrapper remain problems and are counted separately',async()=>{
 const result=await verify(base.replace('</div>','<a href="https://unexpected.example/">Unexpected</a></div>'));
 assert.equal(result.state,'problem');assert.equal(result.linkSummary?.unexpectedOurUrls,1);assert.equal(result.linkSummary?.outsideUrls,0);
});
test('theme skip navigation is separate from the prepared page navigation',async()=>{
 const expected=base.replace('</div>','<a href="#details">Details</a><h2 id="details">Details</h2></div>');
 const outside='<a href="#content">Skip to content</a><main id="content">'+expected+'</main>';
 const valid=await verify(outside,expected);
 assert.equal(valid.viewports[0].checks.find(c=>c.kind==='navigation').state,'ok');
 const broken=expected.replace('id="details"','id="moved"');
 const missing=await verify(broken,broken);
 assert.equal(missing.viewports[0].checks.find(c=>c.kind==='navigation').state,'problem');
});
test('text-only display-contents headings and footers are rendered, not falsely hidden',async()=>{
 const expected=base.replace('</div>','<footer>Footer text only</footer></div>');
 const result=await verify(expected+'<style>h1,footer{display:contents}</style>',expected,{compareVisual:true});
 assert.equal(result.state,'ok',JSON.stringify(result));
});
