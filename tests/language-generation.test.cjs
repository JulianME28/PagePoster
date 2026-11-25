const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('real generations in five languages retain exact anchors and localized buttons on desktop and phone',{timeout:30000},async t=>{
 const {pagePlannerContract}=await import('../server/lifecycle/ai-page-planner.mjs'),{prepareConfig}=await import('../server/lifecycle/workflow.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');
 const {chromium}=require('./browser-runtime.cjs').playwright;
 const browser=await chromium.launch({executablePath:require('./browser-runtime.cjs').chromePath,headless:true,args:['--no-first-run','--disable-background-networking']});
 t.after(()=>browser.close());const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 const labels={en:'Visit casino',es:'Visitar casino',pl:'Odwiedź kasyno',de:'Casino besuchen',fr:'Visiter le casino'};
 for(const [language,label] of Object.entries(labels)){
  const {input,plan}=require(path.join(__dirname,'fixtures/languages',language+'.json'));
  const result=pagePlannerContract.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]},input);
  assert.equal(result.language,language);assert.equal(result.quality.state,'passed');
  assert.deepEqual(result.config.aiLinkInsertions.map(({url,anchor})=>({url,anchor})),input.links);
  assert.equal(result.config.cards[0].button,label);assert.equal(result.config.ctaLabel,label);
  const rendered=renderPage(prepareConfig(result.config));
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});await page.setContent('<!doctype html><html><body>'+rendered.html+'</body></html>');
   assert.equal(await page.locator('#pp-landing').getAttribute('lang'),language);
   assert.equal(await page.locator('h1').innerText(),plan.title);
   assert.ok(await page.locator('.pp-cta').filter({hasText:label}).count()>0);
   assert.equal(await page.locator('.pp-prose a,.pp-resource-copy a').count(),0);
   assert.equal(await page.locator('a').evaluateAll((links,url)=>links.filter(a=>a.getAttribute('href')===url).length,input.links[0].url),2);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
 }
});
