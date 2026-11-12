// Server-only offline and constrained public-response verification. Chromium never fetches user URLs directly.
import path from 'node:path';
import {mkdir,realpath,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {JSDOM} from './dom-runtime.mjs';
import {expectedNativeCounts} from './native-link-policy.mjs';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
import {findBrowserExecutable} from './browser-executable.cjs';
import {expectedHtmlFor,comparePublishedContent} from './published-content.mjs';
import {buildPublishedLinkReport} from './published-link-report.mjs';
import {readPublished,preparePublished,installNavigationProbe,verifyInteractions} from './published-snapshot.mjs';
import {verifyCleanerRuntime} from './cleaner-runtime.mjs';
import {unknownVisual,installVisualPolicyProbe,capturePublishedVisual,renderPreparedVisual,compareVisualViewport,combineVisualViewports} from './published-visual.mjs';
const require=createRequire(import.meta.url);
const VIEWPORTS=Object.freeze([{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}]);
const PUBLISHED_VIEWPORTS=Object.freeze([{name:'desktop',width:1440,height:900}]);
const fail=code=>{throw Object.assign(Error(code),{code});};
const check=(kind,state,evidence)=>({kind,state,evidence});
const validURL=value=>{
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f\\]/.test(value))return false;
 try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}
};
function prepare(input){
 if(!input||typeof input.html!=='string'||!input.html.trim()||Buffer.byteLength(input.html,'utf8')>1000000)fail('browser_validation');
 const expectedUrls=input.expectedUrls;
 if(expectedUrls!==undefined&&(!Array.isArray(expectedUrls)||expectedUrls.length>1000||expectedUrls.some(v=>!validURL(v))))fail('browser_validation');
 const expectedMarker=input.expectedMarker??'pp-landing';
 if(typeof expectedMarker!=='string'||!expectedMarker||expectedMarker.length>200)fail('browser_validation');
 if(input.artifactDir!==undefined&&(typeof input.artifactDir!=='string'||!path.isAbsolute(input.artifactDir)))fail('browser_validation');
 const dom=new JSDOM(input.html);
 try{
  const d=dom.window.document;
  if(d.querySelectorAll('*').length>30000||d.querySelectorAll('a[href],[data-pp-url]').length>5000)fail('browser_validation');
  const active=d.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta[http-equiv]');
  const removedActiveElements=active.length;active.forEach(node=>node.remove());
  let removedHandlers=0;
  for(const element of d.querySelectorAll('*'))for(const attr of [...element.attributes])if(/^on/i.test(attr.name)){element.removeAttribute(attr.name);removedHandlers++;}
  const policy=d.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'";
  d.head.prepend(policy);
  const stopMotion=d.createElement('style');stopMotion.textContent='*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';d.head.append(stopMotion);
  return {html:dom.serialize(),expectedMarker,expectedUrls:expectedUrls===undefined?undefined:[...new Set(expectedUrls)],sanitized:{removedActiveElements,removedHandlers}};
 }finally{dom.window.close();}
}
function defaultChromium(){
 for(const module of ['playwright','playwright-core',path.resolve(path.dirname(process.execPath),'..','node_modules','playwright'),path.resolve(path.dirname(process.execPath),'..','node_modules','playwright-core')]){
  try{return require(module).chromium;}catch{}
 }
 return null;
}
function browserPath(chromium,explicit){
 return findBrowserExecutable({chromium,executablePath:explicit});
}
async function artifactDirectory(value){
 if(value===undefined)return null;
 await mkdir(value,{recursive:true});
 const absolute=await realpath(value);if(!(await stat(absolute)).isDirectory())fail('browser_validation');return absolute;
}
// This runs only through Playwright's isolated automation evaluation. Page scripts stay disabled.
function snapshot({expectedMarker}){
 const marker=document.getElementById(expectedMarker),allMarkers=[...document.querySelectorAll('[id]')].filter(n=>n.id===expectedMarker);
 const styles=new WeakMap(),computed=n=>{if(!styles.has(n))styles.set(n,getComputedStyle(n));return styles.get(n);};
 const visible=node=>{const style=computed(node);let box=node.getBoundingClientRect();if(style.display==='contents'){const range=document.createRange();range.selectNodeContents(node);box=range.getBoundingClientRect();}if(box.width<=0||box.height<=0||['hidden','collapse'].includes(style.visibility))return false;for(let n=node;n&&n.nodeType===1;n=n.parentElement){const s=computed(n);if(s.display==='none'||s.contentVisibility==='hidden'||Number(s.opacity)===0)return false;}return true;};
 const good=value=>{if(typeof value!=='string'||/[\u0000-\u0020\u007f\\]/.test(value))return false;try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
 const label=node=>(node.getAttribute('aria-label')||node.textContent||node.querySelector('img')?.getAttribute('alt')||node.getAttribute('title')||'').trim().slice(0,250);
 const external=new Map(),invalid=[];
 for(const node of document.querySelectorAll('a[href],[data-pp-url]')){
  const href=node.tagName==='A'?node.getAttribute('href'):null,data=node.getAttribute('data-pp-url');
  for(const [value,native] of [[href,true],[data,false]]){
   if(value===null)continue;if(native&&value.startsWith('#'))continue;
   if(!good(value)){invalid.push({tag:node.localName,value:value.slice(0,250)});continue;}
   if(!external.has(value))external.set(value,{url:value,nativeCount:0,controlCount:0,visibleCount:0,unlabeledCount:0});
   const item=external.get(value);if(native)item.nativeCount++;
   if(native||value!==href){item.controlCount++;if(visible(node))item.visibleCount++;if(!label(node))item.unlabeledCount++;}
  }
 }
 const root=marker||document.body;
 const navigation=[...root.querySelectorAll('a[href^="#"]')].map(node=>{
  const href=node.getAttribute('href');let target=null;try{target=document.getElementById(decodeURIComponent(href.slice(1)));}catch{}
  return {href,label:label(node),targetExists:!!target&&(!marker||marker.contains(target)),visible:visible(node)};
 });
 const overflow=[];
 for(const node of root.querySelectorAll('*')){
  if(!visible(node))continue;
  const box=node.getBoundingClientRect();
  if(box.width>innerWidth+2&&(node.scrollWidth>node.clientWidth+2||box.right>innerWidth+2||box.left<-2)){
   // Customer HTML can use any class for a responsive table container. A wide
   // child inside a genuinely contained horizontal scroller does not widen the
   // page. Keep checking the scroller itself and the document's scroll width.
   let contained=false;
   for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){
    const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();
    if(['auto','scroll'].includes(style.overflowX)&&parent.scrollWidth>parent.clientWidth+2&&rect.left>=-2&&rect.right<=innerWidth+2&&parent.clientWidth<=innerWidth+2){contained=true;break;}
   }
   if(contained)continue;
   if(overflow.length<20)overflow.push({tag:node.localName,id:node.id,classes:typeof node.className==='string'?node.className.slice(0,120):'',width:Math.round(box.width)});
  }
 }
 const scrollWidth=Math.max(document.documentElement.scrollWidth,document.body.scrollWidth,marker?.scrollWidth||0);
 const required=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6,table,summary,footer')];
 return {markerCount:allMarkers.length,markerVisible:!!marker&&visible(marker),headings:required.filter(n=>/^H[1-6]$/.test(n.tagName)).slice(0,2000).map(n=>({level:Number(n.tagName.slice(1)),text:(n.textContent||'').trim().slice(0,300),visible:visible(n)})),
  structure:{complete:required.length<=2000,requiredBlocks:required.length,blocks:required.slice(0,2000).map(n=>({tag:n.localName,visible:visible(n)}))},
  externalLinks:[...external.values()],invalidControls:invalid.slice(0,100),navigation:navigation.slice(0,1000),scrollWidth,viewportWidth:innerWidth,overflow,
  scriptCount:document.scripts.length,scriptControls:document.querySelectorAll('[data-pp-url]').length,
  blockedAssetCandidates:document.querySelectorAll('img[src]:not([src^="data:"]),link[href],video[src],audio[src],source[src]').length};
}
function inspect(view,expectedUrls,nativeCounts=new Map()){
 const checks=[check('marker',view.markerCount===1&&view.markerVisible?'ok':'problem',view.markerCount===1&&view.markerVisible?'One visible page wrapper.':'Missing, duplicate or invisible page wrapper.')];
 const links=view.externalLinks;
 if(expectedUrls===undefined)checks.push(check('links','unknown','No expected destination list was supplied.'));
 else{
  const exact=links.length===expectedUrls.length&&expectedUrls.every(url=>links.some(link=>link.url===url&&link.nativeCount===(nativeCounts.get(url)||1)));
  checks.push(check('links',exact&&!view.invalidControls.length?'ok':'problem',exact&&!view.invalidControls.length?'Exact destinations match the required native link groups.':'Missing, extra, duplicate or unsafe native destinations.'));
 }
 checks.push(check('cta_targets',links.some(link=>link.unlabeledCount>0||link.visibleCount===0)||view.invalidControls.length?'problem':'ok','Destination attributes and accessible labels were inspected; remote destinations were not opened.'));
 checks.push(check('navigation',view.navigation.some(link=>!link.targetExists)?'problem':view.navigation.length?'ok':'not_applicable',view.navigation.some(link=>!link.targetExists)?'An in-page navigation target is missing.':'In-page navigation destinations exist.'));
 const overflow=view.overflow.length>0||view.scrollWidth>view.viewportWidth+2;
 checks.push(check('overflow',overflow?'problem':'ok',overflow?'Content exceeds the viewport width.':'No horizontal overflow detected at this viewport.'));
 return checks;
}
export function createBrowserVerifier({chromium,executablePath,timeoutMs=15000,preparationTimeoutMs=30000,transport=createSafeTransport()}={}){
 const timeout=Number.isInteger(timeoutMs)&&timeoutMs>=1000?Math.min(timeoutMs,30000):15000;
 const preparationTimeout=Number.isInteger(preparationTimeoutMs)&&preparationTimeoutMs>=1000?Math.min(preparationTimeoutMs,30000):30000;
 async function verifyPublished(input={}){
  let stage='public_read',expiredStage=null,phase='preparation',phaseStarted=performance.now(),phaseBudget=preparationTimeout,network,localLinkReport;
  const diagnostics=()=>({progress:{stage:expiredStage||stage,elapsedMs:Math.max(0,Math.min(60000,Math.round(performance.now()-phaseStarted))),budgetMs:phaseBudget},...(network?{network:{...network}}:{}),...(localLinkReport?{localLinkReport}:{})});
  const unknown=(code,evidence,state='unknown')=>({scope:'public-snapshot',state,code,evidence,viewports:[],...diagnostics(),...(input.compareVisual===true?{visual:unknownVisual(code)}:{}),limitations:['Only the exact packaged PagePoster and origin-bound Clean Links runtimes are supported; arbitrary theme scripts need an externally isolated runner.','A public snapshot does not replace the real WordPress pilot.']});
  let url;try{url=validatePublicUrl(input.url);if(input.page?.fullUrl&&validatePublicUrl(input.page.fullUrl).origin!==url.origin)throw Object.assign(Error(),{code:'unsafe_url'});}catch(error){return unknown(error.code||'unsafe_url','The page must use a registered public HTTPS origin.','problem');}
  const expectedHtml=expectedHtmlFor(input.page,input.expectedHtml);
  if(expectedHtml===null)return unknown('isolated_browser_unavailable','No committed content snapshot was supplied; the public page was not requested.');
  const marker=input.expectedMarker||input.page?.expectedMarker||'pp-landing',expectedUrls=input.expectedUrls??input.page?.expectedUrls;
  try{prepare({html:expectedHtml,expectedMarker:marker,expectedUrls,artifactDir:input.artifactDir});}catch{return unknown('browser_validation','The expected HTML, destinations or artifact directory is invalid.','problem');}
  if(chromium===undefined)chromium=defaultChromium();const executable=browserPath(chromium,executablePath);if(!chromium||!executable)return unknown('browser_unavailable','No supported Chromium executable is configured.');
  let browser,timedOut=false,rejectDeadline;const cancellation=new AbortController();
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
  let timer;
  const expire=()=>{if(timedOut)return;timedOut=true;expiredStage=stage;cancellation.abort();rejectDeadline(Error('verification_timeout'));browser?.close().catch(()=>{});};
  const arm=budget=>{clearTimeout(timer);timer=setTimeout(expire,Math.max(1,budget));};
  arm(preparationTimeout-(performance.now()-phaseStarted));
  try{return await Promise.race([deadline,(async()=>{
   const sourceTransport=typeof input.transport==='function'?input.transport:transport,assetResponses=new Map();
   // Reuse fetched bytes across baseline and public preparation; a stylesheet
   // changing between reads must not manufacture a visual difference.
   const requestTransport=(address,options)=>{if(!assetResponses.has(address))assetResponses.set(address,Promise.resolve().then(()=>sourceTransport(address,options)));return assetResponses.get(address);};
   const response=await readPublished(url.href,requestTransport,cancellation.signal);
   try{localLinkReport=buildPublishedLinkReport({actualHtml:response.text,expectedHtml,expectedMarker:marker,expectedUrls});}catch{} // Optional local evidence must not change verification.
   const comparison=comparePublishedContent(response.text,expectedHtml,{expectedMarker:marker});
   if(comparison.state!=='ok'&&input.compareVisual!==true)return {...unknown(comparison.code,comparison.evidence,comparison.state),...(comparison.linkSummary?{linkSummary:comparison.linkSummary}:{})};
   stage='public_assets';
   const prepared=await preparePublished(response,requestTransport,cancellation.signal,{onNetwork:value=>{network=value;}}),artifacts=await artifactDirectory(input.artifactDir);
   stage='baseline_assets';
   const expectedPrepared=input.compareVisual===true?await preparePublished({...response,text:expectedHtml},requestTransport,cancellation.signal):null;
   if(performance.now()-phaseStarted>=preparationTimeout)expire();
   if(timedOut)throw Error('timeout');
   clearTimeout(timer);phase='browser';phaseBudget=timeout;phaseStarted=performance.now();stage='browser_launch';arm(timeout);
   browser=await chromium.launch({executablePath:executable,headless:true,timeout,args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-domain-reliability','--no-first-run','--disable-features=MediaRouter','--host-resolver-rules=MAP * ~NOTFOUND','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
   if(timedOut){await browser.close();browser=null;throw Error('browser_timeout');}
   const results=[],visualViewports=[];
   for(const viewport of PUBLISHED_VIEWPORTS){
    stage='public_render';
    const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,javaScriptEnabled:true,serviceWorkers:'block',acceptDownloads:false,reducedMotion:'reduce',permissions:[]});
    try{
     await context.addInitScript(installNavigationProbe);
     if(expectedPrepared)await context.addInitScript(installVisualPolicyProbe);
     let served=false;
     await context.route('**/*',async route=>{
      if(!served&&route.request().isNavigationRequest()&&route.request().url()===response.url){served=true;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:prepared.headers,body:prepared.html});}
      prepared.network.deniedBrowserRequests++;return route.abort('blockedbyclient');
     });
     if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
     const tab=await context.newPage();tab.setDefaultTimeout(2000);
     await tab.goto(response.url,{waitUntil:'load',timeout:Math.min(timeout,5000)});
     if(!await tab.evaluate(()=>!!window.navigation))return unknown('navigation_interception_unavailable','This browser cannot safely observe cancelled navigation.');
     const data=await tab.evaluate(snapshot,{expectedMarker:marker});
     const result={...viewport,checks:inspect(data,expectedUrls,expectedNativeCounts(expectedHtml)),snapshot:data};
     let hidden=data.structure?data.structure.blocks.some(b=>!b.visible):data.headings.some(h=>!h.visible),structureUnknown=data.structure?.complete===false;
     if(hidden&&data.structure&&!structureUnknown){
      // Responsive navigation / intentionally collapsed blocks are not broken
      // content. Compare the exact prepared source at the SAME desktop width
      // before treating a hidden section as a publication defect.
      const baseline=expectedPrepared||await preparePublished({...response,text:expectedHtml},requestTransport,cancellation.signal);
      const original=await renderPreparedVisual(browser,{prepared:baseline,url:response.url,viewport,expectedMarker:marker,timeout,capture:(page,id)=>page.evaluate(snapshot,{expectedMarker:id})});
      const blocks=original.structure?.blocks;
      structureUnknown=baseline.network.failedAssets>0||baseline.network.blockedAssets>0||baseline.network.deniedBrowserRequests>0||!original.structure?.complete||blocks?.length!==data.structure.blocks.length;
      if(!structureUnknown)hidden=data.structure.blocks.some((b,i)=>!b.visible&&blocks[i].visible);
     }
     result.checks.push(check('required_content',structureUnknown?'unknown':hidden?'problem':'ok',structureUnknown?'Required structural coverage could not be confirmed.':hidden?'A required published section is hidden by page or theme styles.':'Required published sections match the prepared desktop visibility.'));
     const runtimeMounted=await tab.evaluate(id=>document.getElementById(id)?.getAttribute('data-pp-mounted')==='true',marker);
     result.checks.push(check('runtime',prepared.requiresRuntime?(runtimeMounted?'ok':'problem'):'not_applicable',prepared.requiresRuntime?(runtimeMounted?'The exact published PagePoster runtime mounted.':'The public policy or document prevented the required runtime from mounting.'):'No PagePoster runtime is required.'));
     if(prepared.requiresCleaner){const cleaned=await verifyCleanerRuntime(tab);result.checks.push(check('clean_links_runtime',cleaned?'ok':'problem',cleaned?'The exact Clean Links runtime removes outside dynamic destinations and preserves local and PagePoster links.':'The public policy or document prevented required Clean Links behavior.'));}
     const images=await tab.evaluate(()=>[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.width>0&&r.height>0;}).every(img=>img.complete&&img.naturalWidth>0));
     result.checks.push(check('assets',images?'ok':'unknown',images?'Visible images decoded in the browser.':'A visible image did not decode; public asset rendering is incomplete.'));
     if(expectedPrepared){
      stage='visual_compare';
      const actualVisual=await capturePublishedVisual(tab,marker),expectedVisual=await renderPreparedVisual(browser,{prepared:expectedPrepared,url:response.url,viewport,expectedMarker:marker,timeout});
      const runtimeCertain=!result.checks.some(c=>['runtime','clean_links_runtime'].includes(c.kind)&&c.state==='problem');
      const cleanerValidated=result.checks.some(c=>c.kind==='clean_links_runtime'&&c.state==='ok');
      visualViewports.push({name:viewport.name,...compareVisualViewport(expectedVisual,actualVisual,{expectedPrepared,actualPrepared:prepared,runtimeCertain,cleanerValidated})});
     }
     if(artifacts){stage='screenshot';const filename=path.join(artifacts,'pageposter-'+randomUUID()+'-'+viewport.name+'.png');await tab.screenshot({path:filename,type:'png',fullPage:false,animations:'disabled',timeout:Math.min(timeout,5000)});result.screenshot={path:filename,width:viewport.width,height:viewport.height,scope:'public-snapshot'};}
     stage='interactions';
     const interactions=await verifyInteractions(tab,viewport,{visibleOnly:true});result.checks.push(...interactions.checks.filter(c=>c.kind!=='mobile_menu'));result.clicks=interactions.clicks;results.push(result);
    }finally{stage='cleanup';await context.close();}
   }
   const visual=expectedPrepared?combineVisualViewports(visualViewports):null;
   const problem=comparison.state==='problem'||visual?.state==='problem'||results.some(v=>v.checks.some(c=>c.state==='problem'));
   const unsupported=prepared.network.untrustedScripts||prepared.network.removedHandlers||prepared.network.unsupportedDocuments;
   const assets=prepared.network.failedAssets||prepared.network.blockedAssets;
   const incomplete=visual?.state==='unknown'||results.some(v=>v.checks.some(c=>c.state==='unknown'));
   const state=problem?'problem':unsupported||assets||incomplete?'unknown':'ok';
   const code=comparison.state==='problem'?comparison.code:problem?'published_browser_problem':unsupported?'unsupported_page_scripts':assets?'published_assets_incomplete':incomplete?'published_expectations_incomplete':'published_verified';
   return {scope:'public-snapshot',state,code,evidence:state==='ok'?'Fresh public content, desktop layout, exact controls and intercepted navigation verified.':problem?'A required published-page browser check failed.':unsupported?'Arbitrary site scripts, handlers or embedded documents require an externally isolated browser runner.':'Some expected destinations or public assets could not be verified.',viewports:results,...(comparison.linkSummary?{linkSummary:comparison.linkSummary}:{}),...(visual?{visual}:{}),...diagnostics(),browserVersion:browser.version(),content:comparison,limitations:['Only the exact packaged PagePoster and origin-bound Clean Links scripts execute. Other active site content remains unverified.','Anonymous same-origin assets use DNS-pinned HTTPS. Browser page requests are denied by CSP and routing, not an OS network sandbox.','This constrained snapshot is not an OS sandbox for arbitrary website JavaScript; no partner destination was visited.']};
  })()]);}catch(error){const code=timedOut||phase==='preparation'&&error.code==='network_timeout'?(phase==='browser'?'browser_timeout':stage==='public_read'?'public_read_timeout':'public_assets_timeout'):error.code||'browser_check_failed';return unknown(code,'The constrained public browser check could not finish.');}
  finally{clearTimeout(timer);cancellation.abort();if(browser)await new Promise(resolve=>{const cleanup=setTimeout(resolve,500);browser.close().catch(()=>{}).finally(()=>{clearTimeout(cleanup);resolve();});});}
 }
 async function verifyGenerated(input){
  const prepared=prepare(input);
  if(chromium===undefined)chromium=defaultChromium();
  const executable=browserPath(chromium,executablePath);
  const unavailable=code=>({scope:'offline-generated-html',state:'unknown',layoutState:'unknown',code,viewports:[],runtime:check('runtime','unknown','Page JavaScript was not verified.'),publicPage:check('public','unknown','This is not a live WordPress check.')});
  if(!chromium||!executable)return unavailable('browser_unavailable');
  let artifacts;
  try{artifacts=await artifactDirectory(input.artifactDir);}catch{fail('browser_validation');}
  let browser,timedOut=false;
  let rejectDeadline;const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
  const timer=setTimeout(()=>{timedOut=true;rejectDeadline(Error('browser_timeout'));browser?.close().catch(()=>{});},timeout);
  try{return await Promise.race([deadline,(async()=>{
   browser=await chromium.launch({executablePath:executable,headless:true,timeout,
    args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-domain-reliability','--no-first-run','--disable-features=MediaRouter']});
   if(timedOut)throw Error('timeout');
   const results=[];let blockedRequests=0;
   for(const viewport of VIEWPORTS){
    const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,reducedMotion:'reduce',permissions:[]});
    try{
     await context.route('**/*',route=>{blockedRequests++;return route.abort('blockedbyclient');});

     const page=await context.newPage();page.setDefaultTimeout(Math.min(timeout,5000));
     await page.setContent(prepared.html,{waitUntil:'load',timeout:Math.min(timeout,5000)});
     const data=await page.evaluate(snapshot,{expectedMarker:prepared.expectedMarker});
     const result={...viewport,checks:inspect(data,prepared.expectedUrls,expectedNativeCounts(input.html)),snapshot:data};
     if(artifacts){
      const filename=path.join(artifacts,'pageposter-'+randomUUID()+'-'+viewport.name+'.png');
      const relative=path.relative(artifacts,filename);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('browser_validation');
      await page.screenshot({path:filename,type:'png',fullPage:false,animations:'disabled',timeout:Math.min(timeout,5000)});
      result.screenshot={path:filename,width:viewport.width,height:viewport.height,scope:'offline-generated-html'};
     }
     results.push(result);
    }finally{await context.close();}
   }
   const layoutState=results.some(v=>v.checks.some(c=>c.state==='problem'))?'problem':'ok';
   return {scope:'offline-generated-html',state:layoutState,layoutState,browserVersion:browser.version(),viewports:results,sanitized:prepared.sanitized,blockedRequests,
    runtime:check('runtime','unknown','Page JavaScript, duplicate-link handlers and external click destinations were not executed.'),
    publicPage:check('public','unknown','Local offline layout is not evidence of published WordPress rendering, caches or indexing.'),
    limitations:['All network requests are denied; remote images, fonts and styles are absent.','Scripts, embedded documents, event handlers, base URLs and HTTP-equiv metadata are removed.','Screenshots use the viewport only; motion is disabled.','Browser routing is defense in depth, not a network sandbox for hostile live website JavaScript.']};
  })()]);}catch{return unavailable(timedOut?'browser_timeout':'browser_check_failed');}
  finally{clearTimeout(timer);if(browser)await new Promise(resolve=>{const cleanup=setTimeout(resolve,500);browser.close().catch(()=>{}).finally(()=>{clearTimeout(cleanup);resolve();});});}
 }
 return {verifyGenerated,verifyPublished};
}
