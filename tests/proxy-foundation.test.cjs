const test=require('node:test'),assert=require('node:assert/strict');
const poolModule=()=>import('../server/lifecycle/proxy-pool.mjs');
const sessionModule=()=>import('../server/lifecycle/proxy-sessions.mjs');
const entries=[{id:'a',url:'http://alice:secret%40one@proxy-a.example:8000',country:'PL'},{id:'b',url:'socks5://bob:second-secret@proxy-b.example:1080',country:'PL'},{id:'c',url:'https://proxy-c.example:8443',country:'NZ'}];

test('proxy definitions normalize authentication and never expose it in descriptors or validation errors',async()=>{
 const {createProxyPool}=await poolModule(),pool=createProxyPool({entries});
 assert.deepEqual(pool.list().map(p=>[p.id,p.scheme,p.country,p.authRequired]),[['a','http','PL',true],['b','socks5','PL',true],['c','https','NZ',false]]);
 assert.doesNotMatch(JSON.stringify(pool.list()),/alice|secret|bob|password|username/);
 const first=pool.acquire('session');assert.equal(first.proxy.server,'http://proxy-a.example:8000');assert.equal(first.proxy.password,'secret@one');
 for(const url of ['ftp://alice:secret@proxy.example:21','http://proxy.example:80/rotate','http://proxy.example:80/?key=secret','http://proxy.example:80/#secret','http://proxy.example:80\n','http://proxy.example:80','http://alice@proxy.example:80']){
  if(url==='http://proxy.example:80'){assert.equal(createProxyPool({entries:[{id:'x',url}]}).acquire('x').proxy.server,url);continue;}
  assert.throws(()=>createProxyPool({entries:[{id:'x',url}]}),error=>error.code==='PROXY_CONFIG_INVALID'&&!/alice|secret/.test(error.message));
 }
 assert.throws(()=>createProxyPool({entries:[entries[0],entries[0]]}),{code:'PROXY_CONFIG_INVALID'});
 assert.throws(()=>createProxyPool({entries:[{id:'x',url:'http://alice:bad%zz@proxy.example:80'}]}),{code:'PROXY_CONFIG_INVALID'});
});

test('leases are sticky, exclusive and use exact country filtering with no silent country fallback',async()=>{
 const {createProxyPool}=await poolModule(),pool=createProxyPool({entries});
 const a=pool.acquire('one',{country:'pl'});assert.equal(a.proxy.id,'a');assert.equal(pool.acquire('one',{country:'PL'}),a);
 assert.throws(()=>pool.acquire('one',{country:'NZ'}),{code:'PROXY_SESSION_CONFLICT'});
 const b=pool.acquire('two',{country:'PL'});assert.equal(b.proxy.id,'b');
 assert.throws(()=>pool.acquire('three',{country:'PL'}),{code:'PROXY_POOL_EXHAUSTED'});
 assert.throws(()=>pool.acquire('missing',{country:'DE'}),{code:'PROXY_POOL_EXHAUSTED'});
 assert.equal(pool.acquire('nz',{country:'NZ'}).proxy.id,'c');
 assert.equal(pool.release('one',a.leaseId),true);assert.equal(pool.release('one',a.leaseId),false);
 const next=pool.acquire('three',{country:'PL'});assert.equal(next.proxy.id,'a');
 assert.equal(pool.release('three','wrong-lease'),false);assert.equal(pool.acquire('three',{country:'PL'}),next);
});

test('round-robin advances between sessions and proxy faults quarantine only future leases',async()=>{
 const {createProxyPool}=await poolModule();let now=1000;const pool=createProxyPool({entries:entries.slice(0,2),cooldownMs:100,clock:()=>now});
 const a=pool.acquire('one');pool.release('one',a.leaseId);const b=pool.acquire('two');assert.equal(b.proxy.id,'b');pool.release('two',b.leaseId);
 const sticky=pool.acquire('three');assert.equal(sticky.proxy.id,'a');
 assert.equal(pool.reportFailure('three',sticky.leaseId,'BROWSER_CAPTCHA_REQUIRED'),false);assert.equal(pool.list()[0].retryAt,null);
 assert.equal(pool.reportFailure('three',sticky.leaseId,'PROXY_CONNECT_FAILED'),true);assert.equal(pool.acquire('three'),sticky);
 pool.release('three',sticky.leaseId);const remaining=pool.acquire('four');assert.equal(remaining.proxy.id,'b');
 assert.throws(()=>pool.acquire('five'),{code:'PROXY_POOL_EXHAUSTED'});now=1100;assert.equal(pool.acquire('five').proxy.id,'a');
});

test('disabled sessions use the supplied direct transport; enabled routing requires an adapter',async()=>{
 const {createProxySessionRouter}=await sessionModule();const calls=[];
 const router=createProxySessionRouter({directTransport:async(...args)=>{calls.push(args);return 'direct';}});
 const session=await router.open('one');assert.equal(session.route.mode,'direct');assert.equal(await session.transport('https://wp.example/'),'direct');assert.equal(calls.length,1);await session.close();
 await assert.rejects(session.transport('https://wp.example/'),{code:'PROXY_SESSION_CLOSED'});await router.close();
 assert.throws(()=>createProxySessionRouter({enabled:true,entries,directTransport:async()=>{},createProxyTransport:null}),{code:'PROXY_ADAPTER_REQUIRED'});
});

