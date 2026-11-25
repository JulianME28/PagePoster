'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const synthetic={contentMode:'html',title:'Synthetic diagnostic',importHtml:'<h1>Fixture</h1><p>Original synthetic HTML</p><a href="https://fixture.example/a?x=%2f&amp;b=2#part">Exact anchor</a>',importChrome:'none'};

test('repeated stored HTML preparation does not register accumulating selectors on the shared renderer window',async()=>{
 const {prepareConfig}=await import('../server/lifecycle/workflow.mjs'),{rendererWindow}=await import('../server/lifecycle/render.mjs');
 const expected=prepareConfig(synthetic),window=rendererWindow.document.defaultView,original=window.addEventListener;let registrations=0;
 window.addEventListener=function(...args){registrations++;return original.apply(this,args);};
 try{for(let i=0;i<25;i++)assert.deepEqual(prepareConfig(synthetic),expected);assert.equal(registrations,0,'placement parser selectors must not retain handlers on the long-lived renderer window');}finally{window.addEventListener=original;}
});

test('successful and rejected placement parsing close their owned parser windows',async()=>{
 const {prepareConfig}=await import('../server/lifecycle/workflow.mjs');prepareConfig(synthetic);
 const descriptor=Object.getOwnPropertyDescriptor(JSDOM.prototype,'window'),windows=new Map();
 Object.defineProperty(JSDOM.prototype,'window',{...descriptor,get(){const window=descriptor.get.call(this);if(!windows.has(window)){const close=window.close;windows.set(window,false);window.close=function(...args){windows.set(window,true);return close.apply(this,args);};}return window;}});
 try{
  const success=prepareConfig(synthetic);assert.match(success.importHtml,/x=%2f&amp;b=2#part/);
  assert.throws(()=>prepareConfig({...synthetic,importHtml:'<a data-pp-placement-id="duplicate" href="https://fixture.example/one">One</a><a data-pp-placement-id="duplicate" href="https://fixture.example/two">Two</a>'}),/Повторний ID HTML/);
  assert.equal(windows.size,2,'one parser window must be owned by each HTML registry operation');assert.equal([...windows.values()].every(Boolean),true,'finally must close both successful and rejected parser windows');
 }finally{Object.defineProperty(JSDOM.prototype,'window',descriptor);for(const [window,closed]of windows)if(!closed)window.close();}
});

test('scoped placement parsing preserves existing prepare/list/propose/apply output and exact URLs',async()=>{
 const {createScopedPlacementRegistry}=await import('../server/lifecycle/placement-dom.mjs'),scoped=createScopedPlacementRegistry(),window=new JSDOM('').window,reference=require('../dist/link-placements.js').create({window});
 try{
  const input={contentMode:'html',importChrome:'none',importHtml:'<!doctype html><html><head><style>a{color:red}</style></head><body><a href="https://fixture.example/a?x=%2f&amp;b=2#part">Exact anchor</a><a href="https://fixture.example/other">Other</a><script type="application/ld+json">{"url":"https://fixture.example/a?x=%2f&b=2#part"}</script></body></html>'};
  const prepared=reference.prepare(input);assert.deepEqual(scoped.prepare(input),prepared);assert.deepEqual(scoped.list(prepared.config),reference.list(prepared.config));
  const place=prepared.placements[0],changes=[{id:place.id,expectedUrl:place.url,expectedAnchor:place.anchor,expectedBinding:place.binding,url:'https://replacement.example/offer?x=%2F&n=2#exact'}],proposal=reference.propose(prepared.config,changes);
  assert.deepEqual(scoped.propose(prepared.config,changes),proposal);assert.deepEqual(scoped.apply(prepared.config,proposal),reference.apply(prepared.config,proposal));
  const changed=scoped.list(scoped.apply(prepared.config,proposal));assert.equal(changed[0].url,'https://replacement.example/offer?x=%2F&n=2#exact');assert.equal(changed[1].url,'https://fixture.example/other');
  assert.throws(()=>scoped.apply({...prepared.config,title:'Changed input'},proposal),/Конфлікт/);assert.equal(input.importHtml.includes('data-pp-placement-id'),false,'original input stays unchanged');
 }finally{window.close();}
});

test('non-HTML placement operations do not allocate a parser window',async()=>{
 const {createScopedPlacementRegistry}=await import('../server/lifecycle/placement-dom.mjs'),registry=createScopedPlacementRegistry(),descriptor=Object.getOwnPropertyDescriptor(JSDOM.prototype,'window');let windows=0;
 Object.defineProperty(JSDOM.prototype,'window',{...descriptor,get(){windows++;return descriptor.get.call(this);}});
 try{const prepared=registry.prepare({cards:[],sections:[],faq:[]});registry.list(prepared.config);assert.equal(windows,0);}finally{Object.defineProperty(JSDOM.prototype,'window',descriptor);}
});
