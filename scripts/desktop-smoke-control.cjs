'use strict';
const assert=require('node:assert/strict');
const timeoutError=code=>Object.assign(Error(code),{code});
async function withDeadline(action,timeoutMs,code){let timer;try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError(code)),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function stopElectron(app,{timeoutMs=30000}={}){
 return withDeadline(async()=>{const closed=app.waitForEvent('close',{timeout:timeoutMs});await Promise.all([closed,app.evaluate(({app})=>{setTimeout(()=>app.quit(),50);})]);},timeoutMs,'DESKTOP_SMOKE_STOP_TIMEOUT');
}
async function cleanupSmoke(app,{failure=null,timeoutMs=5000,report=event=>console.error(JSON.stringify(event))}={}){
 // Report the assertion before entering cleanup: Electron close can itself hang
 // when graceful shutdown is waiting for a backend connection to finish.
 if(failure)report({event:'failure',code:failure.code||null,message:failure.message});
 if(!app)return;
 try{await withDeadline(()=>app.close(),timeoutMs,'DESKTOP_SMOKE_CLEANUP_TIMEOUT');}catch(error){report({event:'cleanup_failure',code:error.code||null,message:error.message});if(!failure)throw error;}
}
async function assertEndpointClosed(origin,{fetchImpl=fetch,timeoutMs=5000}={}){
 assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'Smoke probe must target its isolated loopback endpoint');
 try{await withDeadline(()=>fetchImpl(origin+'/api/lifecycle/status',{signal:AbortSignal.timeout(timeoutMs),headers:{Connection:'close'}}),timeoutMs,'DESKTOP_SMOKE_ENDPOINT_TIMEOUT');}
 catch(error){if(error.code==='DESKTOP_SMOKE_ENDPOINT_TIMEOUT'||['TimeoutError','AbortError'].includes(error.name))throw timeoutError('DESKTOP_SMOKE_ENDPOINT_TIMEOUT');if((error.cause?.code||error.code)==='ECONNREFUSED')return;throw error;}
 assert.fail('Desktop backend still responds after graceful exit');
}
module.exports={stopElectron,cleanupSmoke,assertEndpointClosed};
