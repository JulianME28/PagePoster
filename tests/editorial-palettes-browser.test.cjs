const test=require('node:test'),assert=require('node:assert/strict');
test('24 palettes have distinct visible chrome, readable actions and mobile layout',{timeout:60000},async t=>{
 const {chromium}=require('./browser-runtime.cjs').playwright;
 const browser=await chromium.launch({executablePath:require('./browser-runtime.cjs').chromePath,headless:true});t.after(()=>browser.close());
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs'),{prepareConfig}=await import('../server/lifecycle/workflow.mjs');
 const f=require('./fixtures/languages/en.json'),page=await browser.newPage();await page.route('**/*',r=>r.abort());const headers=new Set();
 const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
 const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(let variant=0;variant<24;variant++){
  const {config}=c.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(f.plan)}]}]},{...f.input,variation:'editorial-v2:'+variant+':test'});
  const html=renderPage(prepareConfig(config)).html;
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:900});await page.setContent(html);
   const state=await page.locator('#pp-landing').evaluate(root=>{const css=selector=>getComputedStyle(root.querySelector(selector));return {width:root.clientWidth,scroll:root.scrollWidth,header:css('.pp-header').backgroundColor,nav:css('.pp-nav a').color,button:css('.pp-resource .pp-cta').backgroundColor,buttonText:css('.pp-resource .pp-cta').color,paper:getComputedStyle(root).backgroundColor,body:css('.pp-prose').color};});
   headers.add(state.header);assert.ok(state.scroll<=state.width+1,'palette '+variant+' at '+width);
   assert.ok(contrast(state.button,state.buttonText)>=4.5,'button contrast '+variant);assert.ok(contrast(state.header,state.nav)>=4.5,'navigation contrast '+variant);assert.ok(contrast(state.paper,state.body)>=4.5,'reading contrast '+variant);
  }
 }
 assert.equal(headers.size,24);
});
