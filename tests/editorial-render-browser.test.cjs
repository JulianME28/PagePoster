const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
test('six editorial formats render real generated copy with exact links on desktop and phone', {timeout:90000}, async t=>{
 const {chromium}=require(playwrightPath);
 const {pagePlannerContract}=await import('../server/lifecycle/ai-page-planner.mjs');
 const {renderPage}=await import('../server/lifecycle/render.mjs');
 const {prepareConfig}=await import('../server/lifecycle/workflow.mjs');
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--no-first-run','--disable-background-networking']});
 t.after(()=>browser.close());
 const context=await browser.newContext();await context.route('**/*',r=>r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const dir=path.join(__dirname,'fixtures','editorial');
 for(const file of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){
  const {input,plan}=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]};
  const result=pagePlannerContract.parse(response,input),rendered=renderPage(prepareConfig(result.config));assert.equal(rendered.config.editorialFormat,input.editorial.format);assert.equal(result.language,'en');assert.equal(result.quality.state,'passed');
  for(const width of [1440,768,390]){
   await page.setViewportSize({width,height:900});
   await page.setContent('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+rendered.html+'</body></html>');
   const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText,links:[...document.querySelectorAll('a[href]')].map(a=>({url:a.getAttribute('href'),anchor:a.textContent})),actions:[...document.querySelectorAll('[data-pp-url]')].map(a=>a.getAttribute('data-pp-url')),h1:document.querySelector('h1')?.innerText}));
   assert.ok(state.h1,file);assert.doesNotMatch(state.text,/\[\[PP_/);
   const prose=await page.locator('#pp-article > .pp-prose').first().evaluate(node=>({font:getComputedStyle(node).fontSize,border:getComputedStyle(node).borderLeftWidth}));
   assert.equal(prose.font,width===390?'16px':'17px',file+' editorial reading size');
   if(input.editorial.format==='discussion')assert.equal(prose.border,'3px',file+' discussion panel');
   assert.ok(state.scroll<=state.width+1,file+' at '+width+' overflow: '+state.scroll);
   const layout=await page.locator('#pp-landing').evaluate(node=>({position:getComputedStyle(node).position,width:node.clientWidth,scroll:node.scrollWidth,font:getComputedStyle(node.querySelector('.pp-resource-copy')).fontSize,headings:[...node.querySelectorAll('th')].map(th=>th.getBoundingClientRect().width)}));
   assert.equal(layout.position,'fixed',file+' must cover the WordPress theme');
   assert.ok(layout.scroll<=layout.width+1,file+' internal root overflow');
   assert.equal(layout.font,'14px',file+' link descriptions must not become bonus headlines');
   const design=await page.locator('#pp-landing').evaluate(node=>({paper:getComputedStyle(node).backgroundColor,heading:parseFloat(getComputedStyle(node.querySelector('h1')).fontSize),cta:node.querySelector('.pp-resource .pp-cta').getBoundingClientRect().height}));
   assert.equal(design.paper,'rgb(255, 255, 255)',file+' neutral reading canvas');
   assert.ok(design.heading<=(width===390?32:44),file+' proportionate title');
   assert.ok(design.cta>=44,file+' accessible action target');
   assert.ok(layout.headings.every(w=>w>=139),file+' readable table columns');
   assert.equal(await page.locator('.pp-score,.pp-bonus,.pp-wordmark').count(),0);
   if(input.editorial.format==='article'||input.editorial.format==='guide')assert.ok(await page.locator('.pp-glossary dt').count()>0);
   for(const url of new Set(input.links.map(l=>l.url)))assert.equal(state.links.filter(l=>l.url===url).length,url===result.config.brandUrl?2:1,file+' exact destination');
   assert.equal(await page.locator('.pp-prose a,.pp-resource-copy a').count(),0,file+' text must not contain outgoing links');
   assert.ok(state.actions.length>=input.links.length,file+' offer actions');
   assert.ok(state.actions.every(url=>input.links.some(link=>link.url===url)),file+' unrequested destination');
  }
 }
 assert.deepEqual(errors,[]);
});
