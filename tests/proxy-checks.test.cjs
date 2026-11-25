const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../server/lifecycle/proxy-checks.mjs');
const entries=[{id:'a',url:'http://alice:secret@proxy.example:8000',label:'Проксі 1'},{id:'b',url:'socks5://other.example:1080',label:'Проксі 2'}];
test('checks report observed IP/country without credentials, use only the fixed endpoint and preserve busy publication leases',async()=>{
 const {createProxyChecks}=await load(),coordination={busy:new Set(['socks5://other.example:1080']),retryAt:new Map()};let closed=0,calls=[];
 const checks=createProxyChecks({coordination,createProxyTransport:proxy=>({transport:async(url,options)=>{calls.push({url,proxy:proxy.id,method:options.method});return {status:200,text:JSON.stringify({ip:'8.8.8.8',country:'US'})};},close:async()=>closed++})});
 checks.start(entries,{revision:2,source:'saved'});await checks.wait();const result=checks.status();assert.equal(result.state,'completed');assert.equal(result.rows[0].state,'ok');assert.equal(result.rows[0].ip,'8.8.8.8');assert.equal(result.rows[0].country,'US');assert.equal(result.rows[1].state,'busy');assert.deepEqual(calls,[{url:'https://api.country.is/',proxy:'a',method:'GET'}]);assert.equal(closed,1);assert.deepEqual([...coordination.busy],['socks5://other.example:1080']);assert.doesNotMatch(JSON.stringify(result),/alice|secret/);await checks.close();
});
test('bounded checks distinguish proxy failures from unavailable geolocation and support cancellation/timeouts',async()=>{
 const {createProxyChecks}=await load();let active=0,peak=0;
 const checks=createProxyChecks({timeoutMs:25,concurrency:2,createProxyTransport:proxy=>({transport:async(_url,{signal})=>{active++;peak=Math.max(peak,active);try{if(proxy.id==='a')throw Object.assign(Error('secret'),{code:'PROXY_AUTH_FAILED'});return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('secret')),{once:true}));}finally{active--;}},close:async()=>{}})});
 checks.start(entries,{revision:0});await checks.wait();let result=checks.status();assert.equal(result.rows[0].code,'PROXY_AUTH_FAILED');assert.equal(result.rows[1].code,'PROXY_TIMEOUT');assert.ok(peak<=2);assert.doesNotMatch(JSON.stringify(result),/secret/);
 checks.start(entries,{revision:0});await checks.cancel(checks.status().id);result=checks.status();assert.equal(result.state,'cancelled');assert.ok(result.rows.every(row=>!['queued','checking'].includes(row.state)));await checks.close();
 const unavailable=createProxyChecks({createProxyTransport:()=>({transport:async()=>({status:429,text:'secret'}),close:async()=>{}})});unavailable.start(entries.slice(0,1),{revision:0});await unavailable.wait();assert.equal(unavailable.status().rows[0].state,'unknown');assert.equal(unavailable.status().rows[0].code,'PROXY_CHECK_SERVICE_UNAVAILABLE');await unavailable.close();
});
test('malformed/nonpublic IP is not reported as a working proxy; duplicate batches rejected and results cloned',async()=>{
 const {createProxyChecks}=await load();const checks=createProxyChecks({createProxyTransport:()=>({transport:async()=>({status:200,text:'{"ip":"127.0.0.1","country":"<x>"}'}),close:async()=>{}})});
 checks.start(entries,{revision:1});assert.throws(()=>checks.start(entries,{revision:1}),{code:'PROXY_CHECK_RUNNING'});await checks.wait();const snapshot=checks.status();assert.equal(snapshot.rows[0].state,'unknown');snapshot.rows[0].state='ok';assert.equal(checks.status().rows[0].state,'unknown');await checks.close();
});
