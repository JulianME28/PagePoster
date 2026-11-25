const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const mod=()=>import('../server/lifecycle/proxy-settings.mjs');
const key=Buffer.alloc(32,7).toString('base64');
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pp-proxy-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));return dataDir;}
test('proxy list formats validate without leaking input and use stable ids',async()=>{
 const {parseProxyList}=await mod();const list=parseProxyList('proxy.example:8000:alice:secret\nsocks5://bob:pass@two.example:1080\nhttps://three.example:443');assert.equal(list.length,3);assert.equal(new URL(list[0].url).username,'alice');assert.equal(parseProxyList(list[0].url)[0].id,list[0].id);
 assert.throws(()=>parseProxyList('http://alice:secret@proxy.example:80/api?token=x'),e=>e.code==='PROXY_CONFIG_INVALID'&&e.line===1&&!/alice|secret|token/.test(e.message));
 assert.throws(()=>parseProxyList('proxy.example:8000\nproxy.example:8000'),{code:'PROXY_CONFIG_INVALID'});
});
test('proxy settings persist encrypted, survive reload, do not echo credentials and can retain or clear list',async t=>{
 const {createProxySettings}=await mod(),dataDir=await fixture(t);const settings=await createProxySettings({dataDir,masterKey:key,createProxyTransport:async p=>async()=>p.id});t.after(()=>settings.close());
 assert.equal(settings.status().enabled,false);await settings.save({enabled:true,list:'http://alice:secret@proxy.example:8000\nhttp://two.example:8000',expectedRevision:0});
 assert.equal(settings.status().count,2);assert.doesNotMatch(JSON.stringify(settings.status()),/alice|secret/);
 const disk=await fs.readFile(path.join(dataDir,'proxy-settings.json'),'utf8');assert.doesNotMatch(disk,/alice|secret|proxy\.example|two\.example/);
 const reload=await createProxySettings({dataDir,masterKey:key,createProxyTransport:async p=>async()=>p.id});t.after(()=>reload.close());assert.equal(reload.status().count,2);assert.equal(reload.status().enabled,true);
 await assert.rejects(reload.save({enabled:false,expectedRevision:0}),{code:'CONFLICT'});await reload.save({enabled:false,expectedRevision:1});assert.equal(reload.status().count,2);await reload.save({enabled:false,clear:true,expectedRevision:2});assert.equal(reload.status().count,0);
});
test('proxy pins survive list changes and browser recreation; missing pinned proxy never falls back',async t=>{
 const {createProxySettings}=await mod(),dataDir=await fixture(t);const made=[];const settings=await createProxySettings({dataDir,masterKey:key,createProxyTransport:async p=>{made.push(p.id);return async()=>p.id;}});t.after(()=>settings.close());
 await settings.save({enabled:true,list:'http://a.example:8000\nhttp://b.example:8000',expectedRevision:0});const first=await settings.open('one');const pin=first.route;
 await settings.save({enabled:false,expectedRevision:1});assert.equal(await first.transport('https://wp.example/'),pin.proxyId);await first.close();
 const resumed=await settings.open('one',{binding:pin});assert.equal(resumed.route.proxyId,pin.proxyId);await resumed.close();
 await settings.save({enabled:true,list:'http://c.example:8000',expectedRevision:2});await assert.rejects(settings.open('one',{binding:pin}),{code:'PROXY_PINNED_UNAVAILABLE'});
 const next=await settings.open('two');assert.notEqual(next.route.proxyId,pin.proxyId);await next.close();
});
test('an encrypted proxy settings file cannot silently become a direct connection when the key is missing or wrong',async t=>{
 const {createProxySettings}=await mod(),dataDir=await fixture(t),settings=await createProxySettings({dataDir,masterKey:key});await settings.save({enabled:true,list:'http://proxy.example:8000',expectedRevision:0});await settings.close();
 await assert.rejects(createProxySettings({dataDir}),{code:'PROXY_SETTINGS_UNAVAILABLE'});await assert.rejects(createProxySettings({dataDir,masterKey:Buffer.alloc(32,8).toString('base64')}),{code:'PROXY_SETTINGS_UNAVAILABLE'});
});

test('saving settings cannot lease an endpoint still held by an older generation or reset its quarantine',async t=>{
 const {createProxySettings}=await mod(),dataDir=await fixture(t);const settings=await createProxySettings({dataDir,masterKey:key,createProxyTransport:async()=>async()=>{throw Object.assign(Error('proxy failure'),{code:'PROXY_CONNECT_FAILED'});}});t.after(()=>settings.close());
 await settings.save({enabled:true,list:'a.example:8000',expectedRevision:0});const active=await settings.open('one');
 await settings.save({enabled:true,list:'a.example:8000',expectedRevision:1});await assert.rejects(settings.open('two'),{code:'PROXY_POOL_EXHAUSTED'});
 await assert.rejects(active.transport('https://wp.example/'),{code:'PROXY_CONNECT_FAILED'});await active.close();await assert.rejects(settings.open('three'),{code:'PROXY_POOL_EXHAUSTED'});
});
test('diagnostics skip a publication lease and settings replacement cancels stale checks without saving a draft',async t=>{
 const {createProxySettings}=await mod(),dataDir=await fixture(t);let release;
 const settings=await createProxySettings({dataDir,masterKey:key,createProxyTransport:()=>({transport:async(_url,{signal})=>new Promise((_,reject)=>{release=()=>reject(Object.assign(Error('cancelled'),{code:'network_timeout'}));signal.addEventListener('abort',release,{once:true});}),close:async()=>{}})});t.after(()=>settings.close());
 await settings.save({enabled:true,list:'a.example:8000',expectedRevision:0});const publication=await settings.open('current');await settings.check({expectedRevision:1});await new Promise(setImmediate);assert.equal(settings.checkStatus().rows[0].state,'busy');assert.equal(settings.status().activeSessions,1);await publication.close();
 await settings.check({expectedRevision:1,list:'b.example:8000:alice:secret'});await new Promise(setImmediate);assert.equal(settings.checkStatus().state,'running');assert.equal(settings.status().count,1);await settings.save({enabled:true,expectedRevision:1});assert.equal(settings.checkStatus(),null);assert.equal(settings.status().count,1);assert.ok(release);assert.doesNotMatch(JSON.stringify(settings.status()),/alice|secret/);
});
