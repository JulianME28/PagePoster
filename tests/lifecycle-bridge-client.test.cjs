'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
function archiveHashes(filename,folder){const bytes=fs.readFileSync(path.resolve(__dirname,'..',filename)),out={};let at=0;while(bytes.readUInt32LE(at)===0x04034b50){const length=bytes.readUInt16LE(at+26),start=at+30+length+bytes.readUInt16LE(at+28),size=bytes.readUInt32LE(at+18),name=bytes.subarray(at+30,at+30+length).toString();if(name.endsWith('.php'))out[name.slice(folder.length+1)]=createHash('sha256').update(zlib.inflateRawSync(bytes.subarray(start,start+size))).digest('hex');at=start+size;}return out;}
const INTEGRITY={algorithm:'sha256',bridge:archiveHashes('wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip','pageposter-bridge'),cleanLinks:archiveHashes('assets/pageposter-clean-links-1.1.1.zip','pageposter-clean-links')};
const mod=import('../server/lifecycle/bridge-client.mjs');
const SITE={baseUrl:'https://site.example/blog/',username:'admin-user',applicationPassword:'never-print-password'};
const OP={operationId:'b8ebccf8-2ee1-4a43-b7ef-1784e024646d',kind:'create',postType:'page',title:'Точний заголовок',content:'<div id="pp-landing"><a href="https://offer.example/?a=%2f&amp;b=2">Offer</a></div>',status:'draft'};
const HASH=createHash('sha256').update('pageposter-snapshot-v1\0'+['page',OP.title,OP.content,'draft'].map(x=>Buffer.byteLength(x)+':'+x).join('')).digest('hex');
const READY={packageIntegrity:INTEGRITY,version:'0.2.1',schemaVersion:1,ready:true,cleanLinksActive:true,cleanLinksVersion:'1.1.1',cleanLinksFeatures:['contact-schemes','exact-wrapper-boundary'],capabilities:{create:true,update:true,atomicCas:true,idempotentCreate:true,adopt:true,inspect:true},limitations:[]};
const RESULT={operationId:OP.operationId,kind:'create',state:'completed',replayed:false,postId:42,contentHash:HASH,previousContentHash:null,postType:'page',status:'draft',url:'https://site.example/blog/?page_id=42',createdAt:'2026-10-14T10:00:00Z',completedAt:'2026-10-14T10:00:00Z',warnings:[]};
const SNAPSHOT={postId:42,postType:OP.postType,title:OP.title,content:OP.content,status:OP.status,contentHash:HASH,modifiedGmt:'2026-10-14T10:00:00Z',url:RESULT.url,managed:true,canEdit:true};
function mock(options={}) {
  const calls=[];const apiRoot=options.query?'https://site.example/blog/?rest_route=/':'https://site.example/blog/wp-json/';
  const transport=async(url,init={})=>{
    calls.push({url,...init});
    const u=new URL(url),route=u.searchParams.get('rest_route')||u.pathname.replace('/blog/wp-json','');
    if(route==='/pageposter/v1/status')return {status:200,text:JSON.stringify(options.status||READY),url};
    if(init.method==='POST'){
      if(options.throwPost)throw Object.assign(new Error(SITE.applicationPassword),{code:options.throwPost});
      return {status:options.postStatus||201,text:options.rawPost===undefined?JSON.stringify(options.result||RESULT):options.rawPost,url:options.finalUrl||url,redirects:options.redirects||[]};
    }
    if(route==='/pageposter/v1/operations/'+OP.operationId)return {status:options.lookupStatus||200,text:JSON.stringify(options.lookup||RESULT),url};
    if(route==='/pageposter/v1/inspect/42')return {status:200,text:JSON.stringify(options.snapshot||{...SNAPSHOT,managed:false}),url};
    if(route==='/pageposter/v1/pages/42')return {status:200,text:JSON.stringify(options.snapshot||SNAPSHOT),url};
    throw Error('Unexpected route '+route);
  };
  return {transport,calls,apiRoot};
}
test('Bridge writes require ready schema and all atomic/idempotency capabilities before sending any POST',async()=>{
  const {createBridgeClient}=await mod;
  for(const status of [{...READY,ready:false},{...READY,schemaVersion:2},{...READY,capabilities:{...READY.capabilities,atomicCas:false}},{...READY,capabilities:{...READY.capabilities,idempotentCreate:false}}]){
    const f=mock({status});
    await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),{code:'bridge_not_ready'});
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }
});
test('ready Bridge receives exactly one unchanged JSON operation at its same-origin endpoint',async()=>{
  const {createBridgeClient}=await mod;
  for(const query of [false,true]){
    const f=mock({query}),client=createBridgeClient({transport:f.transport});
    const result=await client.submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP});
    assert.deepEqual(result,RESULT);
    const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);
    assert.deepEqual(JSON.parse(writes[0].body),OP);
    assert.equal(writes[0].headers.authorization,'Basic '+Buffer.from(SITE.username+':'+SITE.applicationPassword).toString('base64'));
    assert.ok(!JSON.stringify(result).includes(SITE.applicationPassword));
    assert.equal(new URL(writes[0].url).searchParams.get('rest_route')||new URL(writes[0].url).pathname.replace('/blog/wp-json',''),'/pageposter/v1/operations');
  }
});

