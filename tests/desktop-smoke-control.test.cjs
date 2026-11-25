'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('backend-closed probe rejects a real listening server that resets its accepted socket',async t=>{
 const net=require('node:net'),{once}=require('node:events'),{assertEndpointClosed}=require('../scripts/desktop-smoke-control.cjs');const server=net.createServer(socket=>socket.resetAndDestroy());server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;await assert.rejects(assertEndpointClosed(origin,{timeoutMs:1000}),e=>e.cause?.code==='ECONNRESET'||e.code==='ECONNRESET');assert.equal(server.listening,true);
});
test('desktop smoke stop bounds an absent Electron close event without skipping the quit request',async()=>{
 const {stopElectron}=require('../scripts/desktop-smoke-control.cjs');let quits=0;const app={waitForEvent:()=>new Promise(()=>{}),evaluate:async()=>{quits++;}};await assert.rejects(stopElectron(app,{timeoutMs:20}),e=>e.code==='DESKTOP_SMOKE_STOP_TIMEOUT');assert.equal(quits,1);
});
test('desktop smoke reports its original failure before bounded cleanup and preserves it',async()=>{
 const {cleanupSmoke}=require('../scripts/desktop-smoke-control.cjs'),events=[],failure=Error('original assertion');const cleanup=cleanupSmoke({close:()=>new Promise(()=>{})},{failure,timeoutMs:20,report:event=>events.push(event)});assert.equal(events[0].event,'failure');assert.equal(events[0].message,'original assertion');await cleanup;assert.equal(events[1].event,'cleanup_failure');assert.equal(events[1].code,'DESKTOP_SMOKE_CLEANUP_TIMEOUT');
});
test('backend-closed probe requires a refused endpoint and never accepts a hung fetch as proof',async()=>{
 const {assertEndpointClosed}=require('../scripts/desktop-smoke-control.cjs');await assertEndpointClosed('http://127.0.0.1:12345',{fetchImpl:async()=>{throw Object.assign(Error('fetch failed'),{cause:{code:'ECONNREFUSED'}});},timeoutMs:20});await assert.rejects(assertEndpointClosed('http://127.0.0.1:12345',{fetchImpl:()=>new Promise(()=>{}),timeoutMs:20}),e=>e.code==='DESKTOP_SMOKE_ENDPOINT_TIMEOUT');await assert.rejects(assertEndpointClosed('http://127.0.0.1:12345',{fetchImpl:async()=>({status:401}),timeoutMs:20}),/still responds/);
});
