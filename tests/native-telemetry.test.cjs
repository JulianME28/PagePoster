const test=require('node:test'),assert=require('node:assert/strict');
test('explicit wall intervals retain multi-day waits and unsafe scopes or out-of-bound values stay unknown',async()=>{
 const {safePublicationDiagnostics}=await import('../server/lifecycle/publication-diagnostics.mjs');const [row]=safePublicationDiagnostics([{phase:'manual_wait',elapsedMs:null,manualWaitMs:172800000,timingScope:'manual_wait_wall',manualWaitScope:'until_validated_resume_wall',workerQueueWaitMs:Number.MAX_SAFE_INTEGER,workerQueueWaitScope:'private account'}]);assert.equal(row.manualWaitMs,172800000);assert.equal(row.elapsedMs,null);assert.equal(row.timingScope,'manual_wait_wall');assert.equal(row.manualWaitScope,'until_validated_resume_wall');assert.equal(row.workerQueueWaitMs,null);assert.equal(row.workerQueueWaitScope,null);assert.doesNotMatch(JSON.stringify(row),/private account/);
});
test('telemetry clock and rejected observer failures preserve successful and failed operation results',async()=>{
 const {createNativeTelemetry,observeNativePhase}=await import('../server/lifecycle/native-telemetry.mjs'),broken=()=>{throw Error('clock');},original=Error('operation');
 assert.equal(await observeNativePhase(async()=>{throw Error('observer');},'editor',async()=>71,{clock:broken,monotonic:broken}),71);
 await assert.rejects(observeNativePhase(()=>{throw Error('observer');},'editor',async()=>{throw original;},{clock:broken,monotonic:broken}),e=>e===original);
 const timing=createNativeTelemetry({clock:broken,monotonic:broken}).finish();assert.equal(timing.elapsedMs,null);assert.equal(timing.startedAt,null);assert.equal(timing.endedAt,null);
});
test('native timing collects bounded actual network observations and monotonic nested phases without secrets',async()=>{
 const {createNativeTelemetry}=await import('../server/lifecycle/native-telemetry.mjs');let mono=10,wall=1000;
 const t=createNativeTelemetry({phase:'publish',monotonic:()=>mono,clock:()=>wall});
 t.observe({kind:'phase',phase:'create',state:'start',at:1000});mono=20;t.observe({kind:'phase',phase:'create',state:'end',at:1010,elapsedMs:10,code:'OK'});
 t.observe({kind:'network',networkMs:12,queueMs:3,httpStatus:302,method:'POST',requestClass:'publication',url:'https://private/?password=secret',error:'private'});
 t.observe({kind:'network',networkMs:null,queueMs:null,httpStatus:200,method:'GET',requestClass:'editor_read'});
 mono=40;wall=500;const result=t.finish();assert.equal(result.elapsedMs,30);assert.equal(result.networkMs,12);assert.equal(result.queueMs,3);assert.equal(result.httpStatus,302);assert.equal(result.manualWaitMs,null);assert.equal(result.timingScope,'operation');assert.equal(result.networkScope,'summed_requests');assert.equal(result.phases[0].phase,'create');assert.equal(result.phases[0].elapsedMs,10);assert.doesNotMatch(JSON.stringify(result),/private|password|secret/);
 for(let i=0;i<5000;i++)t.observe({kind:'network',networkMs:1,queueMs:1,httpStatus:599});assert.deepEqual(t.finish(),result);
 const absent=createNativeTelemetry().finish();assert.equal(absent.networkMs,null);assert.equal(absent.queueMs,null);assert.equal(absent.httpStatus,null);
 const bounded=createNativeTelemetry();for(let i=0;i<5000;i++)bounded.observe({kind:'network',networkMs:1,queueMs:2,httpStatus:500});const b=bounded.finish();assert.equal(b.requestCount,4096);assert.equal(b.truncated,true);
 const spans=createNativeTelemetry();for(let i=0;i<32;i++){spans.observe({kind:'phase',phase:'editor',state:'start',at:1000});spans.observe({kind:'phase',phase:'editor',state:'end',at:1001,elapsedMs:1});}assert.equal(spans.finish().phases.length,16);assert.equal(spans.finish().truncated,true);
});
test('native diagnostics keeps explicit timing scopes and refuses unknown sensitive fields',async()=>{
 const {safePublicationDiagnostics}=await import('../server/lifecycle/publication-diagnostics.mjs');
 const [row]=safePublicationDiagnostics([{phase:'send',timingScope:'operation',networkScope:'summed_requests',elapsedMs:30,networkMs:10,queueMs:2,manualWaitMs:null,requestCount:2,truncated:true,httpStatus:201,url:'secret',headers:{authorization:'secret'}}]);assert.equal(row.phase,'send');assert.equal(row.networkMs,10);assert.equal(row.queueMs,2);assert.equal(row.requestCount,2);assert.equal(row.timingScope,'operation');assert.equal(row.networkScope,'summed_requests');assert.equal(row.manualWaitMs,null);assert.doesNotMatch(JSON.stringify(row),/secret|authorization/);
});
