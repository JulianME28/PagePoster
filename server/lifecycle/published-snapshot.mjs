// A constrained render of a fresh anonymous public response. Arbitrary website
// code is never executed: only byte-matching packaged PagePoster/Clean Links runtimes.
// Chromium routing is defense in depth; this is NOT an OS network sandbox.
import {JSDOM} from './dom-runtime.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {validatePublicUrl,NetworkError} from './network.mjs';
import {cleanerRuntimeHash} from './cleaner-runtime.mjs';
const require=createRequire(import.meta.url),runtime=require('../../dist/page-runtime.js'),css=require('css-tree');
// Extract our own packaged script, not user HTML. Its exact bytes are fixed by
// page-runtime.js; calculating this hash must not initialize a DOM at startup.
const trustedScript=runtime.prepare('').match(/<script data-pp-runtime="1">([\s\S]*)<\/script>$/)[1];
export const runtimeHash=createHash('sha256').update(trustedScript).digest('base64');
export async function readPublished(url,transport,signal){
 const start=validatePublicUrl(url),response=await transport(start.href,{method:'GET',sameOriginOnly:true,signal,headers:{accept:'text/html','cache-control':'no-cache'}});
 const final=validatePublicUrl(response?.url||start.href);
 if(final.origin!==start.origin||response.redirects?.some(h=>new URL(h.from).origin!==start.origin||new URL(h.to).origin!==start.origin))throw new NetworkError('cross_origin_redirect');
 if(!Number.isInteger(response?.status)||response.status<200||response.status>=300)throw new NetworkError('public_http_error');
 if(typeof response.text!=='string'||Buffer.byteLength(response.text)>1000000)throw new NetworkError('invalid_response');
 const type=Object.entries(response.headers||{}).find(([key])=>key.toLowerCase()==='content-type')?.[1];
 if(type&&!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(String(type)))throw new NetworkError('invalid_response');
 return {...response,url:final.href};
}
export async function preparePublished(response,transport,signal,{onNetwork}={}){
 const dom=new JSDOM(response.text),d=dom.window.document,origin=new URL(response.url).origin;
 const network={fetchedAssets:0,blockedAssets:0,failedAssets:0,untrustedScripts:0,removedHandlers:0,unsupportedDocuments:0,deniedBrowserRequests:0};
 onNetwork?.(network);
 const assetCache=new Map();let totalBytes=Buffer.byteLength(response.text);
 // Only transport reads occupy slots. CSS imports may recursively resolve
 // other assets without holding a slot or deadlocking the four-read queue.
 const queued=[];let activeReads=0;
 const abortQueued=()=>{for(const task of queued.splice(0))task.reject(new NetworkError('network_timeout'));};
 function pump(){
  if(signal?.aborted){abortQueued();return;}
  while(activeReads<4&&queued.length){const task=queued.shift();activeReads++;
   Promise.resolve().then(()=>{if(signal?.aborted)throw new NetworkError('network_timeout');return task.read();}).then(task.resolve,task.reject).finally(()=>{activeReads--;pump();});
  }
 }
 const readAsset=read=>new Promise((resolve,reject)=>{queued.push({read,resolve,reject});pump();});
 signal?.addEventListener('abort',abortQueued,{once:true});
 try{
  if(d.querySelectorAll('*').length>30000||d.querySelectorAll('a[href],[data-pp-url]').length>1000)throw new NetworkError('browser_validation');
  let base=response.url;const baseTag=d.querySelector('base[href]');
  if(baseTag){try{base=new URL(baseTag.getAttribute('href'),base).href;}catch{}baseTag.remove();}
  // HTML import already supports these exact Google Fonts stylesheet endpoints.
  // Resolve their font files into data URLs with the same pinned read transport;
  // arbitrary external styles, images, scripts and destinations remain blocked.
  const fontAsset=(address,type)=>!address.port&&!address.hash&&(type==='css'&&address.hostname==='fonts.googleapis.com'&&/^\/css2?$/.test(address.pathname)||type==='binary'&&address.hostname==='fonts.gstatic.com'&&!address.search&&/^\/s\/[A-Za-z0-9/_-]+\.(?:woff2?|ttf|otf)$/.test(address.pathname));
  const assetAddress=(raw,type)=>{const address=validatePublicUrl(new URL(raw,base).href);if(address.origin!==origin&&!fontAsset(address,type))throw new NetworkError('cross_origin_redirect');return address;};
  async function asset(raw,type){
   if(signal?.aborted)throw new NetworkError('network_timeout');
   if(raw.startsWith('data:'))return raw;
   let address;try{address=assetAddress(raw,type);}catch{network.blockedAssets++;return null;}
   if(assetCache.has(address.href))return assetCache.get(address.href);
   if(assetCache.size>=80){network.blockedAssets++;return null;}
   const pending=(async()=>{
    try{
     const r=await readAsset(()=>transport(address.href,{method:'GET',sameOriginOnly:true,signal,headers:{accept:type==='css'?'text/css':'image/*,font/*;q=0.9','cache-control':'no-cache'}}));
     if(r.status<200||r.status>=300||validatePublicUrl(r.url||address.href).origin!==address.origin||r.redirects?.some(h=>new URL(h.from).origin!==address.origin||new URL(h.to).origin!==address.origin))throw new Error();
     const contentType=String(Object.entries(r.headers||{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]||'').split(';')[0].trim().toLowerCase();
     const body=Buffer.isBuffer(r.body)?r.body:typeof r.text==='string'?Buffer.from(r.text):null;
     if(!body||(totalBytes+=body.length)>8*1024*1024)throw new Error();
     network.fetchedAssets++;
     if(type==='css'){if(contentType!=='text/css')throw new Error();return {text:body.toString('utf8'),url:r.url||address.href};}
     if(!/^(?:image\/(?:png|jpeg|webp|gif|avif)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|vnd.ms-fontobject))$/.test(contentType)||address.origin!==origin&&!/^(?:font\/|application\/(?:font-woff|vnd.ms-fontobject))/.test(contentType)||!Buffer.isBuffer(r.body))throw new Error();
     return 'data:'+contentType+';base64,'+body.toString('base64');
    }catch{network.failedAssets++;return null;}
   })();assetCache.set(address.href,pending);return pending;
  }
  async function stylesheet(value,address,ancestors=[]){
   let tree;try{tree=css.parse(value);}catch{network.failedAssets++;return '';}
   const imports=[],urls=[];
   css.walk(tree,{enter(node,item,list){if(node.type==='Atrule'&&node.name.toLowerCase()==='import'){imports.push({node,item,list});return css.walk.skip;}else if(node.type==='Url')urls.push(node);}});
   await Promise.all(imports.map(async entry=>{
    const parts=entry.node.prelude?.children?.toArray()||[],source=parts[0],media=parts[1];
    if(!source||!['Url','String'].includes(source.type)||parts.length>2||(media&&media.type!=='MediaQueryList')||ancestors.length>=4){entry.list.remove(entry.item);network.blockedAssets++;return;}
    let target;try{target=new URL(source.value,address).href;}catch{entry.list.remove(entry.item);network.blockedAssets++;return;}
    if(ancestors.includes(target)){entry.list.remove(entry.item);network.blockedAssets++;return;}
    const loaded=await asset(target,'css');
    if(!loaded||typeof loaded!=='object'){entry.list.remove(entry.item);return;}
    const rules=await stylesheet(loaded.text,loaded.url,[...ancestors,target]);
    entry.item.data={type:'Raw',value:media?'@media '+css.generate(media)+'{'+rules+'}':rules};
   }));
   await Promise.all(urls.map(async node=>{if(node.value.startsWith('#')||node.value.startsWith('data:'))return;let addressValue;try{addressValue=new URL(node.value,address).href;}catch{network.blockedAssets++;node.value='data:,';return;}node.value=await asset(addressValue,'binary')||'data:,';}));
   return css.generate(tree);
  }
  const cleanerHashes=[];
  for(const s of [...d.querySelectorAll('script')]){
   const kind=(s.getAttribute('type')||'').toLowerCase();
   if(!s.src&&s.hasAttribute('data-pp-runtime')&&s.textContent===trustedScript){continue;}
   const cleaner=!s.hasAttribute('src')&&s.id==='pageposter-clean-links-runtime'&&['','text/javascript','application/javascript'].includes(kind)&&cleanerRuntimeHash(s.textContent,response.url);
   if(cleaner){cleanerHashes.push(cleaner);continue;}
   if(s.id==='pageposter-clean-links-runtime'||!['application/ld+json','application/json'].includes(kind))network.untrustedScripts++;
   s.remove();
  }
  for(const node of d.querySelectorAll('iframe,frame,frameset,object,embed')){network.unsupportedDocuments++;node.remove();}
  for(const node of d.querySelectorAll('base,meta[http-equiv]')){if(node.localName==='meta'&&node.getAttribute('http-equiv')?.toLowerCase()==='content-security-policy')continue;if(node.localName==='meta')network.unsupportedDocuments++;node.remove();}
  for(const node of d.querySelectorAll('*'))for(const attr of [...node.attributes]){
   if(/^on/i.test(attr.name)){network.removedHandlers++;node.removeAttribute(attr.name);}
   if(['ping','srcdoc','integrity','autofocus'].includes(attr.name))node.removeAttribute(attr.name);
  }
  // Replace nodes in their original positions, independently of completion
  // order. Capture original styles before stylesheet links become style nodes.
  const originalStyles=[...d.querySelectorAll('style')];
  await Promise.all([
  ...[...d.querySelectorAll('link')].map(async link=>{
   if((link.getAttribute('rel')||'').toLowerCase().split(/\s+/).includes('stylesheet')&&link.getAttribute('href')){
    const loaded=await asset(link.getAttribute('href'),'css');
    if(loaded&&typeof loaded==='object'){const style=d.createElement('style');style.textContent=await stylesheet(loaded.text,loaded.url);if(link.hasAttribute('media'))style.setAttribute('media',link.getAttribute('media'));link.replaceWith(style);return;}
    if(loaded)network.blockedAssets++;
   }
   link.remove();
  }),
  ...originalStyles.map(async style=>{style.textContent=await stylesheet(style.textContent,base);}),
  ...[...d.querySelectorAll('[style]')].map(async node=>{
   const rules=await stylesheet('x{'+node.getAttribute('style')+'}',base);node.setAttribute('style',rules.slice(rules.indexOf('{')+1,-1));
  }),
  ...[...d.querySelectorAll('img')].map(async node=>{
   if(node.hasAttribute('srcset')){network.blockedAssets++;node.removeAttribute('srcset');}
   if(node.hasAttribute('src'))node.setAttribute('src',await asset(node.getAttribute('src'),'binary')||'data:,');
   node.removeAttribute('loading');
  })]);
  if(signal?.aborted)throw new NetworkError('network_timeout');
  for(const node of d.querySelectorAll('video,audio,source,track,input[type="image"]')){if(node.hasAttribute('src')||node.hasAttribute('srcset')||node.hasAttribute('poster'))network.blockedAssets++;node.removeAttribute('src');node.removeAttribute('srcset');node.removeAttribute('poster');}
  const policy=d.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; script-src "+[runtimeHash,...new Set(cleanerHashes)].map(hash=>"'sha256-"+hash+"'").join(' ')+"; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  d.head.prepend(policy);
  const motion=d.createElement('style');motion.textContent='*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';d.head.append(motion);
  return {html:dom.serialize(),network,requiresRuntime:!!d.querySelector('script[data-pp-runtime]'),requiresCleaner:cleanerHashes.length>0,headers:Object.fromEntries(Object.entries(response.headers||{}).filter(([name])=>name.toLowerCase()==='content-security-policy').map(([name,value])=>[name,Array.isArray(value)?value.join(', '):String(value)]))};
 }finally{signal?.removeEventListener('abort',abortQueued);dom.window.close();}
}
// Runs before the trusted page scripts. Navigation attempts are observed and
// cancelled before network; the original exact href/data attribute is compared
// separately, since browser URLs can be canonically encoded.
export function installNavigationProbe(){
 const destinations=[];Object.defineProperty(window,'__ppVerificationDestinations',{value:destinations});
 Object.defineProperty(window,'open',{value:function(value){destinations.push(String(value));return null;},writable:false,configurable:false});
 if(window.navigation)window.navigation.addEventListener('navigate',event=>{
  if(event.destination.url.split('#')[0]===location.href.split('#')[0])return;
  destinations.push(event.destination.url);if(event.cancelable)event.preventDefault();
 });
 document.addEventListener('submit',event=>event.preventDefault(),true);
 document.addEventListener('click',event=>{
  const link=event.target?.closest?.('a[href]');
  if(event.defaultPrevented||!link||link.hasAttribute('data-pp-url'))return;
  const literal=link.getAttribute('href')||'';
  if(!/^https?:\/\//i.test(literal))return;
  event.preventDefault();destinations.push(link.href);
 });
}
export async function verifyInteractions(page,viewport,{visibleOnly=false}={}){
 const checks=[],clicks=[],menu=page.locator('.pp-mobile-nav').first();
 if(viewport.name==='mobile'&&await menu.count()){
  let ok=false;
  try{
   const summary=menu.locator('summary').first();await summary.click({timeout:1500});
   const links=menu.locator('a[href^="#"]'),count=await links.count();
   ok=await menu.evaluate(n=>n.open)&&count>0;
   for(let i=0;i<count;i++){
    if(i){await summary.click({timeout:1500});}
    const link=links.nth(i),hash=await link.getAttribute('href');await link.click({timeout:1500});
    const target=await page.evaluate(hash=>{try{const n=document.getElementById(decodeURIComponent(hash.slice(1)));if(!n)return false;const b=n.getBoundingClientRect();return b.width>0&&b.height>0&&b.bottom>0&&b.top<innerHeight;}catch{return false;}},hash);
    ok=ok&&target&&await menu.evaluate(n=>!n.open);
   }
  }catch{ok=false;}
  checks.push({kind:'mobile_menu',state:ok?'ok':'problem',evidence:ok?'The mobile menu opens, each item reaches its visible target, and the menu closes.':'The mobile menu could not open, reach each visible target, or close after selection.'});
 }else checks.push({kind:'mobile_menu',state:'not_applicable',evidence:'No mobile menu is required at this viewport.'});
 const controls=page.locator('#pp-landing a[href],#pp-landing [data-pp-url]');
 const total=await controls.count();
 for(let i=0;i<total;i++){
  const node=controls.nth(i);
  if(visibleOnly&&!await node.evaluate(n=>{
   const box=n.getBoundingClientRect();if(box.width<=0||box.height<=0||['hidden','collapse'].includes(getComputedStyle(n).visibility))return false;
   for(let parent=n;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||Number(style.opacity)===0)return false;}
   return true;
  }))continue;
  const values=await node.evaluate(n=>({literal:n.getAttribute('data-pp-url')||n.getAttribute('href')||'',anchor:(n.textContent||'').trim(),role:n.getAttribute('data-pp-role')||(n.closest('.pp-brand')?(n.closest('footer')?'brand-footer':n.closest('header')?'brand-header':'brand'):n.closest('.pp-logo')?'offer-logo':n.matches('.pp-cta')?'offer-cta':'article-link')}));
  if(!/^https?:\/\//i.test(values.literal))continue;
  const entry={...values,state:'problem',destination:null};
  try{
   await page.evaluate(()=>{window.__ppVerificationDestinations.length=0;});
   await node.click({timeout:1500});
   const destinations=await page.evaluate(()=>window.__ppVerificationDestinations.slice());
   entry.destination=destinations[0]||null;
   entry.state=destinations.length===1&&entry.destination===new URL(values.literal).href?'ok':'problem';
  }catch{}
  clicks.push(entry);
 }
 checks.push({kind:'clicks',state:clicks.every(c=>c.state==='ok')?'ok':'problem',evidence:'Activated '+clicks.length+' controls; destinations were intercepted without partner navigation. '+clicks.filter(c=>c.state!=='ok').length+' failed.'});
 return {checks,clicks};
}
