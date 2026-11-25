'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const visual=import('../server/lifecycle/published-visual.mjs');
let browser;
test.before(async()=>{browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});});
test.after(async()=>{await browser?.close();});
async function capture(html){
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 try{await page.route('**/*',r=>r.abort());await page.setContent(html);return await(await visual).capturePublishedVisual(page,'pp-landing');}
 finally{await page.close();}
}
const fixed='<style>html,body{margin:0;overflow:hidden}#pp-landing{position:fixed;inset:0;overflow:hidden;background:white;color:#111;font:20px Arial}h1{margin:24px;line-height:40px;font-size:32px}</style><div id="pp-landing"><h1>Visible fixed heading</h1></div>';
test('fixed viewport content is not clipped by zero-height static document ancestors',async()=>{
 const expected=await capture(fixed);
 for(const suffix of ['', '<style>body{overflow:visible}</style>','<style>html{overflow:visible}</style>']){
  const actual=await capture('<!doctype html>'+fixed+suffix);
  assert.equal((await visual).compareVisualViewport(expected,actual).state,'ok',JSON.stringify(actual));
 }
});
test('real clipping by a fixed containing block and the landing itself remains a problem',async()=>{
 const expected=await capture(fixed);
 for(const css of ['body{transform:translateZ(0)}','#pp-landing{height:20px;inset:auto 0 0}']){
  const actual=await capture('<!doctype html>'+fixed+'<style>'+css+'</style>');
  assert.equal((await visual).compareVisualViewport(expected,actual).state,'problem');
 }
});
const long='<style>body{margin:0}#pp-landing{font:18px/1.5 Arial;background:white;color:#111;padding:24px}h1,h2{font-size:30px}</style><div id="pp-landing"><h1>Long customer page</h1>'+Array.from({length:600},(_,i)=>'<p>Article paragraph '+i+' remains readable.</p>').join('')+'<table><caption>Final comparison</caption><tr><th>Brand</th><td>Original value</td></tr></table><details open><summary>Final FAQ question</summary><p>Original FAQ answer.</p></details><footer><h2>Required footer</h2><p>Footer details.</p></footer></div>';
test('distributed desktop samples include tables, FAQ and footer beyond the first 250 nodes',async()=>{
 const expected=await capture(long),actual=await capture(long+'<style>footer{opacity:0}</style>');
 assert.ok(expected.samples.some(s=>s.text==='Required footer'));
 assert.ok(expected.samples.some(s=>s.text==='Original value'));
 assert.ok(expected.samples.some(s=>s.text==='Original FAQ answer.'));
 assert.equal(expected.coverage?.complete,true);
 assert.equal((await visual).compareVisualViewport(expected,actual).state,'problem');
 assert.ok(expected.samples.length<=512);
});
test('unbounded source structures yield an explicit incomplete check rather than false success',async()=>{
 const huge='<div id="pp-landing">'+Array.from({length:22000},()=>'<span>Text</span>').join('')+'</div>';
 const result=await capture(huge);
 assert.equal(result.coverage?.complete,false);
 assert.equal((await visual).compareVisualViewport(result,result).state,'unknown');
});
test('unsampled ordinary paragraph, list and div text cannot disappear behind a green check',async()=>{
 for(const tag of ['p','li','div']){
  const source='<style>#pp-landing{font:18px Arial;background:white;color:#111}</style><div id="pp-landing"><h1>Title</h1>'+Array.from({length:600},(_,i)=>'<'+tag+' id="part'+i+'">Paragraph '+i+'</'+tag+'>').join('')+'</div>';
  const expected=await capture(source),actual=await capture(source+'<style>#part4{visibility:hidden}</style>');
  assert.equal((await visual).compareVisualViewport(expected,actual).state,'problem',tag);
 }
});
test('table and footer semantics cannot disappear while the same visible text passes comparison',async()=>{
 const {comparePublishedContent}=await import('../server/lifecycle/published-content.mjs');
 for(const published of [long.replaceAll('<td>','<div>').replaceAll('</td>','</div>'),long.replace('<footer>','<section>').replace('</footer>','</section>')]){
  assert.equal(comparePublishedContent(published,long).state,'problem');
 }
});
