// Computed rendering comparison for the explicitly requested fallback check.
// These fixed automation functions never evaluate source-page JavaScript.
import {installNavigationProbe} from './published-snapshot.mjs';
import {normalizePublishedProse} from './published-content.mjs';

export function unknownVisual(code){return {state:'unknown',code,viewports:[]};}

export function installVisualPolicyProbe(){
 const policy={blockedPaint:false};Object.defineProperty(window,'__ppVisualPolicy',{value:policy});
 document.addEventListener('securitypolicyviolation',event=>{
  if(event.disposition==='enforce'&&/^(?:style|font|img)-src(?:-|$)/.test(event.effectiveDirective))policy.blockedPaint=true;
 });
}

function visualSnapshot({expectedMarker}){
 const roots=[...document.querySelectorAll('[id]')].filter(n=>n.id===expectedMarker),root=roots[0];
 if(roots.length!==1)return {rootCount:roots.length,samples:[]};
 const rect=n=>({x:n.x,y:n.y,width:n.width,height:n.height,right:n.right,bottom:n.bottom});
 const rootBox=root.getBoundingClientRect(),samples=[],candidates=[],critical=new Set(),groups=new Map();
 const MAX_TEXT=20000,MAX_SCAN=50000,MAX_SAMPLES=512;
 const styles=new WeakMap(),boxes=new WeakMap();
 const computed=n=>{if(!styles.has(n))styles.set(n,getComputedStyle(n));return styles.get(n);};
 const bounds=n=>{if(!boxes.has(n))boxes.set(n,n.getBoundingClientRect());return boxes.get(n);};
 // Overflow does not clip an out-of-flow descendant between that descendant
 // and its containing block (CSS2 §11.1.1 / CSS Positioned Layout §2.1).
 // In particular, a viewport-fixed canvas escapes a static, zero-height body.
 // A transformed/contained ancestor establishes a real fixed containing block
 // and MUST keep clipping; blanket zero-height exceptions would hide defects.
 const fixedContainer=s=>s.transform!=='none'||s.perspective!=='none'||s.filter!=='none'||s.backdropFilter&&s.backdropFilter!=='none'||/(?:layout|paint|strict|content)/.test(s.contain)||s.contentVisibility==='auto'||/(?:transform|perspective|filter|contain)/.test(s.willChange);
 const escapes=new WeakMap();
 const escapedClips=element=>{
  if(escapes.has(element))return escapes.get(element);
  const skipped=new Set();
  for(let positioned=element;positioned;positioned=positioned.parentElement){
   const position=computed(positioned).position;if(position!=='fixed'&&position!=='absolute')continue;
   let container=positioned.parentElement;
   while(container){const s=computed(container);if(fixedContainer(s)||position==='absolute'&&s.position!=='static')break;container=container.parentElement;}
   for(let n=positioned.parentElement;n&&n!==container;n=n.parentElement)skipped.add(n);
  }
  escapes.set(element,skipped);return skipped;
 };
 const rgba=value=>{const m=value.match(/^rgba?\(([^)]+)\)$/);if(!m)return null;const p=m[1].split(/[\s,\/]+/).map(Number);return p.length>=3&&p.every(Number.isFinite)?[p[0],p[1],p[2],p[3]??1]:null;};
 const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node,scanned=0,truncated=false;
 while((node=walker.nextNode())){
  if(++scanned>MAX_SCAN||candidates.length>=MAX_TEXT){truncated=true;break;}
  const text=(node.nodeValue||'').replace(/\s+/g,' ').trim(),element=node.parentElement;
  if(!text||!element||element.closest('script,style,template,noscript'))continue;
  const index=candidates.length;candidates.push({node,text,element});
  for(let n=element;n&&n!==root;n=n.parentElement)if(n.matches('h1,h2,h3,h4,h5,h6,caption,th,td,summary,details,footer')){
   const group=groups.get(n);if(group)group.last=index;else groups.set(n,{first:index,last:index});
  }
 }
 for(const {first,last} of groups.values()){critical.add(first);critical.add(last);}
 const selected=new Set();
 const spread=(values,limit)=>{for(let i=0;i<Math.min(limit,values.length);i++)selected.add(values[Math.round(i*(values.length-1)/Math.max(1,Math.min(limit,values.length)-1))]);};
 if(critical.size>MAX_SAMPLES){truncated=true;spread([...critical].sort((a,b)=>a-b),MAX_SAMPLES);}
 else{for(const index of critical)selected.add(index);spread(candidates.map((_,i)=>i).filter(i=>!selected.has(i)),MAX_SAMPLES-selected.size);}
 const paint=[];
 // Typography/geometry use bounded distributed representatives, but readable
 // text is checked for EVERY scanned node. Sampling alone must never make an
 // unsampled paragraph/list/div disappear behind a successful visual result.
 for(let index=0;index<candidates.length;index++){
  const {node,text,element}=candidates[index];
  const range=document.createRange();range.selectNodeContents(node);const box=range.getBoundingClientRect(),style=computed(element),escaped=escapedClips(element);
  let visible=box.width>0&&box.height>0&&!['hidden','collapse'].includes(style.visibility),opacity=1,clip={left:box.left,top:box.top,right:box.right,bottom:box.bottom},background=null,backgroundImage=false;const backgroundLayers=[];
  for(let parent=element;parent;parent=parent.parentElement){
   const s=computed(parent),b=bounds(parent);opacity*=Number(s.opacity);
   if(s.display==='none'||s.contentVisibility==='hidden')visible=false;
   if(!background){const color=rgba(s.backgroundColor);if(s.backgroundImage!=='none')backgroundImage=true;if(color&&color[3]>0)backgroundLayers.push(color);if(color&&color[3]>.98)background=color;}
   if(!escaped.has(parent)&&['hidden','clip'].includes(s.overflowX)){clip.left=Math.max(clip.left,b.left);clip.right=Math.min(clip.right,b.right);}
   if(!escaped.has(parent)&&['hidden','clip'].includes(s.overflowY)){clip.top=Math.max(clip.top,b.top);clip.bottom=Math.min(clip.bottom,b.bottom);}
  }
  if(opacity<.03)visible=false;
  const foreground=rgba(style.color),bg=backgroundLayers.reduceRight((below,color)=>color.slice(0,3).map((c,i)=>c*color[3]+below[i]*(1-color[3])),[255,255,255]);let contrast=null;
  if(foreground&&foreground[3]*opacity<.03)visible=false;
  if(foreground&&!backgroundImage&&opacity>.98){const alpha=foreground[3],color=foreground.slice(0,3).map((c,i)=>c*alpha+bg[i]*(1-alpha)),a=luminance(color),b=luminance(bg);contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
  const area=box.width*box.height,clipped=area>0?Math.max(0,clip.right-clip.left)*Math.max(0,clip.bottom-clip.top)/area:0;
  paint.push((visible?1:0)|(clipped>.8?2:0)|(contrast>2?4:0)|(contrast!==null&&contrast<1.15?8:0)|(clipped<.35?16:0));
  if(!selected.has(index))continue;
  samples.push({text:text.slice(0,1000),heading:!!element.closest('h1,h2,h3,h4,h5,h6'),critical:critical.has(index),visible,clipped,contrast,fontSize:parseFloat(style.fontSize),fontFamily:style.fontFamily,fontWeight:style.fontWeight,color:style.color,lineHeight:parseFloat(style.lineHeight)||null,box:{...rect(box),x:box.x-rootBox.x,y:box.y-rootBox.y}});
 }
 return {rootCount:1,box:rect(rootBox),scrollWidth:root.scrollWidth,viewportWidth:innerWidth,samples,
  paint,
  coverage:{complete:!truncated,textNodes:candidates.length,sampledNodes:samples.length,criticalNodes:critical.size,requiredBlocks:groups.size},
  mounted:root.getAttribute('data-pp-mounted')==='true',
  assetsComplete:!window.__ppVisualPolicy?.blockedPaint&&[...document.images].every(img=>{const r=img.getBoundingClientRect();return !r.width||!r.height||img.complete&&img.naturalWidth>0;})&&![...document.fonts].some(font=>font.status==='error')};
}