test('browser form dispatch replaces the hidden POST and retains result verification',async()=>{
 const {createBridgeClient}=await mod,f=mock();let submitted=0,guarded=0;
 const result=await createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP,beforeSend:()=>guarded++,browserSubmit:async input=>{assert.equal(guarded,0);assert.deepEqual(input.operation,OP);input.beforeSend();submitted++;return {status:201,text:JSON.stringify(RESULT),url:input.address};}});
 assert.equal(result.postId,42);assert.equal(submitted,1);assert.equal(guarded,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('browser guard failure before form dispatch retains proof that no write was sent',async()=>{
 const {createBridgeClient}=await mod,f=mock();
 await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP,browserSubmit:async()=>{throw Object.assign(Error('closed'),{code:'BROWSER_CLOSED',writeNotAttempted:true});}}),error=>error.code==='BROWSER_CLOSED'&&error.writeNotAttempted===true);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('foreign API roots, malformed operation IDs and excessive content are rejected before requests',async()=>{
  const {createBridgeClient}=await mod;
  for(const patch of [{apiRoot:'https://other.example/wp-json/'},{operation:{...OP,operationId:'x'}},{operation:{...OP,status:'private'}},{operation:{...OP,content:'x'.repeat(1048577)}},{operation:{...OP,kind:'update',postId:42}},{operation:{...OP,extra:true}}]){
    const f=mock();await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP,...patch}),error=>['unsafe_url','bridge_validation'].includes(error.code));
    assert.equal(f.calls.length,0);
  }
});
test('lost response or POST redirect is uncertain, never retried or redirected to core WordPress publication',async()=>{
  const {createBridgeClient}=await mod;
  for(const options of [{throwPost:'network_timeout'},{throwPost:'write_redirect_blocked'},{rawPost:'<html>gateway failure</html>',postStatus:502},{finalUrl:'https://other.example/fake'},{finalUrl:'https://user:pass@site.example/fake'},{finalUrl:'https://127.0.0.1/fake'},{result:{...RESULT,contentHash:'a'.repeat(64)}}]){
    const f=mock(options);await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),error=>error.code==='pp_bridge_uncertain'&&error.uncertain===true&&!error.message.includes(SITE.applicationPassword));
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
    assert.ok(f.calls.every(c=>!c.url.includes('/wp/v2/pages')));
  }
});
test('typed rollback differs from unknown commit and API messages cannot leak credentials',async()=>{
  const {createBridgeClient}=await mod;
  for(const [code,uncertain] of [['pp_bridge_database_failure',false],['pp_bridge_uncertain',true],['pp_bridge_unsupported_storage',false],['pp_bridge_idempotency_conflict',false],['pp_bridge_content_changed',false],['pp_bridge_cas_conflict',false],['pp_bridge_unavailable',true],['pp_bridge_clean_links_required',false]]){
    const f=mock({postStatus:code==='pp_bridge_idempotency_conflict'?409:503,result:{code,message:SITE.applicationPassword}});
    await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),error=>error.code===code&&error.uncertain===uncertain&&!error.message.includes(SITE.applicationPassword));
  }
});
test('operation reconciliation is GET-only and not_found is not permission to create another page',async()=>{
  const {createBridgeClient}=await mod;
  const f=mock({lookupStatus:404,lookup:{code:'pp_bridge_operation_not_found',message:SITE.applicationPassword}});
  const result=await createBridgeClient({transport:f.transport}).getOperation({site:SITE,apiRoot:f.apiRoot,operationId:OP.operationId});
  assert.deepEqual(result,{operationId:OP.operationId,state:'not_found',uncertain:true});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});
