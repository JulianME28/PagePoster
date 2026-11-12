import {createHash} from 'node:crypto';
import {JSDOM} from './dom-runtime.mjs';
import Runtime from '../../dist/page-runtime.js';
const trustedRuntimeText=Runtime.prepare('').match(/<script data-pp-runtime="1">([\s\S]*)<\/script>$/)[1];
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
function validUrl(value){if(typeof value!=='string'||value.length>4000||!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f]/.test(value))return false;try{const u=new URL(value);return !!u.hostname&&!u.username&&!u.password;}catch{return false;}}
const escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parse(html){
 if(typeof html!=='string'||!html.trim()||!html.isWellFormed()||html.includes('\0')||Buffer.byteLength(html)>1000000)fail('VALIDATION');
 const dom=new JSDOM(html,{includeNodeLocations:true}),document=dom.window.document;
 try{
  const roots=document.querySelectorAll('[id="pp-landing"],[id="pp-universal-pl"]');if(roots.length!==1||roots[0].localName!=='div'||!dom.nodeLocation(roots[0]))fail('IMPORT_UNMARKED');
  const root=roots[0],sourceHash=hash(html),placements=[],bindings=new Map(),warnings=[];
  for(const node of root.querySelectorAll('[href],[data-pp-url]')){
   const attribute=node.hasAttribute('data-pp-url')?'data-pp-url':'href';
   if(attribute==='href'&&node.localName!=='a')continue;
   const url=node.getAttribute(attribute);if(!validUrl(url))continue;
   const loc=dom.nodeLocation(node),attr=loc?.attrs?.[attribute];if(!loc?.startTag||!attr)fail('IMPORT_AMBIGUOUS');
   const tag=html.slice(loc.startTag.startOffset,loc.startTag.endOffset),attributes=[...tag.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)].slice(1).map(x=>x[1].toLowerCase());
   if(attributes.filter(x=>x===attribute).length!==1||node.hasAttribute('href')&&node.hasAttribute('data-pp-url')||attributes.some(name=>/^on/i.test(name)))fail('IMPORT_AMBIGUOUS');
   const raw=html.slice(attr.startOffset,attr.endOffset),match=/^([^=]+?\s*=\s*)(?:(["'])([\s\S]*)\2|([^\s]+))$/.exec(raw);if(!match)fail('IMPORT_AMBIGUOUS');
   const id='exact:'+hash(sourceHash+':'+loc.startOffset+':'+attribute).slice(0,32),anchor=node.textContent,anchorEditable=node.children.length===0&&!!loc.endTag;
   const role=node.closest('header')?'brand-header':node.closest('footer')?'brand-footer':node.querySelector('img')?'offer-logo':/(?:^|\s)(?:pp-cta|cta|button|btn)(?:\s|$)/.test(node.className)||node.localName==='button'?'offer-cta':'article-link';
   placements.push({id,path:'exactImport.html',label:'HTML: '+(anchor.trim()||node.getAttribute('aria-label')||'Посилання'),role,url,anchor,attribute,source:'exact-import',anchorEditable});
   bindings.set(id,{attr,loc,prefix:match[1],quote:match[2]||'"',tag:node.localName,attributes:Object.fromEntries([...node.attributes].map(a=>[a.name,a.value]))});
  }
  if(root.querySelector('[onclick]'))warnings.push('Переходи з довільними обробниками onclick не включені до точкової заміни.');
  if(document.querySelector('script:not([data-pp-runtime])'))warnings.push('Власні скрипти збережено; динамічні переходи потребують окремої перевірки.');
  const scripts=[...document.scripts].filter(node=>!['application/json','application/ld+json'].includes(node.type.toLowerCase()));
  const trustedRuntime=root.id==='pp-landing'&&scripts.length===1&&scripts[0].getAttribute('data-pp-runtime')==='1'&&!scripts[0].hasAttribute('src')&&scripts[0].textContent===trustedRuntimeText&&![...document.querySelectorAll('*')].some(node=>[...node.attributes].some(a=>/^on/i.test(a.name)));
  return {html,sourceHash,marker:root.id,placements,bindings,warnings,trustedRuntime};
 }finally{dom.window.close();}
}
function exact(config){if(!config||config.contentMode!=='exact-import'||config.exactImport?.version!==1)fail('VALIDATION');const data=parse(config.exactImport.html);if(data.sourceHash!==config.exactImport.sourceHash||data.marker!==config.exactImport.marker)fail('CONFLICT');return data;}
export function inspectExactImport(html){const data=parse(html);return {sourceHash:data.sourceHash,marker:data.marker,placements:data.placements,warnings:data.warnings,config:{contentMode:'exact-import',exactImport:{version:1,html,sourceHash:data.sourceHash,marker:data.marker}}};}
export function renderExactImport(config){const data=exact(config);return {config:clone(config),html:data.html,title:config.title||'',expectedUrls:[...new Set(data.placements.map(p=>p.url))],expectedMarker:data.marker};}
export function listExactPlacements(config){return exact(config).placements;}
// Normalize only navigation attributes on existing anchors. Creating a new anchor or
// changing a tag could alter legacy CSS/layout, so those cases require manual review.
function normalizeLinks(data,desired){
 const groups=new Map(),normalization=[];
 for(const value of desired.values()){if(!groups.has(value.url))groups.set(value.url,[]);groups.get(value.url).push(value);}
 for(const [url,group] of groups){
  const natives=group.filter(p=>p.attribute==='href');if(natives.length===1)continue;
  if(!data.trustedRuntime)fail('IMPORT_LINK_COLLISION');
  const winner=natives.find(p=>p.url===p.original.url)||natives[0]||group.find(p=>data.bindings.get(p.id).tag==='a');
  if(!winner)fail('IMPORT_LINK_COLLISION');
  for(const value of group){
   const attribute=value===winner?'href':'data-pp-url';if(value.attribute===attribute)continue;
   normalization.push({id:value.id,label:value.original.label,url,oldAttribute:value.attribute,newAttribute:attribute});value.attribute=attribute;
  }
 }
 return normalization;
}
function attributePatch(data,binding,name,value){
 const location=binding.loc.attrs?.[name];
 if(location){
  const raw=data.html.slice(location.startOffset,location.endOffset),prefix=/^([^=]+?\s*=\s*)/.exec(raw)?.[1]||name+'=';
  return {start:location.startOffset,end:location.endOffset,text:prefix+'"'+escape(value)+'"'};
 }
 return {start:binding.loc.startTag.endOffset-1,end:binding.loc.startTag.endOffset-1,text:' '+name+'="'+escape(value)+'"'};
}
export function proposeExactReplacement(config,changes){
 const data=exact(config);if(!Array.isArray(changes)||!changes.length||changes.length>1000)fail('VALIDATION');
 const desired=new Map(data.placements.map(p=>[p.id,{...p,original:p}])),seen=new Set(),patches=[],diff=[];
 for(const change of changes){
  if(!change||Object.keys(change).some(k=>!['id','url','anchor'].includes(k))||seen.has(change.id)||!desired.has(change.id)||!validUrl(change.url))fail('VALIDATION');
  seen.add(change.id);const value=desired.get(change.id),place=value.original,anchor=change.anchor===undefined?place.anchor:change.anchor;
  if(typeof anchor!=='string'||anchor.length>2000||anchor.includes('\0')||anchor!==place.anchor&&!place.anchorEditable)fail('VALIDATION');
  if(change.url===place.url&&anchor===place.anchor)continue;
  value.url=change.url;value.anchor=anchor;
  diff.push({id:place.id,path:place.path,role:place.role,label:place.label,oldUrl:place.url,newUrl:change.url,oldAnchor:place.anchor,newAnchor:anchor});
 }
 const linkNormalization=normalizeLinks(data,desired);
 for(const value of desired.values()){
  const place=value.original,binding=data.bindings.get(value.id);
  if(value.url!==place.url||value.attribute!==place.attribute){
   const prefix=binding.prefix.replace(/^(\s*)[^\s=]+/,(_,space)=>space+value.attribute);
   patches.push({start:binding.attr.startOffset,end:binding.attr.endOffset,text:prefix+binding.quote+escape(value.url)+binding.quote});
  }
  if(value.anchor!==place.anchor)patches.push({start:binding.loc.startTag.endOffset,end:binding.loc.endTag.startOffset,text:escape(value.anchor)});
  if(value.attribute!==place.attribute){
   if(value.attribute==='href'){
    const target=binding.attributes['data-pp-target']||binding.attributes.target;
    if(target&&target!==binding.attributes.target)patches.push(attributePatch(data,binding,'target',target));
    if(target==='_blank'){
     const rel=[...new Set((binding.attributes.rel||'').split(/\s+/).filter(Boolean).concat(['noopener','noreferrer']))].join(' ');
     if(rel!==binding.attributes.rel)patches.push(attributePatch(data,binding,'rel',rel));
    }
   }else{
    const target=binding.attributes.target||'_self';
    if(binding.attributes['data-pp-target']!==target)patches.push(attributePatch(data,binding,'data-pp-target',target));
    if(binding.attributes.role!=='link')patches.push(attributePatch(data,binding,'role','link'));
    if(binding.attributes.tabindex!=='0')patches.push(attributePatch(data,binding,'tabindex','0'));
   }
  }
 }
 let html=data.html,previous=Infinity;
 for(const patch of patches.sort((a,b)=>b.start-a.start)){if(patch.end>previous)fail('IMPORT_AMBIGUOUS');html=html.slice(0,patch.start)+patch.text+html.slice(patch.end);previous=patch.start;}
 const checked=inspectExactImport(html),nextConfig={...clone(config),exactImport:checked.config.exactImport};
 for(const url of new Set(checked.placements.map(p=>p.url)))if(checked.placements.filter(p=>p.url===url&&p.attribute==='href').length!==1)fail('IMPORT_LINK_COLLISION');
 return {version:1,kind:'exact-import',baseSnapshot:canonical(config),changes:clone(changes),diff,linkNormalization,nextConfig};
}
export function applyExactReplacement(config,proposal){
 if(!proposal||proposal.version!==1||proposal.kind!=='exact-import'||proposal.baseSnapshot!==canonical(config))fail('CONFLICT');
 const checked=proposeExactReplacement(config,proposal.changes);
 if(canonical(checked.diff)!==canonical(proposal.diff)||canonical(checked.linkNormalization)!==canonical(proposal.linkNormalization)||canonical(checked.nextConfig)!==canonical(proposal.nextConfig))fail('CONFLICT');
 return checked.nextConfig;
}
