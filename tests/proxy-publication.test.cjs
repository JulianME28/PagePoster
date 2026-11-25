const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
async function service(t,{createProxyTransport=async proxy=>async()=>({status:200,text:proxy.id,headers:{}})}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pp-proxy-service-'));let factory;
 const browser={nativeEditor:true,close:async()=>{}};
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const app=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,7).toString('base64'),visibleBrowserEnabled:true,wordPressFactory:options=>{factory=options.sessionTransportFactory;return browser;},proxyOptions:{createProxyTransport}});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const request=(route,body,origin='http://127.0.0.1:4317')=>app.handle(new Request('http://127.0.0.1:4317/api/lifecycle'+route,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-PagePoster-Request':'1'},...(body?{body:JSON.stringify(body)}:{})}));
 return {app,request,open:arg=>factory(arg)};
}
test('proxy settings API saves configuration without exposing credentials and rejects stale or cross-site writes',async t=>{
 const {request}=await service(t);assert.equal((await request('/proxy/settings')).status,200);
 let response=await request('/proxy/settings',{enabled:true,list:'a.example:8000:alice:secret',expectedRevision:0});assert.equal(response.status,200);assert.doesNotMatch(JSON.stringify(await response.json()),/alice|secret/);
 assert.equal((await request('/proxy/settings',{enabled:false,expectedRevision:0})).status,409);
 assert.equal((await request('/proxy/settings',{enabled:false,expectedRevision:1},'https://other.example')).status,403);
 response=await request('/proxy/settings',{enabled:true,list:'http://alice:secret@a.example:8000/rotate',expectedRevision:1});assert.equal(response.status,400);assert.doesNotMatch(JSON.stringify(await response.json()),/alice|secret/);
});
test('publication wiring persists one proxy binding, retains it on restart and rotates only after a donor change',async t=>{
 const {app,request,open}=await service(t);await request('/proxy/settings',{enabled:true,list:'a.example:8000\nb.example:8000',expectedRevision:0});
 const project=app.store.createProject({name:'Offline proxy fixture'}),run=app.store.createRecord(project.id,'autopilot',{candidate:{id:'donor-a',baseUrl:'https://a.example/'}});
 const first=await open({id:run.id}),pin=first.route.proxyId;assert.ok(pin);assert.equal(app.store.getRecord(run.id).proxyBinding.proxyId,pin);await first.close();
 const resumed=await open({id:run.id});assert.equal(resumed.route.proxyId,pin);await resumed.close();
 let latest=app.store.getRecord(run.id);app.store.updateRecord(run.id,{candidate:{id:'donor-b',baseUrl:'https://b.example/'}},latest.revision);
 const next=await open({id:run.id});assert.notEqual(next.route.proxyId,pin);await next.close();
});
test('proxy usage API includes prior donors and separates browser from verification payload',async t=>{
 let calls=0;
 const {app,request,open}=await service(t,{createProxyTransport:async proxy=>async(_url,options={})=>{
  options.onProxyUsage?.({eventId:'test-'+(++calls),bytesSent:2,bytesReceived:4,requests:1,connections:1});
  return {status:200,text:proxy.id};
 }});
 await request('/proxy/settings',{enabled:true,list:'a.example:8000:alice:secret\nb.example:8000',expectedRevision:0});
 const project=app.store.createProject({name:'Metered publication'}),run=app.store.createRecord(project.id,'autopilot',{candidate:{id:'a',baseUrl:'https://a.example/'}});
 const first=await open({id:run.id});
 await first.transport('https://a.example/');
 await first.transport('https://a.example/public',{proxyUsageScope:'verification'});
 await first.close();
 const second=await open({id:run.id});
 await second.transport('https://a.example/asset');
 await second.close();
 const current=app.store.getRecord(run.id);
 app.store.updateRecord(run.id,{candidate:{id:'b',baseUrl:'https://b.example/'}},current.revision);
 const third=await open({id:run.id});
 await third.transport('https://b.example/');
 await third.close();
 const response=await request('/proxy/usage',{projectId:project.id,runId:run.id});
 assert.equal(response.status,200);
 const {usage}=await response.json();
 assert.equal(usage.attempts.length,2);
 assert.deepEqual(usage.total,{bytesSent:8,bytesReceived:16,requests:4,connections:4});
 assert.equal(usage.byScope.verification.requests,1);
 assert.equal(usage.cost,null);
 assert.doesNotMatch(JSON.stringify(usage),/alice|secret|\.example/);
});

test('proxy checks API validates revision/origin and reports safe results without modifying saved settings',async t=>{
 const {request}=await service(t);assert.equal((await request('/proxy/checks',{expectedRevision:0,list:'a.example:8000:alice:secret'},'https://other.example')).status,403);
 assert.equal((await request('/proxy/checks',{expectedRevision:1,list:'a.example:8000'})).status,409);
 let response=await request('/proxy/checks',{expectedRevision:0,list:'a.example:8000:alice:secret'});assert.equal(response.status,202);assert.doesNotMatch(JSON.stringify(await response.json()),/alice|secret/);
 for(let i=0;i<20;i++){response=await request('/proxy/checks');const data=await response.json();if(data.check.state!=='running'){assert.equal(data.check.rows[0].state,'unknown');assert.equal(data.check.source,'draft');break;}await new Promise(setImmediate);}
 const {proxy}=await (await request('/proxy/settings')).json();assert.equal(proxy.count,0);assert.equal(proxy.revision,0);
});

test('proxy mode refuses legacy workflow writes even when the native browser is present',async t=>{
 const {app,request}=await service(t);await request('/proxy/settings',{enabled:true,list:'a.example:8000',expectedRevision:0});
 const project=app.store.createProject({name:'Legacy offline guard'}),site=app.store.createSite(project.id,{name:'Fixture',baseUrl:'https://legacy.example/'});app.store.updateSite(site.id,{enabled:true,status:'ok'},site.revision);
 const page=app.store.createPage(project.id,{title:'Fixture page',siteId:site.id});const job=app.store.enqueueJob({projectId:project.id,pageId:page.id,siteId:site.id,type:'publish',payload:{},idempotencyKey:'proxy-legacy-guard'});
 await app.tick();assert.equal(app.store.getJob(job.id).error?.code,'PROXY_MODE_UNSUPPORTED');
});

function fakeChromium(){const browser=new EventEmitter();browser.live=true;browser.isConnected=()=>browser.live;
 browser.newContext=async()=>{const context=new EventEmitter(),page=new EventEmitter();page.closed=false;page.isClosed=()=>page.closed;page.setDefaultTimeout=()=>{};page.bringToFront=async()=>{};page.close=async()=>{if(!page.closed){page.closed=true;page.emit('close');}};context.newPage=async()=>page;context.addInitScript=async()=>{};context.route=async(_glob,handler)=>context.handler=handler;context.routeWebSocket=async()=>{};context.close=()=>page.close();return context;};browser.close=async()=>{browser.live=false;browser.emit('disconnected');};return {launch:async()=>browser};}
test('WordPress browser reuses its bound transport and closes it before advancing to the next page',async()=>{
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');let acquisitions=0,releases=0;
 const manager=createWordPressUI({chromium:fakeChromium(),executablePath:'fixture.exe',sessionTransportFactory:async()=>{acquisitions++;return {transport:async()=>({status:200}),close:async()=>releases++};}});
 try{const first=await manager.open('one',null);assert.equal(manager.transportFor('one'),first.networkTransport);assert.equal(await manager.open('one',null),first);assert.equal(acquisitions,1);await assert.rejects(manager.open('two',null),{code:'BROWSER_BUSY'});assert.equal(releases,0);await manager.done('one');await manager.open('two',null);assert.equal(releases,1);assert.equal(acquisitions,2);}finally{await manager.close();}assert.equal(releases,2);
});