export async function capturePublishedVisual(page,expectedMarker){
 await page.evaluate(async()=>{await document.fonts.ready;});
 return page.evaluate(visualSnapshot,{expectedMarker});
}

// The baseline receives the exact same prepared-asset resolver, response CSP,
// trusted runtime hashes and denied browser network as the public snapshot.
export async function renderPreparedVisual(browser,{prepared,url,viewport,expectedMarker,timeout,capture=capturePublishedVisual}){
 const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,javaScriptEnabled:true,serviceWorkers:'block',acceptDownloads:false,reducedMotion:'reduce',permissions:[]});
 try{
  await context.addInitScript(installNavigationProbe);await context.addInitScript(installVisualPolicyProbe);let served=false;
  await context.route('**/*',route=>{
   if(!served&&route.request().isNavigationRequest()&&route.request().url()===url){served=true;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:prepared.headers,body:prepared.html});}
   prepared.network.deniedBrowserRequests++;return route.abort('blockedbyclient');
  });
  if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
  const page=await context.newPage();await page.goto(url,{waitUntil:'load',timeout:Math.min(timeout,5000)});
  return await capture(page,expectedMarker);
 }finally{await context.close();}
}

export function compareVisualViewport(expected,actual,{expectedPrepared,actualPrepared,runtimeCertain=true,cleanerValidated=false}={}){
 const result=(state,code)=>({state,code});
 const networks=[expectedPrepared?.network,actualPrepared?.network].filter(Boolean);
 if(networks.some(n=>n.untrustedScripts||n.removedHandlers||n.unsupportedDocuments))return result('unknown','visual_scripts_unverified');
 if(networks.some(n=>n.failedAssets||n.blockedAssets||n.deniedBrowserRequests)||expected.assetsComplete===false||actual.assetsComplete===false)return result('unknown','visual_assets_incomplete');
 if(!runtimeCertain||(expectedPrepared?.requiresRuntime&&!expected.mounted)||(actualPrepared?.requiresRuntime&&!actual.mounted)||expectedPrepared?.requiresRuntime!==actualPrepared?.requiresRuntime||(expectedPrepared?.requiresCleaner&&!actualPrepared?.requiresCleaner)||(actualPrepared?.requiresCleaner&&!cleanerValidated))return result('unknown','visual_runtime_unverified');
 if(expected.rootCount!==1||actual.rootCount!==1||!expected.samples?.length)return result('unknown','visual_baseline_unavailable');
 if(expected.coverage?.complete===false||actual.coverage?.complete===false)return result('unknown','visual_coverage_incomplete');
 // Pair only the same visible source text. Link attributes, robots policy,
 // navigation targets and click behavior are separate checks.
 if(expected.samples.length!==actual.samples.length||expected.samples.some((sample,i)=>normalizePublishedProse(sample.text)!==normalizePublishedProse(actual.samples[i].text)))return result('unknown','visual_content_unmatched');
 if(expected.paint&&actual.paint){
  if(expected.paint.length!==actual.paint.length)return result('unknown','visual_content_unmatched');
  if(expected.paint.some((e,i)=>(e&3)===3&&(!(actual.paint[i]&1)||(e&4)&&(actual.paint[i]&8))))return result('problem','visual_content_hidden');
  if(expected.paint.some((e,i)=>(e&3)===3&&(actual.paint[i]&16)))return result('problem','visual_content_clipped');
 }
 const pairs=expected.samples.map((sample,i)=>[sample,actual.samples[i]]).filter(([sample])=>sample.visible&&sample.clipped>.8);
 if(!pairs.length)return result('unknown','visual_baseline_unavailable');
 const weight=pairs.reduce((sum,[e])=>sum+Math.max(1,e.text.length),0),changed=predicate=>pairs.reduce((sum,[e,a])=>sum+(predicate(e,a)?Math.max(1,e.text.length):0),0)/weight;
 const important=predicate=>pairs.some(([e,a])=>(e.heading||e.critical)&&predicate(e,a))||changed(predicate)>.3;
 if(important((e,a)=>!a.visible||e.contrast>2&&a.contrast!==null&&a.contrast<1.15))return result('problem','visual_content_hidden');
 if(important((e,a)=>a.clipped<.35))return result('problem','visual_content_clipped');
 const typography=(e,a)=>Math.abs(e.fontSize-a.fontSize)>=Math.max(3,e.fontSize*.2)||e.lineHeight&&a.lineHeight&&Math.abs(e.lineHeight-a.lineHeight)>Math.max(6,e.lineHeight*.4);
 if(important(typography))return result('problem','visual_typography_changed');
 const width=Math.abs(expected.box.width-actual.box.width),overflow=actual.scrollWidth>actual.viewportWidth+Math.max(32,actual.viewportWidth*.1)&&expected.scrollWidth<=expected.viewportWidth+8;
 const displaced=changed((e,a)=>Math.abs(e.box.x-a.box.x)>Math.max(64,expected.box.width*.25)||Math.abs(e.box.y-a.box.y)>Math.max(96,expected.box.height*.4))>.5;
 const metrics=changed((e,a)=>e.fontFamily!==a.fontFamily&&Math.abs(e.box.width-a.box.width)>Math.max(24,e.box.width*.25))>.6;
 if(width>Math.max(48,expected.box.width*.25)||overflow||displaced||metrics)return result('problem','visual_layout_changed');
 return result('ok','visual_verified');
}

export function combineVisualViewports(viewports){
 if(viewports.length!==1||viewports[0].name!=='desktop'||!['ok','problem','unknown'].includes(viewports[0].state))return unknownVisual('visual_viewports_incomplete');
 const uncertain=viewports.find(v=>v.state==='unknown'),problem=viewports.find(v=>v.state==='problem');
 return {state:uncertain?'unknown':problem?'problem':'ok',code:uncertain?.code||problem?.code||'visual_verified',viewports};
}
