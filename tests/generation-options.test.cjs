'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('explicit card count repeats exact supplied pairs without mutating or dropping links',async()=>{
 const {expandGenerationLinks}=await import('../server/lifecycle/generation-options.mjs');
 const links=[{url:'https://a.example/?x=%2F',anchor:'First'},{url:'https://b.example/#go',anchor:'Second'}],before=structuredClone(links);
 const result=expandGenerationLinks(links,10);assert.equal(result.length,10);
 result.forEach((pair,index)=>assert.deepEqual(pair,links[index%2]));assert.deepEqual(links,before);assert.notEqual(result[0],links[0]);
 assert.deepEqual(expandGenerationLinks(links),links);
 for(const count of [0,1,21,2.5,'10',NaN])assert.throws(()=>expandGenerationLinks(links,count),{code:'VALIDATION'});
});
test('new target languages have localized action labels and a language-specific editorial contract',async()=>{
 const {EDITORIAL_LANGUAGES,normalizeEditorial,editorialActionLabel,editorialInstructions}=await import('../server/lifecycle/editorial-brief.mjs');
 for(const code of ['uk','nl','pt','it','sv','no','da','fi','ro','hu','cs','sk','el','tr','id','vi','hi']){
  assert.ok(EDITORIAL_LANGUAGES[code],code);const brief=normalizeEditorial({language:code,format:'guide',topic:'casino'});
  assert.ok(editorialActionLabel(brief).length>2);assert.match(editorialInstructions(brief),new RegExp(EDITORIAL_LANGUAGES[code]));
 }
});

test('new editorial languages localize renderer-owned mobile navigation and contents',()=>{
 const generator=require('../dist/generator.js');
 for(const [language,label]of [['uk','Зміст'],['nl','Inhoudsopgave'],['pt','Índice'],['hi','विषय सूची']]){
  const html=generator.renderSnippet({...generator.DEFAULT_DATA,editorialFormat:'article',language,showToc:true});assert.ok(html.includes('aria-label="'+label+'"'),language);
 }
});
