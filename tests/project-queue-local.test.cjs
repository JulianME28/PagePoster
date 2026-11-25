const test=require('node:test'),assert=require('node:assert/strict');
test('local runtime serves both project queue assets referenced by its workspace',async t=>{
 const server=await require('../server/local.cjs').createLocalServer({env:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await server.closeResources();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const name of ['project-queue-ui.js','project-queue.css']){const r=await fetch(origin+'/'+name);assert.equal(r.status,200,name);assert.match(r.headers.get('content-type'),name.endsWith('.js')?/javascript/:/text\/css/);assert.ok((await r.text()).length>100);}
});
