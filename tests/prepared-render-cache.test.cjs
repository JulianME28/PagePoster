'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const factory=async compute=>(await import('../server/lifecycle/prepared-render-cache.mjs')).createPreparedRenderCache(compute);

test('identical full configurations reuse only successful pure work within each store',async()=>{
 let calls=0;const render=await factory(config=>({html:config.html,serial:++calls})),first={},second={};
 assert.deepEqual(render(first,{html:'exact',nested:{url:'https://fixture.example/?x=%2f'}}),{html:'exact',serial:1});
 assert.equal(render(first,{html:'exact',nested:{url:'https://fixture.example/?x=%2f'}}).serial,1);
 assert.equal(render(first,{html:'exact',nested:{url:'https://fixture.example/?x=%2F'}}).serial,2,'nested exact URL changes invalidate');
 assert.equal(render(second,{html:'exact',nested:{url:'https://fixture.example/?x=%2f'}}).serial,3,'different store never shares cached transformation');
 assert.equal(calls,3);
});

test('an untrusted or changing renderer bypasses reuse and never caches replacement work',async()=>{
 let trusted=true,calls=0;const render=(await import('../server/lifecycle/prepared-render-cache.mjs')).createPreparedRenderCache(()=>({serial:++calls}),()=>trusted),store={};
 assert.equal(render(store,{}).serial,1);trusted=false;assert.equal(render(store,{}).serial,2);assert.equal(render(store,{}).serial,3);trusted=true;assert.equal(render(store,{}).serial,1);
 let changed=true;const changing=(await import('../server/lifecycle/prepared-render-cache.mjs')).createPreparedRenderCache(()=>{if(changed)trusted=false;return {serial:++calls};},()=>trusted);changing(store,{});trusted=true;changed=false;assert.equal(changing(store,{}).serial,5,'a dependency changed during compute must not populate reuse');
});

test('cached results are detached and preserve undefined properties and values',async()=>{
 let calls=0;const source={config:{nested:{title:'Original',optional:undefined}},expectedUrls:['https://fixture.example/'],other:undefined,array:[undefined]},render=await factory(()=>{calls++;return source;}),store={};
 const first=render(store,{html:'same'});first.config.nested.title='Caller mutation';first.expectedUrls.push('https://changed.example/');source.config.nested.title='Producer mutation';
 const second=render(store,{html:'same'});assert.equal(calls,1);assert.equal(second.config.nested.title,'Original');assert.deepEqual(second.expectedUrls,['https://fixture.example/']);assert.equal(Object.hasOwn(second.config.nested,'optional'),true);assert.equal(Object.hasOwn(second,'other'),true);assert.deepEqual(second.array,[undefined]);
});

test('LRU evicts at 128 entries and a hit refreshes the selected entry',async()=>{
 let calls=0;const render=await factory(config=>({value:config.value,serial:++calls})),store={};
 for(let value=0;value<128;value++)render(store,{value});assert.equal(render(store,{value:0}).serial,1);render(store,{value:128});assert.equal(render(store,{value:0}).serial,1);assert.equal(render(store,{value:1}).serial,130);assert.equal(calls,130);
});

test('serialized key plus value budget evicts entries and oversize values bypass reuse',async()=>{
 let calls=0;const large='x'.repeat(6*1024*1024),render=await factory(config=>({serial:++calls,html:config.oversize?'x'.repeat(17*1024*1024):large})),store={};
 render(store,{id:1});render(store,{id:2});assert.equal(render(store,{id:2}).serial,2,'two entries fit and reuse');render(store,{id:3});render(store,{id:1});assert.equal(calls,4,'three six-MiB entries cannot fit the sixteen-MiB budget');
 render(store,{oversize:true});render(store,{oversize:true});assert.equal(calls,6,'oversize values are never retained');
 const inputRender=await factory(()=>({serial:++calls})),input={html:'x'.repeat(17*1024*1024)};inputRender(store,input);inputRender(store,input);assert.equal(calls,8,'oversize serialized keys bypass');
 const combined={html:'x'.repeat(11*1024*1024)};render(store,combined);render(store,combined);assert.equal(calls,10,'key and value must share the sixteen-MiB budget');
});

