'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const executablePath=process.env.PAGEPOSTER_CHROME||process.env.PAGEPOSTER_CHROME_PATH||require('./browser-runtime.cjs').chromePath;
const browserOptions={timeout:45000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(executablePath))};
const destination='https://offer.example/go?token=%2f%2F&item=7#Exact';
function source(css,attributes=''){
 return '<!doctype html><html '+attributes+'><head><title>Imported root sizing</title><style>'+css+'</style></head><body><div class="card" style="margin-bottom:1rem">Material <a href="'+destination.replace('&','&amp;')+'">Offer</a></div></body></html>';
}
async function session(t){
 const {chromium}=require(playwrightPath);const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());
 const context=await browser.newContext();await context.route('**/*',route=>route.abort());return context.newPage();
}
async function measure(page,html,width=1000){
 await page.setViewportSize({width,height:800});await page.setContent(html);
 return page.locator('.card').evaluate(node=>{const css=getComputedStyle(node);return {font:css.fontSize,padding:css.padding,width:css.width,margin:css.marginBottom,lineHeight:css.lineHeight};});
}
async function compare(t,html,widths){
 const page=await session(t),{prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');
 for(const chromeMode of ['overlay-only','custom']){
  const prepared=prepareCustomerHtml({html,chromeMode}),rendered=renderPage(prepared.config);
  assert.equal(prepared.config.importHtml,html);assert.deepEqual(prepared.warnings,[]);assert.deepEqual(rendered.expectedUrls,[destination]);
  for(const width of widths){
   const original=await measure(page,html,width);
   for(const root of [16,20]){
    const host='<style>html{font-size:'+root+'px!important}#outside{font-size:2rem;padding:1rem}</style><div id="outside">Theme content</div>';
    assert.deepEqual(await measure(page,host+rendered.html,width),original,chromeMode+' at '+width+' with host root '+root);
    assert.deepEqual(await page.locator('#outside').evaluate(node=>({font:getComputedStyle(node).fontSize,padding:getComputedStyle(node).padding})),{font:root*2+'px',padding:root+'px'});
    assert.equal(await page.locator('html').evaluate(node=>getComputedStyle(node).fontSize),root+'px');
    assert.equal(await page.locator('#pp-imported-content a').getAttribute('href'),destination);
   }
  }
 }
}
test('percentage root rem sizes match original and remain independent of host root in both chrome modes',browserOptions,async t=>{
 await compare(t,source('html{font-size:62.5%}.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:2rem}'),[1000]);
});
test('responsive root custom properties, fallback rem and inline styles preserve source measurements',browserOptions,async t=>{
 await compare(t,source(':root{--root-percent:62.5%;--root-font:var(--root-percent);--gap:2rem;font-size:var(--root-font)}.card{font-size:1.6rem;padding:var(--gap);width:calc(30rem + var(--missing,1rem));line-height:2rem}@media(max-width:600px){:root{--root-percent:75%;--gap:1rem}}'),[1000,480]);
});
test('rem in root font variables resolves against initial font while descendant rem uses the resulting root',browserOptions,async t=>{
 await compare(t,source(':root{--size:0.625rem;--root-font:var(--size);font-size:var(--root-font)}.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:2rem}@media(max-width:600px){:root{--size:.75rem}}'),[1000,480]);
});

test('root font shorthand resolves its font-size and line-height in their distinct root contexts',browserOptions,async t=>{
 await compare(t,source('html{font:1.25rem/2rem Arial}.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:inherit}'),[1000]);
});
test('inline root sizing and inline variables retain precedence over responsive stylesheet declarations',browserOptions,async t=>{
 await compare(t,source('html{font-size:80%!important}.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:2rem}@media(max-width:600px){html{font-size:50%!important}}','style="--size:62.5%;font-size:var(--size)!important"'),[1000,480]);
});
test('ambiguous variable font shorthand and other root-relative units require review',async()=>{
 const {prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs');
 for(const css of ['html{--font:1.25rem/2rem Arial;font:var(--font)}.card{width:30rem}', 'html{font-size:62.5%}.card{width:3rlh}']){
  const prepared=prepareCustomerHtml({html:source(css),chromeMode:'overlay-only'});
  assert.equal(prepared.requiresReview,true,css);assert.match(prepared.warnings.join(' '),/корен|root|rem/i);
 }
});

test('grouped root and pseudo-element selectors preserve root sizing and source declaration order',browserOptions,async t=>{
 await compare(t,source('html,.card::before{font-size:1rem;font-size:0.625rem}.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:2rem}'),[1000]);
});
test('prepared root size follows viewport changes without rerendering or script measurement',browserOptions,async t=>{
 const page=await session(t),{prepareCustomerHtml}=await import('../server/lifecycle/customer-html.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');
 const html=source('html{font-size:62.5%}.card{width:30rem;font-size:1.6rem}@media(max-width:600px){html{font-size:75%}}');
 const rendered=renderPage(prepareCustomerHtml({html,chromeMode:'overlay-only'}).config).html;
 await page.setViewportSize({width:1000,height:800});await page.setContent('<style>html{font-size:20px}</style>'+rendered);
 assert.equal(await page.locator('.card').evaluate(node=>getComputedStyle(node).width),'300px');
 await page.setViewportSize({width:480,height:800});
 assert.equal(await page.locator('.card').evaluate(node=>getComputedStyle(node).width),'360px');
 await page.setViewportSize({width:1000,height:800});
 assert.equal(await page.locator('.card').evaluate(node=>getComputedStyle(node).width),'300px');
});

test('root pseudo-class and source classes retain precedence over later html type selectors',browserOptions,async t=>{
 const card='.card{font-size:1.6rem;padding:2rem;width:30rem;line-height:2rem}';
 await compare(t,source(':root{--size:.625rem;font-size:var(--size)}html{--size:.75rem}'+card),[1000]);
 await compare(t,source(':root{font-size:62.5%}html{font-size:75%}'+card),[1000]);
 await compare(t,source('.source-root{font-size:62.5%}html{font-size:75%}'+card,'class="source-root"'),[1000]);
 await compare(t,source('html{font-size:62.5%}*{font-size:75%}'+card),[1000]);
});
