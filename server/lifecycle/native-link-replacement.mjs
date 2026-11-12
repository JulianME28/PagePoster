import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {JSDOM} from './dom-runtime.mjs';
import {refreshAmpPayload} from './amp-mode.mjs';

const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const clone=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function validUrl(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.length>10000||!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f\\]/.test(value))return false;
 try{const url=new URL(value);return !!url.hostname&&!url.username&&!url.password;}catch{return false;}
}

function optionsFor(options={}){
 if(!object(options)||Object.keys(options).some(key=>key!=='expectedMarker'))fail('VALIDATION');
 const expectedMarker=options.expectedMarker??'pp-landing';
 if(!['pp-landing','pp-universal-pl'].includes(expectedMarker))fail('VALIDATION');
 return {expectedMarker};
}

// DOM locations locate the original value bytes; the DOM is never serialized.
// Groups follow the committed runtime policy, and changing a destination never
// changes a tag, anchor, navigation attribute name, or the number of controls.
function inspect(html,options){
 const {expectedMarker}=optionsFor(options);
 if(typeof html!=='string'||!html.trim()||!html.isWellFormed()||html.includes('\0')||Buffer.byteLength(html,'utf8')>1000000)fail('VALIDATION');
 const dom=new JSDOM(html,{includeNodeLocations:true});
 try{
  const document=dom.window.document,roots=[...document.querySelectorAll('[id="pp-landing"],[id="pp-universal-pl"]')];
  if(roots.length!==1||roots[0].id!==expectedMarker||roots[0].localName!=='div')fail('NATIVE_LINK_UNMARKED');
  const root=roots[0],rootLocation=dom.nodeLocation(root);
  if(!rootLocation?.startTag||!rootLocation.endTag)fail('NATIVE_LINK_UNMARKED');
  const sourceHash=hash(html),policy=root.classList.contains('pp-editorial-v2')?'editorial-scopes':'single-native',groups=new Map(),bindings=new Map();
  const nodes=[...root.querySelectorAll('a[href],[data-pp-url]')];
  if(nodes.length>1000)fail('VALIDATION');
  for(const node of nodes){
   const attribute=node.hasAttribute('data-pp-url')?'data-pp-url':'href',url=node.getAttribute(attribute);
   if(attribute==='href'&&!/^https?:/i.test(url||''))continue;
   if(!validUrl(url))fail('NATIVE_LINK_AMBIGUOUS');
   if(node.hasAttribute('href')&&node.hasAttribute('data-pp-url'))fail('NATIVE_LINK_AMBIGUOUS');
   for(let ancestor=node;ancestor;ancestor=ancestor.parentElement){
    if([...ancestor.attributes].some(a=>/^on/i.test(a.name)))fail('NATIVE_LINK_AMBIGUOUS');
    if(ancestor===root)break;
   }
   const location=dom.nodeLocation(node),attr=location?.attrs?.[attribute];
   if(!location?.startTag||!attr||location.startTag.startOffset<rootLocation.startTag.endOffset||location.startTag.endOffset>rootLocation.endTag.startOffset)fail('NATIVE_LINK_AMBIGUOUS');
   const startTag=html.slice(location.startTag.startOffset,location.startTag.endOffset);
   const names=[...startTag.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)].slice(1).map(match=>match[1].toLowerCase());
   if(names.filter(name=>name===attribute).length!==1)fail('NATIVE_LINK_AMBIGUOUS');
   const raw=html.slice(attr.startOffset,attr.endOffset),match=/^([^=]+?\s*=\s*)(["'])([\s\S]*)\2$/.exec(raw);
   if(!match)fail('NATIVE_LINK_AMBIGUOUS');
   let chromeAncestors=0;
   for(let ancestor=node.parentElement;ancestor&&ancestor!==root;ancestor=ancestor.parentElement)if(['header','footer'].includes(ancestor.localName))chromeAncestors++;
   if(chromeAncestors>1)fail('NATIVE_LINK_AMBIGUOUS');
   const scope=policy==='editorial-scopes'&&chromeAncestors===1?'chrome':'content';
   const member={id:'native-member:'+hash(sourceHash+':'+location.startTag.startOffset+':'+attribute).slice(0,32),attribute,url,anchor:node.textContent,scope};
   bindings.set(member.id,{start:attr.startOffset+match[1].length+1,end:attr.endOffset-1,quote:match[2]});
   if(!groups.has(url))groups.set(url,[]);
   groups.get(url).push(member);
  }
  const placements=[...groups].map(([url,members])=>{
   const scopes=[...new Set(members.map(member=>member.scope))].sort().map(scope=>({scope,memberCount:members.filter(member=>member.scope===scope).length,nativeCount:members.filter(member=>member.scope===scope&&member.attribute==='href').length}));
   if(scopes.some(scope=>scope.nativeCount!==1))fail('NATIVE_LINK_COUNT');
   const anchor=members.map(member=>member.anchor).join(' · '),nativeCount=members.filter(member=>member.attribute==='href').length;
   return {id:'native:'+hash(sourceHash+':'+url).slice(0,32),path:'remoteSnapshot.content',label:'Посилання · '+members.length+' переходів',role:'url-group',url,anchor,source:'native-published',anchorEditable:false,binding:hash(JSON.stringify([sourceHash,members])),memberCount:members.length,nativeCount,scopes,members};
  });
  return {sourceHash,expectedMarker,policy,placements,bindings};
 }finally{dom.window.close();}
}

export function listNativePlacements(html,options={}){return inspect(html,options).placements;}

function escapedValue(value,quote){
 return value.replace(/[&<>"']/g,char=>char==='&'?'&amp;':char==='<'?'&lt;':char==='>'?'&gt;':char===quote?(quote==='"'?'&quot;':'&#39;'):char);
}

export function proposeNativeReplacement(html,changes,options={}){
 const data=inspect(html,options);
 if(!Array.isArray(changes)||!changes.length||changes.length>1000)fail('VALIDATION');
 const byId=new Map(data.placements.map(place=>[place.id,place])),seen=new Set(),destinations=new Map(),patches=[],diff=[];
 for(const change of changes){
  if(!object(change)||Object.keys(change).some(key=>!['id','url','anchor','expectedUrl','expectedAnchor','expectedBinding'].includes(key))||seen.has(change.id))fail('VALIDATION');
  seen.add(change.id);const place=byId.get(change.id);
  if(!place||change.expectedUrl!==place.url||change.expectedAnchor!==place.anchor||change.expectedBinding!==place.binding||Object.hasOwn(change,'anchor')&&change.anchor!==place.anchor)fail('CONFLICT');
  if(!validUrl(change.url))fail('VALIDATION');
  if(change.url===place.url)continue;
  destinations.set(place.id,change.url);
  diff.push({id:place.id,label:place.label,role:place.role,before:{url:place.url,anchor:place.anchor},after:{url:change.url,anchor:place.anchor}});
  for(const member of place.members){const binding=data.bindings.get(member.id);patches.push({...binding,value:escapedValue(change.url,binding.quote)});}
 }
 if(!diff.length)fail('VALIDATION');
 const targetUrls=data.placements.map(place=>destinations.get(place.id)||place.url);
 if(new Set(targetUrls).size!==targetUrls.length)fail('NATIVE_LINK_COLLISION');
 let nextHtml=html,previous=Infinity;
 for(const patch of patches.sort((a,b)=>b.start-a.start)){
  if(patch.start<0||patch.end>previous||patch.end<patch.start)fail('NATIVE_LINK_AMBIGUOUS');
  nextHtml=nextHtml.slice(0,patch.start)+patch.value+nextHtml.slice(patch.end);previous=patch.start;
 }
 nextHtml=refreshAmpPayload(nextHtml);
 const checked=inspect(nextHtml,{expectedMarker:data.expectedMarker});
 // Reparse the exact bytes to prove grouping, anchors, scope, and count policy
 // survived escaping, including quotes and Unicode in the requested literals.
 if(checked.policy!==data.policy||checked.placements.length!==data.placements.length)fail('NATIVE_LINK_AMBIGUOUS');
 data.placements.forEach((place,index)=>{
  const after=checked.placements[index],url=destinations.get(place.id)||place.url;
  if(after.url!==url||after.anchor!==place.anchor||!isDeepStrictEqual(after.scopes,place.scopes)||after.memberCount!==place.memberCount||!isDeepStrictEqual(after.members.map(member=>[member.attribute,member.anchor,member.scope]),place.members.map(member=>[member.attribute,member.anchor,member.scope])))fail('NATIVE_LINK_AMBIGUOUS');
 });
 return {version:1,kind:'native-links',expectedMarker:data.expectedMarker,policy:data.policy,sourceHash:data.sourceHash,changes:clone(changes),nextHtml,nextHash:checked.sourceHash,expectedUrls:checked.placements.map(place=>place.url),diff};
}

export function applyNativeReplacement(html,proposal,options={}){
 if(!object(proposal)||proposal.version!==1||proposal.kind!=='native-links'||typeof html!=='string'||proposal.sourceHash!==hash(html))fail('CONFLICT');
 let checked;
 try{checked=proposeNativeReplacement(html,proposal.changes,options);}catch{fail('CONFLICT');}
 if(!isDeepStrictEqual(checked,proposal))fail('CONFLICT');
 return checked.nextHtml;
}