test('compute failures are not cached and unsupported input/output data preserves compute behavior',async()=>{
 let failures=0;const error=Object.assign(Error('Synthetic validation'),{code:'VALIDATION'}),reject=await factory(()=>{failures++;throw error;}),store={};for(let i=0;i<2;i++)assert.throws(()=>reject(store,{html:'bad'}),value=>value===error);assert.equal(failures,2);
 let calls=0;const render=await factory(config=>({present:Object.hasOwn(config,'optional'),serial:++calls}));assert.equal(render(store,{optional:undefined}).present,true);assert.equal(render(store,{optional:undefined}).serial,2);assert.equal(render(store,{}).present,false);assert.equal(render(store,{}).serial,3);
 let gets=0;const accessor={get html(){gets++;return 'value';}},read=await factory(config=>({html:config.html}));read(store,accessor);read(store,accessor);assert.equal(gets,2,'cache eligibility must not invoke accessors');
 let invalid=0;const output=await factory(()=>({callback:()=>++invalid}));assert.equal(output(store,{}).callback(),1);assert.equal(output(store,{}).callback(),2);
 const unsupported=new Proxy({},{ownKeys(){throw Error('Synthetic unsupported input');}}),ignore=await factory(()=>({html:'unchanged'}));assert.deepEqual(ignore(store,unsupported),{html:'unchanged'});
});

test('real prepared rendering keeps exact HTML and percent-encoded URLs on repeated results',async()=>{
 const {prepareConfig}=await import('../server/lifecycle/workflow.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');let calls=0;
 const input={contentMode:'html',importChrome:'none',title:'Exact',importHtml:'<h1>Exact original</h1><a href="https://fixture.example/?x=%2f&amp;x=%2F#part">Exact anchor</a>'},expected=renderPage(prepareConfig(input)),render=await factory(config=>{calls++;return renderPage(prepareConfig(config));}),store={};
 assert.deepEqual(render(store,input),expected);const copy=render(store,JSON.parse(JSON.stringify(input)));assert.deepEqual(copy,expected);assert.equal(calls,1);copy.expectedUrls.push('https://bad.example/');assert.deepEqual(render(store,input),expected);
});

test('trusted rendering bypasses every changed public engine function, defaults, presets and registry factory',async()=>{
 const {rendererWindow,isPreparedRendererTrusted}=await import('../server/lifecycle/render.mjs'),config={contentMode:'html'},api=rendererWindow.PagePoster,placements=require('../dist/link-placements.js');assert.equal(isPreparedRendererTrusted(config),true);
 for(const key of ['normalizeConfig','renderSnippet','analyzeHTML','analyzeLinks']){const original=api[key];try{api[key]=function(...args){return original.apply(this,args);};assert.equal(isPreparedRendererTrusted(config),false,key);}finally{api[key]=original;}assert.equal(isPreparedRendererTrusted(config),true);}
 const title=api.DEFAULT_DATA.title,name=api.PRESETS.emerald.name,create=placements.create;
 try{api.DEFAULT_DATA.title=title+' changed';assert.equal(isPreparedRendererTrusted(config),false);}finally{api.DEFAULT_DATA.title=title;}
 try{api.PRESETS.emerald.name=name+' changed';assert.equal(isPreparedRendererTrusted(config),false);}finally{api.PRESETS.emerald.name=name;}
 try{placements.create=function(...args){return create(...args);};assert.equal(isPreparedRendererTrusted(config),false);}finally{placements.create=create;}
 try{rendererWindow.PagePoster={...api};assert.equal(isPreparedRendererTrusted(config),false);}finally{rendererWindow.PagePoster=api;}
 assert.equal(isPreparedRendererTrusted(config),true);
});

test('exact-import cache eligibility does not initialize the ordinary DOM renderer',()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path'),script="import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {isPreparedRendererTrusted}=await import('./server/lifecycle/render.mjs');console.log(JSON.stringify({trusted:isPreparedRendererTrusted({contentMode:'exact-import'}),heavy:Object.keys(require.cache).filter(name=>/[\\\\/]node_modules[\\\\/](?:jsdom)[\\\\/]/.test(name)).length}));";
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{trusted:true,heavy:0});
});

test('registry mutation before lazy renderer initialization cannot become a trusted baseline',()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path'),script="import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {isPreparedRendererTrusted}=await import('./server/lifecycle/render.mjs');const registry=require('./dist/link-placements.js'),original=registry.create;registry.create=(...args)=>original(...args);console.log(JSON.stringify({trusted:isPreparedRendererTrusted({contentMode:'html'}),heavy:Object.keys(require.cache).filter(name=>/[\\\\/]node_modules[\\\\/](?:jsdom)[\\\\/]/.test(name)).length}));";
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{trusted:false,heavy:0});
});