test('managed page snapshots preserve content bytes and reject a corrupted snapshot hash',async()=>{
  const {createBridgeClient,bridgeContentHash}=await mod;const f=mock();
  const snapshot=await createBridgeClient({transport:f.transport}).getPage({site:SITE,apiRoot:f.apiRoot,postId:42});
  assert.deepEqual(snapshot,SNAPSHOT);assert.equal(bridgeContentHash(SNAPSHOT),HASH);
  const broken=mock({snapshot:{...SNAPSHOT,content:SNAPSHOT.content+'changed'}});
  await assert.rejects(createBridgeClient({transport:broken.transport}).getPage({site:SITE,apiRoot:broken.apiRoot,postId:42}),{code:'bridge_invalid_response'});
});
test('CAS conflicts remain explicit results and never trigger a retry',async()=>{
  const {createBridgeClient}=await mod;
  const operation={...OP,kind:'update',postId:42,expectedContentHash:HASH};
  const result={...RESULT,kind:'update',state:'conflict',contentHash:'a'.repeat(64),previousContentHash:HASH};
  const f=mock({postStatus:409,result});
  assert.deepEqual(await createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation}),result);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('API root discovery uses the verified WordPress result and preserves missing Bridge readiness',async()=>{
  const {createBridgeClient}=await mod;const f=mock();
  const client=createBridgeClient({transport:f.transport,wordpressClient:{checkSite:async()=>({state:'ok',apiRoot:f.apiRoot})}});
  assert.equal((await client.checkStatus({site:SITE})).ready,true);
});

test('Bridge JSON payload limit includes escaping overhead before any network request',async()=>{
  const {createBridgeClient}=await mod;const f=mock();
  const operation={...OP,content:'<div id="pp-landing">'+'"'.repeat(650000)+'</div>'};
  assert.ok(Buffer.byteLength(operation.content)<1000000);
  assert.ok(Buffer.byteLength(JSON.stringify(operation))>1200000);
  await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation}),{code:'bridge_validation'});
  assert.equal(f.calls.length,0);
});
test('publication requires a single real supported PagePoster wrapper rather than marker-looking text',async()=>{
  const {createBridgeClient}=await mod;
  for(const content of ['<!-- <div id="pp-landing"> -->','<script id="pp-landing">x</script>','<div id="pp-landing"></div><main id="pp-landing"></main>','<div data-note=\'id="pp-landing"\'>x</div>']){
    const f=mock();
    await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:{...OP,content}}),{code:'bridge_validation'});
    assert.equal(f.calls.length,0);
  }
});
test('Clean Links activation is required before the Bridge can enable publication',async()=>{
  const {createBridgeClient}=await mod;
  for(const cleanLinksActive of [false,undefined]){
    const f=mock({status:{...READY,cleanLinksActive}}),client=createBridgeClient({transport:f.transport});
    const status=await client.checkStatus({site:SITE,apiRoot:f.apiRoot});
    assert.equal(status.ready,false);
    assert.equal(status.cleanLinksActive,false);
    assert.match(status.limitations.join(' '),/Clean Links/);
    await assert.rejects(client.submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),{code:'bridge_not_ready'});
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }
});
test('Clean Links wrapper must be a DIV and unsupported landmarks never reach WordPress',async()=>{
  const {createBridgeClient}=await mod;
  for(const content of ['<main id="pp-landing"></main>','<section id="pp-landing"></section>']){
    const f=mock();
    await assert.rejects(createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:{...OP,content}}),{code:'bridge_validation'});
    assert.equal(f.calls.length,0);
  }
});test('old or unverifiable installed plugin versions cannot pass readiness',async()=>{
 const {createBridgeClient}=await mod;
 for(const status of [{...READY,version:'0.1.0'},{...READY,cleanLinksVersion:undefined},{...READY,cleanLinksVersion:'1.1.0'},{...READY,cleanLinksFeatures:[]}]){const f=mock({status});assert.equal((await createBridgeClient({transport:f.transport}).checkStatus({site:SITE,apiRoot:f.apiRoot})).ready,false);}
});
test('inspection and adoption use authenticated exact snapshots without sending content in the registration operation',async()=>{
 const {createBridgeClient}=await mod,operation={operationId:OP.operationId,kind:'adopt',postId:42,postType:'page',expectedContentHash:HASH},f=mock({result:{...RESULT,kind:'adopt',previousContentHash:HASH}}),client=createBridgeClient({transport:f.transport});const snapshot=await client.inspectPage({site:SITE,apiRoot:f.apiRoot,postId:42});assert.equal(snapshot.managed,false);assert.equal(snapshot.content,OP.content);const result=await client.submitOperation({site:SITE,apiRoot:f.apiRoot,operation});assert.equal(result.kind,'adopt');const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].body),operation);
});


