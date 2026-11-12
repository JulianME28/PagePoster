// Read-only comparisons of the committed HTML with the published response.
// Parsing is inert: no script execution, resource loading, or user URL fetching.
import {JSDOM} from './dom-runtime.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const generator=require('../../dist/generator.js');
const cssTree=require('css-tree');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
// WordPress can typographically rewrite apostrophes in prose on public output.
// Keep anchors, URLs, attributes, styles and scripts on their exact contracts.
export const normalizePublishedProse=value=>normalize(value).replace(/(\p{L})\u2019(?=\p{L})/gu,"$1'");
export function expectedHtmlFor(page={},explicit){
 if(typeof explicit==='string')return explicit;
 if(typeof page.remoteSnapshot?.content==='string')return page.remoteSnapshot.content;
 if(typeof page.expectedHtml==='string')return page.expectedHtml;
 if(plain(page.config)&&Object.keys(page.config).length){try{return generator.renderSnippet(page.config);}catch{return null;}}
 return null;
}
function marker(document,id){return [...document.querySelectorAll('[id]')].filter(node=>node.id===id);}
function text(root){
 const walker=root.ownerDocument.createTreeWalker(root,4);const parts=[];let node;
 while((node=walker.nextNode()))if(!node.parentElement?.closest('script,style,template,noscript'))parts.push(node.nodeValue);
 return normalizePublishedProse(parts.join(' '));
}
function role(node){
 if(node.matches('[data-pp-role]'))return node.getAttribute('data-pp-role');
 if(node.closest('.pp-brand'))return node.closest('footer')?'brand-footer':node.closest('header')?'brand-header':'brand';
 if(node.closest('.pp-logo'))return 'offer-logo';
 if(node.matches('.pp-cta'))return 'offer-cta';
 return 'article-link';
}
export function controlContract(root){
 return [...root.querySelectorAll('a[href],[data-pp-url]')].map(node=>({
  tag:node.localName,href:node.getAttribute('href'),url:node.getAttribute('data-pp-url'),
  anchor:(node.textContent||'').trim(),label:node.getAttribute('aria-label')||'',
  image:[...node.querySelectorAll('img')].map(img=>({src:img.getAttribute('src'),alt:img.getAttribute('alt')||''})),
  role:role(node),target:node.getAttribute('data-pp-target')||node.getAttribute('target')||'_self'
 }));
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function linkSummary(root,document,expected){
 const valid=value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
 const controls=nodes=>[...nodes].flatMap(n=>[n.getAttribute('href'),n.getAttribute('data-pp-url')].filter(v=>v&&valid(v)));
 const nodes=[...root.querySelectorAll('a[href],[data-pp-url]')],our=new Set(controls(nodes));
 const outside=new Set(controls([...document.querySelectorAll('a[href],[data-pp-url]')].filter(n=>!root.contains(n))));
 const expectedUrls=new Set(controls(expected.querySelectorAll('a[href],[data-pp-url]')));
 return {expectedUrls:expectedUrls.size,ourUrls:our.size,nativeHrefs:nodes.filter(n=>n.matches('a[href]')&&valid(n.getAttribute('href'))).length,repeatedControls:nodes.filter(n=>valid(n.getAttribute('data-pp-url'))).length,outsideUrls:outside.size,unexpectedOurUrls:[...our].filter(v=>!expectedUrls.has(v)).length};
}
function styleCode(value){try{return cssTree.generate(cssTree.parse(value));}catch{return normalize(value);}}
export function comparePublishedContent(actualHtml,expectedHtml,{expectedMarker='pp-landing'}={}){
 if(typeof expectedHtml!=='string'||!expectedHtml.trim())return {state:'unknown',code:'expected_content_missing',linksState:'unknown',evidence:'No committed content snapshot is available.'};
 const expected=new JSDOM(expectedHtml),actual=new JSDOM(actualHtml);
 try{
  const e=expected.window.document,a=actual.window.document,id=String(expectedMarker||'pp-landing').replace(/^#/,'');
  const expectedRoots=marker(e,id),actualRoots=marker(a,id);
  // Imported pages without the PagePoster wrapper compare their body. Generated
  // pages always require exactly one matching wrapper, including duplicates.
  const wrapped=expectedRoots.length>0;
  if(wrapped&&(expectedRoots.length!==1||actualRoots.length!==1))return {state:'problem',code:'content_mismatch',linksState:'problem',evidence:'The committed page wrapper is missing or duplicated.'};
  const er=wrapped?expectedRoots[0]:e.body,ar=wrapped?actualRoots[0]:a.body;
  const issues=[];
  if(text(er)!==text(ar))issues.push('visible text differs (possible stale public cache)');
  const semantics=root=>[...root.querySelectorAll('h1,h2,h3,h4,h5,h6,img,details,summary')].map(n=>({tag:n.localName,text:/^h[1-6]$|summary/.test(n.localName)?normalizePublishedProse(n.textContent):'',...(n.localName==='img'?{src:n.getAttribute('src'),alt:n.getAttribute('alt')||''}:{})}));
  if(!same(semantics(er),semantics(ar)))issues.push('required headings, images or menu structure differ');
  const structure=root=>[...root.querySelectorAll('table,caption,thead,tbody,tfoot,tr,th,td,footer')].map(n=>({tag:n.localName,text:normalizePublishedProse(n.textContent),...(n.matches('th,td')?{colspan:n.getAttribute('colspan')||'1',rowspan:n.getAttribute('rowspan')||'1',scope:n.getAttribute('scope')||'',headers:n.getAttribute('headers')||''}:{})}));
  if(!same(structure(er),structure(ar)))issues.push('required table cells or footer structure differ');
  const ec=controlContract(er),ac=controlContract(ar),linksState=same(ec,ac)?'ok':'problem';
  if(linksState==='problem')issues.push('exact anchors, destinations, roles or repeated controls differ');
  const scripts=d=>[...d.querySelectorAll('script')].map(s=>({src:s.getAttribute('src'),type:s.getAttribute('type')||'',code:s.textContent.trim()}));
  const availableScripts=scripts(a);
  if(scripts(e).some(s=>!availableScripts.some(t=>same(s,t))))issues.push('a required runtime script is missing or changed');
  const availableStyles=[...a.querySelectorAll('style')].map(n=>styleCode(n.textContent));
  if([...e.querySelectorAll('style')].some(n=>!availableStyles.includes(styleCode(n.textContent))))issues.push('a required page stylesheet is missing or changed');
  return {state:issues.length?'problem':'ok',code:issues.length?'content_mismatch':'content_verified',linksState,linkSummary:linkSummary(ar,a,er),expectedControls:ec,actualControls:ac,evidence:issues.length?'Published content mismatch: '+issues.join('; ')+'.':'Published text, required blocks, exact anchors, link roles, controls, styles and runtime match the committed HTML.'};
 }finally{expected.window.close();actual.window.close();}
}
