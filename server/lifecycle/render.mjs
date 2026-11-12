import {renderExactImport} from './exact-import.mjs';
import {readFileSync} from 'node:fs';
import {JSDOM} from './dom-runtime.mjs';
import Placements from '../../dist/link-placements.js';
const trustedRegistryCreate=Placements.create;
let initializedWindow,trustedIdentity;
function dataIdentity(value){
 const pending=[value],seen=new Set();let count=0;
 while(pending.length){const item=pending.pop();if(++count>100000||!['object','string','boolean','number'].includes(typeof item)||typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0)))throw Error('Non-data renderer defaults');if(item===null||typeof item!=='object')continue;if(seen.has(item)||Object.getOwnPropertySymbols(item).length)throw Error('Non-data renderer defaults');seen.add(item);for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))){if(!Object.hasOwn(descriptor,'value'))throw Error('Renderer default accessor');pending.push(descriptor.value);}}
 return JSON.stringify(value);
}
function bundleIdentity(target){
 const api=target.PagePoster,identity=[api,dataIdentity(api.DEFAULT_DATA),dataIdentity(api.PRESETS)];
 // Capture public functions actually consumed by rendering/import/placement,
 // including the server registry factory and nested CSS helper namespaces.
 for(const namespace of [api,target.PagePosterHTML,target.PagePosterRuntime,target.PagePosterLinkPlacements,target.DOMPurify,target.csstree,target.csstree?.lexer,target.csstree?.ident,Placements]){
  identity.push(namespace);
  for(const owner of [namespace,namespace&&Object.getPrototypeOf(namespace)])if(owner)for(const key of Object.getOwnPropertyNames(owner).sort()){const descriptor=Object.getOwnPropertyDescriptor(owner,key);for(const field of ['value','get','set'])if(typeof descriptor[field]==='function')identity.push(key,field,descriptor[field]);}
 }
 return identity;
}
function renderer(){
 if(!initializedWindow){const candidate=new JSDOM('',{runScripts:'outside-only',url:'https://pageposter.invalid/'}).window;try{for(const name of ['purify.min.js','csstree.js','html-import.js','page-runtime.js','link-placements.js','generator.js'])candidate.eval(readFileSync(new URL('../../dist/'+name,import.meta.url),'utf8'));try{trustedIdentity=bundleIdentity(candidate);}catch{trustedIdentity=null;}initializedWindow=candidate;}catch(error){candidate.close();throw error;}}
 return initializedWindow;
}
// Listing a workspace does not need to initialize the HTML renderer.
const window=new Proxy(Object.create(null),{get(_target,key){const value=renderer();return Reflect.get(value,key,value);},set(_target,key,value){return Reflect.set(renderer(),key,value);}});
export function renderPage(input){
 if(input?.contentMode==='exact-import')return renderExactImport(input);
 const config=window.PagePoster.normalizeConfig(input);
 if(config.contentMode==='html'&&window.PagePoster.analyzeHTML(config).error)throw Object.assign(Error('Invalid imported HTML'),{code:'VALIDATION'});
 const html=window.PagePoster.renderSnippet(config),audit=window.PagePoster.analyzeLinks(config);
 if(!html.includes('id="pp-landing"')||Buffer.byteLength(html)>1000000)throw Object.assign(Error('Invalid page size'),{code:'VALIDATION'});
 return {config:JSON.parse(JSON.stringify(config)),html,title:config.title,expectedUrls:Array.from(audit.urls),expectedMarker:'pp-landing'};
}
export {window as rendererWindow};
// A modified renderer can be stateful. Run the original pipeline instead of
// retaining outputs from any replacement implementation. Exact import uses
// lexical module code and does not need to initialize the normal window.
export function isPreparedRendererTrusted(config){
 if(config?.contentMode==='exact-import')return true;
 if(Placements.create!==trustedRegistryCreate)return false;
 try{const current=bundleIdentity(renderer());return !!trustedIdentity&&current.length===trustedIdentity.length&&current.every((value,index)=>Object.is(value,trustedIdentity[index]));}catch{return false;}
}