test('matching version and features with absent or altered installed bytes never permit a write',async()=>{
 const {createBridgeClient}=await mod;
 for(const packageIntegrity of [undefined,{algorithm:'sha256',bridge:{'pageposter-bridge.php':'a'.repeat(64)},cleanLinks:{'pageposter-clean-links.php':'b'.repeat(64)}}]){
  const f=mock({status:{...READY,packageIntegrity}}),client=createBridgeClient({transport:f.transport});const status=await client.checkStatus({site:SITE,apiRoot:f.apiRoot});
  assert.equal(status.ready,false);assert.equal(status.integrityVerified,false);assert.match(status.limitations.join(' '),/checksum|integrity/i);
  await assert.rejects(client.submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),{code:'bridge_not_ready'});assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }
});
test('committed operation modifiedGmt survives validation and malformed metadata is refused',async()=>{
 const {createBridgeClient}=await mod;
 const result={...RESULT,modifiedGmt:'2026-10-15 10:20:30'},f=mock({result});assert.equal((await createBridgeClient({transport:f.transport}).submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP})).modifiedGmt,result.modifiedGmt);
 const bad=mock({lookup:{...RESULT,modifiedGmt:{invalid:true}}});await assert.rejects(createBridgeClient({transport:bad.transport}).getOperation({site:SITE,apiRoot:bad.apiRoot,operationId:OP.operationId}),{code:'bridge_invalid_response'});
});


test('an altered, missing or extra runtime file invalidates an otherwise correct installed package',async()=>{
 const {createBridgeClient}=await mod;
 for(const name of ['bridge','cleanLinks'])for(const kind of ['changed','missing','extra']){
  const packageIntegrity=structuredClone(INTEGRITY),first=Object.keys(packageIntegrity[name])[0];
  if(kind==='changed')packageIntegrity[name][first]='0'.repeat(64);else if(kind==='missing')delete packageIntegrity[name][first];else packageIntegrity[name]['unexpected.php']='0'.repeat(64);
  const f=mock({status:{...READY,packageIntegrity}}),client=createBridgeClient({transport:f.transport});assert.equal((await client.checkStatus({site:SITE,apiRoot:f.apiRoot})).ready,false);
  await assert.rejects(client.submitOperation({site:SITE,apiRoot:f.apiRoot,operation:OP}),{code:'bridge_not_ready'});assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }
 const f=mock();assert.equal((await createBridgeClient({transport:f.transport}).checkStatus({site:SITE,apiRoot:f.apiRoot})).integrityVerified,true);
});
