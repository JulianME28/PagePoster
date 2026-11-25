const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
test('recorded generations render with exact links on desktop and phone', {timeout:90000}, async t=>{
 const {chromium}=require(playwrightPath);
 const {pagePlannerContract}=await import('../server/lifecycle/ai-page-planner.mjs');
 const {renderPage}=await import('../server/lifecycle/render.mjs');
 const {prepareConfig}=await import('../server/lifecycle/workflow.mjs');
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--no-first-run','--disable-background-networking']});
 t.after(()=>browser.close());
 const context=await browser.newContext();await context.route('**/*',r=>r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const dir=path.join(__dirname,'fixtures','ai-stability');
 for(const file of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){
  const {input,plan}=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]};
  const result=pagePlannerContract.parse(response,input),rendered=renderPage(prepareConfig(result.config));
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});
   await page.setContent('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+rendered.html+'</body></html>');
   const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText,links:[...document.querySelectorAll('a[href]')].map(a=>({url:a.getAttribute('href'),anchor:a.textContent})),actions:[...document.querySelectorAll('[data-pp-url]')].map(a=>a.getAttribute('data-pp-url')),h1:document.querySelector('h1')?.innerText}));
   assert.ok(state.h1,file);assert.doesNotMatch(state.text,/\[\[PP_/);
   assert.ok(state.scroll<=state.width+1,file+' at '+width+' overflow: '+state.scroll);
   for(const url of new Set(input.links.map(l=>l.url)))assert.equal(state.links.filter(l=>l.url===url).length,1,file+' exact destination');
   for(const link of input.links)assert.ok(state.text.includes(link.anchor),file+' anchor');
   assert.ok(state.actions.length>=input.links.length,file+' offer actions');
   assert.ok(state.actions.every(url=>input.links.some(link=>link.url===url)),file+' unrequested destination');
  }
 }
 assert.deepEqual(errors,[]);
});
