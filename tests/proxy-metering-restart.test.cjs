const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('proxy usage survives SQLite reopen, deduplicates events and sums multiple donor attempts',async t=>{
 const {createStore}=await import('../server/lifecycle/store.mjs');
 const {createProxyMetering}=await import('../server/lifecycle/proxy-metering.mjs');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'pp-proxy-meter-'));
 const filename=path.join(folder,'pageposter.sqlite');
 let store=createStore({filename});
 t.after(()=>{store?.close();fs.rmSync(folder,{recursive:true,force:true});});
 const project=store.createProject({name:'Proxy accounting'}),other=store.createProject({name:'Separate project'});
 const event={eventId:'event-one',attemptId:'attempt-first',projectId:project.id,runId:'run-one',
  scope:'browser',bytesSent:5,bytesReceived:12,requests:1,connections:1};
 let meter=createProxyMetering(store);
 assert.equal(meter.recordProxyUsage(event),true);
 store.close();store=createStore({filename});meter=createProxyMetering(store);
 assert.equal(meter.recordProxyUsage(event),false);
 assert.throws(()=>meter.recordProxyUsage({...event,bytesSent:6}),{code:'CONFLICT'});
 assert.throws(()=>meter.recordProxyUsage({...event,eventId:'negative',bytesSent:-1}),{code:'VALIDATION'});
 meter.recordProxyUsage({...event,eventId:'event-two',scope:'verification',bytesSent:0,bytesReceived:4});
 meter.recordProxyUsage({...event,eventId:'event-three',attemptId:'attempt-second',bytesSent:0,bytesReceived:0,requests:0});
 meter.recordProxyUsage({...event,eventId:'event-four',attemptId:'attempt-other',projectId:other.id,runId:'run-two'});
 const report=meter.proxyUsageSummary({projectId:project.id,runId:'run-one'});
 assert.equal(report.cost,null);
 assert.equal(report.providerBilledBytes,null);
 assert.deepEqual(report.total,{bytesSent:5,bytesReceived:16,requests:2,connections:3});
 assert.deepEqual(report.byScope.verification,{bytesSent:0,bytesReceived:4,requests:1,connections:1});
 assert.deepEqual(report.attempts.map(entry=>entry.attemptId),['attempt-first','attempt-second']);
 assert.equal(meter.proxyUsageSummary({projectId:other.id}).total.bytesSent,5);
 assert.equal(meter.proxyUsageSummary({projectId:project.id,runId:'run-two'}).total.requests,0);
});
