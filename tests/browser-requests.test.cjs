const test=require('node:test'),assert=require('node:assert/strict');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('browser requests keep at most six connections active and release slots after errors',{timeout:3000},async t=>{
 const {createBrowserRequestQueue}=await import('../server/lifecycle/browser-requests.mjs');let active=0,peak=0;const release=deferred();
 t.after(()=>release.resolve());const queue=createBrowserRequestQueue(async url=>{active++;peak=Math.max(peak,active);try{await release.promise;if(url==='bad')throw Error('failed');return url;}finally{active--;}});
 const jobs=Array.from({length:14},(_,i)=>queue(''+i));jobs.push(queue('bad').catch(e=>e.message));await new Promise(setImmediate);assert.equal(active,6);release.resolve();assert.equal((await Promise.all(jobs)).at(-1),'failed');assert.equal(peak,6);assert.equal(active,0);
});
test('cancelled queued requests never reach transport and navigation takes priority over queued assets',{timeout:3000},async t=>{
 const {createBrowserRequestQueue}=await import('../server/lifecycle/browser-requests.mjs');const release=deferred(),calls=[],controller=new AbortController();
 t.after(()=>release.resolve());const queue=createBrowserRequestQueue(async url=>{calls.push(url);if(url.startsWith('hold'))await release.promise;return url;});
 const held=Array.from({length:6},(_,i)=>queue('hold'+i)),asset=queue('asset'),cancelled=queue('cancelled',{signal:controller.signal}).catch(e=>e.code),navigation=queue('navigation',{},true);controller.abort();await new Promise(setImmediate);release.resolve();await Promise.all([...held,asset,navigation]);assert.equal(await cancelled,'BROWSER_REQUEST_CANCELLED');assert.equal(calls.includes('cancelled'),false);assert.ok(calls.indexOf('navigation')<calls.indexOf('asset'));
});
test('request queue is bounded and an already aborted request cannot consume a slot',{timeout:3000},async t=>{
 const {createBrowserRequestQueue}=await import('../server/lifecycle/browser-requests.mjs');const release=deferred();let calls=0;const queue=createBrowserRequestQueue(async()=>{calls++;await release.promise;});
 t.after(()=>release.resolve());const controller=new AbortController();controller.abort();await assert.rejects(queue('cancelled',{signal:controller.signal}),{code:'BROWSER_REQUEST_CANCELLED'});
 const held=Array.from({length:6},()=>queue('hold'));await new Promise(setImmediate);const pending=Array.from({length:512},()=>queue('queued'));await assert.rejects(queue('overflow'),{code:'BROWSER_REQUEST_LIMIT'});release.resolve();await Promise.all([...held,...pending]);assert.equal(calls,518);
});
test('final write guard runs after acquiring a slot, immediately before transport',{timeout:3000},async t=>{
 const {createBrowserRequestQueue}=await import('../server/lifecycle/browser-requests.mjs');const release=deferred(),calls=[];t.after(()=>release.resolve());let allowed=true,guards=0;
 const queue=createBrowserRequestQueue(async url=>{calls.push(url);if(url.startsWith('hold'))await release.promise;});
 const held=Array.from({length:6},(_,i)=>queue('hold'+i));await new Promise(setImmediate);const write=queue('publish',{},true,()=>{guards++;if(!allowed)throw Object.assign(Error('PROJECT_PAUSED'),{code:'PROJECT_PAUSED'});});const result=assert.rejects(write,{code:'PROJECT_PAUSED'});
 assert.equal(guards,0);allowed=false;release.resolve();await Promise.all(held);await result;assert.equal(guards,1);assert.equal(calls.includes('publish'),false);
});
