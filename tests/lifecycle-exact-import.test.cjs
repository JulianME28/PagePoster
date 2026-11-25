'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const old='https://offers.example/(deal)?offer=1669&key=%2F#A',next='https://offers.example/(deal)?offer=1771&key=%2f#B';
const html='<style>#pp-universal-pl a[href="'+old+'"]{color:red}</style>\r\n<div id="pp-universal-pl"><a class="cta" href=\''+old.replace('&','&amp;')+'\'>Exact &amp; anchor</a><span data-pp-url="'+old.replace('&','&amp;')+'" data-pp-target="_blank">Duplicate</span><script>const original='+JSON.stringify(old)+'</script></div><!-- keep exact -->';
test('exact-import reads real marked wrappers and renders byte-identical snapshots',async()=>{
 const mod=await import('../server/lifecycle/exact-import.mjs'),result=mod.inspectExactImport(html);assert.equal(result.marker,'pp-universal-pl');assert.equal(result.placements.length,2);assert.equal(result.placements[0].url,old);assert.equal(result.placements[1].url,old);assert.equal(mod.renderExactImport(result.config).html,html);
 for(const bad of ['<main>unmarked</main>','<!-- <div id="pp-landing">fake</div> -->','<div id="pp-landing"></div><div id="pp-universal-pl"></div>'])assert.throws(()=>mod.inspectExactImport(bad),e=>e.code==='IMPORT_UNMARKED');
});
test('exact replacement patches only confirmed URL and plain anchor bytes',async()=>{
 const mod=await import('../server/lifecycle/exact-import.mjs'),original=mod.inspectExactImport(html),selected=original.placements[1],proposal=mod.proposeExactReplacement(original.config,original.placements.map(p=>({id:p.id,url:next,...(p.id===selected.id?{anchor:'New exact <anchor>'}:{})})));
 assert.equal(proposal.diff.length,2);assert.equal(proposal.diff[0].oldUrl,old);const applied=mod.applyExactReplacement(original.config,proposal),expected=html.replace('href=\''+old.replace('&','&amp;')+'\'','href=\''+next.replace('&','&amp;')+'\'').replace('data-pp-url="'+old.replace('&','&amp;')+'"','data-pp-url="'+next.replace('&','&amp;')+'"').replace('>Duplicate</span>','>New exact &lt;anchor&gt;</span>');assert.equal(mod.renderExactImport(applied).html,expected);assert.equal(original.config.exactImport.html,html);
 const stale=mod.inspectExactImport(html+'changed').config;assert.throws(()=>mod.applyExactReplacement(stale,proposal),e=>e.code==='CONFLICT');assert.throws(()=>mod.proposeExactReplacement(original.config,[{id:selected.id,url:next},{id:selected.id,url:next}]),e=>e.code==='VALIDATION');
});
test('ambiguous duplicate attributes and nested anchors cannot become raw mutation bindings',async()=>{
 const mod=await import('../server/lifecycle/exact-import.mjs');assert.throws(()=>mod.inspectExactImport('<div id="pp-landing"><a href="https://one.example/" href="https://two.example/">X</a></div>'),e=>e.code==='IMPORT_AMBIGUOUS');
 const sample=mod.inspectExactImport('<div id="pp-landing"><a href="https://one.example/"><b>Styled</b></a></div>');assert.equal(sample.placements[0].anchorEditable,false);assert.throws(()=>mod.proposeExactReplacement(sample.config,[{id:sample.placements[0].id,url:next,anchor:'changed'}]),e=>e.code==='VALIDATION');
});

test('legacy and spoofed runtimes reject URL changes that would lose or duplicate a native href',async()=>{
 const mod=await import('../server/lifecycle/exact-import.mjs');
 for(const suffix of ['', '<script data-pp-runtime="1">/* unknown runtime */</script>']){
  const sample=mod.inspectExactImport('<div id="pp-landing"><a href="https://one.example/">One</a><a data-pp-url="https://one.example/">Again</a><a href="https://two.example/">Two</a></div>'+suffix);
  assert.throws(()=>mod.proposeExactReplacement(sample.config,[{id:sample.placements[1].id,url:'https://new.example/'}]),e=>e.code==='IMPORT_LINK_COLLISION');
  assert.throws(()=>mod.proposeExactReplacement(sample.config,[{id:sample.placements[0].id,url:'https://two.example/'}]),e=>e.code==='IMPORT_LINK_COLLISION');
 }
});
test('known runtime rebalances existing anchor attributes with exact preserved CSS, scripts, tags and controls',async()=>{
 const mod=await import('../server/lifecycle/exact-import.mjs'),runtime=require('../dist/page-runtime.js'),{JSDOM}=require('jsdom');
 const source=runtime.prepare('<style>.cta{color:red}</style><div id="pp-landing"><a class="cta" href="https://one.example/">One</a><a class="cta" href="https://one.example/" target="_blank">Again</a><a class="cta" href="https://two.example/">Two</a></div>');
 const sample=mod.inspectExactImport(source),proposal=mod.proposeExactReplacement(sample.config,[{id:sample.placements[0].id,url:'https://two.example/'}]),result=mod.renderExactImport(mod.applyExactReplacement(sample.config,proposal)).html;
 const dom=new JSDOM(result),document=dom.window.document;
 assert.deepEqual([...document.querySelectorAll('a')].map(a=>a.textContent),['One','Again','Two']);
 for(const url of ['https://one.example/','https://two.example/'])assert.equal([...document.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===url).length,1);
 assert.equal(document.querySelectorAll('[data-pp-url]').length,1);assert.equal(document.querySelector('a[href="https://one.example/"]').getAttribute('target'),'_blank');
 assert.equal(result.match(/<style>[\s\S]*?<\/style>/)[0],source.match(/<style>[\s\S]*?<\/style>/)[0]);assert.equal(result.match(/<script[\s\S]*$/)[0],source.match(/<script[\s\S]*$/)[0]);
 assert.equal(proposal.linkNormalization.length,2);assert.throws(()=>mod.applyExactReplacement(sample.config,{...proposal,linkNormalization:[]}),e=>e.code==='CONFLICT');dom.window.close();
 const second=mod.proposeExactReplacement(sample.config,[{id:sample.placements[1].id,url:'https://new.example/'}]);assert.equal(second.linkNormalization.length,1);assert.match(second.nextConfig.exactImport.html,/href="https:\/\/new.example\/"/);
 const button=mod.inspectExactImport(runtime.prepare('<div id="pp-landing"><a class="pp-cta" href="https://one.example/">One</a><button data-pp-url="https://one.example/">Again</button></div>'));
 assert.throws(()=>mod.proposeExactReplacement(button.config,[{id:button.placements[1].id,url:'https://new.example/'}]),e=>e.code==='IMPORT_LINK_COLLISION');
});