test('concurrent opens share one private adapter and never fall back or retry a failed publication',async()=>{
 const {createProxySessionRouter}=await sessionModule();let built=0,writes=0,direct=0,closeCalls=0;const configs=[];
 const router=createProxySessionRouter({enabled:true,entries, directTransport:async()=>direct++,createProxyTransport:async proxy=>{built++;configs.push(proxy);await new Promise(setImmediate);return {transport:async()=>{writes++;throw Object.assign(Error('failed with alice secret@one'),{code:'PROXY_TIMEOUT',requestNotStarted:false,uncertain:true});},close:async()=>closeCalls++};}});
 const [a,b]=await Promise.all([router.open('one',{country:'PL'}),router.open('one',{country:'PL'})]);assert.equal(a,b);assert.equal(built,1);assert.equal(configs[0].password,'secret@one');assert.doesNotMatch(JSON.stringify(a.route),/alice|secret/);
 await assert.rejects(a.transport('https://wp.example/wp-admin/post.php',{method:'POST',body:'content'}),e=>e.code==='PROXY_TIMEOUT'&&e.message==='PROXY_TIMEOUT'&&e.uncertain===true&&e.requestNotStarted===false);
 assert.equal(writes,1);assert.equal(direct,0);assert.equal((await router.open('one',{country:'PL'})),a);assert.equal(built,1);
 await a.close();await a.close();assert.equal(closeCalls,1);const next=await router.open('two',{country:'PL'});assert.equal(next.route.proxyId,'b');await router.close();
});

test('closing a session waits for in-flight transport before releasing its proxy',async()=>{
 const {createProxySessionRouter}=await sessionModule();let finish;const pending=new Promise(r=>finish=r),events=[];
 const router=createProxySessionRouter({enabled:true,entries:[entries[0]],createProxyTransport:async()=>({transport:async()=>{await pending;events.push('response');return 'ok';},close:async()=>events.push('adapter-close')})});
 const session=await router.open('one'),request=session.transport('https://wp.example/');let closed=false;const closing=session.close().then(()=>closed=true);await new Promise(setImmediate);assert.equal(closed,false);
 await assert.rejects(router.open('two'),{code:'PROXY_POOL_EXHAUSTED'});await assert.rejects(session.transport('https://wp.example/'),{code:'PROXY_SESSION_CLOSED'});
 finish();assert.equal(await request,'ok');await closing;assert.deepEqual(events,['response','adapter-close']);await router.open('two');await router.close();
});

test('adapter startup failure releases the lease, sanitizes the error and never selects a direct route',async()=>{
 const {createProxySessionRouter}=await sessionModule();let attempt=0,direct=0;
 const router=createProxySessionRouter({enabled:true,entries:entries.slice(0,2),directTransport:async()=>direct++,createProxyTransport:async()=>{if(!attempt++)throw Object.assign(Error('secret@one alice'),{code:'PROXY_AUTH_FAILED'});return async()=>({status:200});}});
 await assert.rejects(router.open('one'),error=>error.code==='PROXY_AUTH_FAILED'&&error.message==='PROXY_AUTH_FAILED'&&error.requestNotStarted===true);
 const session=await router.open('two');assert.equal(session.route.proxyId,'b');assert.equal(direct,0);await router.close();await assert.rejects(router.open('three'),{code:'PROXY_ROUTER_CLOSED'});
});

test('invalid adapters are closed before their lease is released',async()=>{
 const {createProxySessionRouter}=await sessionModule();let cleaned=0;
 const router=createProxySessionRouter({enabled:true,entries:[entries[0]],createProxyTransport:async()=>({transport:null,close:async()=>cleaned++})});
 await assert.rejects(router.open('one'),{code:'PROXY_ADAPTER_INVALID'});assert.equal(cleaned,1);assert.equal(router.status().proxies[0].busy,false);await router.close();
});

test('an ending session cannot be reopened while requests are draining',async()=>{
 const {createProxySessionRouter}=await sessionModule();let finish;const gate=new Promise(r=>finish=r);
 const router=createProxySessionRouter({enabled:true,entries:[entries[0]],createProxyTransport:async()=>async()=>{await gate;return 'ok';}});
 const session=await router.open('one'),request=session.transport('https://wp.example/'),closing=session.close();
 try{await assert.rejects(router.open('one'),{code:'PROXY_SESSION_CLOSING'});}finally{finish();await request;await closing;await router.close();}
});

test('an unconfirmed adapter shutdown cannot make the same proxy available to another session',async()=>{
 const {createProxySessionRouter}=await sessionModule();
 const router=createProxySessionRouter({enabled:true,entries:[entries[0]],createProxyTransport:async()=>({transport:async()=>({status:200}),close:async()=>{throw Error('secret shutdown error');}})});
 const session=await router.open('one');await assert.rejects(session.close(),error=>error.message==='PROXY_TRANSPORT_FAILED');
 assert.equal(router.status().proxies[0].busy,true);await assert.rejects(router.open('two'),{code:'PROXY_POOL_EXHAUSTED'});await assert.rejects(router.close(),{code:'PROXY_CLOSE_FAILED'});
});
