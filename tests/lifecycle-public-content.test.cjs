'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mod=import('../server/lifecycle/wordpress.mjs');
const runtime=require('../dist/page-runtime.js');
const URL='https://partner.example/go?a=%2f&offer=7#offer';
const source=runtime.prepare('<style>#pp-landing{color:#123}</style><div id="pp-landing"><h1>Fresh title</h1><p>Fresh exact article.</p><a class="pp-cta" href="https://partner.example/go?a=%2f&amp;offer=7#offer">Exact anchor</a><button data-pp-url="https://partner.example/go?a=%2f&amp;offer=7#offer">Repeat offer</button><footer><a class="pp-brand" href="https://partner.example/go?a=%2f&amp;offer=7#offer">Brand name</a></footer></div>');
const site={baseUrl:'https://site.example/',username:'editor',applicationPassword:'secret'};
const page={wpId:12,wpType:'page',fullUrl:'https://site.example/offer/',expectedMarker:'pp-landing',expectedUrls:[URL],remoteSnapshot:{content:source}};
async function checks(html,extra={}){
 const transport=async(url,init)=>{
  let body='';const type={'content-type':'text/html'};
  if(url.includes('/wp/v2/pages/12'))body=JSON.stringify({id:12,status:'publish',content:{raw:source},title:{raw:'Fresh title'}});
  else if(url.includes('wp-json'))body=JSON.stringify({namespaces:['wp/v2'],routes:{'/wp/v2/pages':{methods:['GET']}}});
  else if(url.endsWith('/robots.txt'))body='User-agent: *\nDisallow:';
  else if(url.endsWith('/offer/'))body=html;
  else body='<link rel="https://api.w.org/" href="https://site.example/wp-json/">';
  return {status:200,headers:type,text:body,url};
 };
 return (await mod).createWordPressClient({transport}).checkPage({site,page:{...page,...extra}});
}
const get=(rows,kind)=>rows.find(x=>x.kind===kind);

test('editorial card and chrome links pass only with their two committed native hrefs',async()=>{
 const editorial=runtime.prepare('<div id="pp-landing" class="pp-editorial-v2"><header><a href="'+URL.replace(/&/g,'&amp;')+'">Brand</a></header><a class="pp-cta" href="'+URL.replace(/&/g,'&amp;')+'">Visit casino</a></div>',{separateChrome:true});
 const extra={remoteSnapshot:{content:editorial}};
 assert.equal(get(await checks(editorial,extra),'links').state,'ok');
 assert.equal(get(await checks(editorial.replace('Visit casino</a>','Visit casino</a><a href="'+URL.replace(/&/g,'&amp;')+'">Extra</a>'),extra),'links').state,'problem');
 assert.equal(get(await checks(editorial.replace(/<a class="pp-cta"[^>]*>Visit casino<\/a>/,''),extra),'links').state,'problem');
});
test('fresh public HTML with all exact controls passes content and links',async()=>{
 const result=await checks(source);assert.equal(get(result,'content').state,'ok');assert.equal(get(result,'links').state,'ok');
});
test('public stale text cannot pass because its URLs and wrapper still match',async()=>{
 const result=await checks(source.replace('Fresh title','Old cached title'));assert.equal(get(result,'content').state,'problem');assert.match(get(result,'content').evidence,/content_mismatch|stale/);
});
test('WordPress prose apostrophes are equivalent while link anchors and theme destinations are still checked',async()=>{
 const committed=source.replace('Fresh exact article.',"The operator's rules.").replace('Exact anchor',"Operator's offer");
 const publicHtml=committed.replace("operator's rules","operator’s rules");
 const extra={remoteSnapshot:{content:committed}};
 const equivalent=await checks(publicHtml,extra);
 assert.equal(get(equivalent,'content').state,'ok');
 assert.equal(get(equivalent,'links').state,'ok');
 const themeLinks=await checks('<header><a href="https://theme.example/">Theme link</a></header>'+publicHtml,extra);
 assert.equal(get(themeLinks,'content').state,'ok');
 assert.equal(get(themeLinks,'links').state,'problem');
 const wrongAnchor=await checks(publicHtml.replace("Operator's offer","Operator’s offer"),extra);
 assert.equal(get(wrongAnchor,'links').state,'problem');
 const differentText=await checks(publicHtml.replace('rules','odds'),extra);
 assert.equal(get(differentText,'content').state,'problem');
});
test('a wrong article or CTA anchor fails link verification',async()=>{
 const result=await checks(source.replace('Exact anchor','Wrong anchor'));assert.equal(get(result,'links').state,'problem');
});
test('removed duplicate or role control fails even with the one native href intact',async()=>{
 const result=await checks(source.replace(/<button[^>]*>Repeat offer<\/button>/,''));assert.equal(get(result,'links').state,'problem');
});
test('lost runtime script fails content verification while exact URLs remain',async()=>{
 const result=await checks(source.replace(/<script[\s\S]*?<\/script>/,''));assert.equal(get(result,'content').state,'problem');assert.match(get(result,'content').evidence,/script|runtime/);
});
test('rendered whitespace and harmless WordPress paragraph wrappers preserve content verification',async()=>{
 const result=await checks(source.replace('<h1>Fresh title</h1>','\n<h1>Fresh title</h1>\n').replace('<a class="pp-cta"','<p><a class="pp-cta"').replace('Exact anchor</a>','Exact anchor</a></p>'));assert.equal(get(result,'content').state,'ok');assert.equal(get(result,'links').state,'ok');
});

test('swapped brand role is rejected even if its exact URL and label survive',async()=>{
 const result=await checks(source.replace('<footer>','<header>').replace('</footer>','</header>'));assert.equal(get(result,'links').state,'problem');
});
