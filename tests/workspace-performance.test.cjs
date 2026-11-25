const test=require('node:test'),assert=require('node:assert/strict');
test('read snapshots reuse decoded records only within a synchronous read and refuse writes',async()=>{
 const {createStore}=await import('../server/lifecycle/store.mjs'),store=createStore({filename:':memory:'});
 try{const project=store.createProject({name:'Read fixture'}),page=store.createPage(project.id,{title:'Page',config:{importHtml:'X'.repeat(200000)}});
 store.readSnapshot(()=>{assert.equal(store.getPage(page.id).config,store.getPage(page.id).config);assert.throws(()=>store.updateProject(project.id,{name:'Wrong'},project.revision),{code:'READ_ONLY_SNAPSHOT'});});
 store.updateProject(project.id,{name:'Updated'},project.revision);assert.equal(store.readSnapshot(()=>store.getProject(project.id).name),'Updated');
 const summary=store.listPageSummaries(project.id)[0];assert.equal(summary.id,page.id);assert.equal(summary.title,'Page');assert.ok(!('config'in summary));assert.ok(!('versions'in summary));assert.ok(!('remoteSnapshot'in summary));assert.ok(JSON.stringify(summary).length<1000);assert.equal(store.getPage(page.id).config.importHtml.length,200000);
 }finally{store.close();}
});
