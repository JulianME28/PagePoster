'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

test('queue publication metadata exposes exact saved ID and status for standalone and run-bound pages without HTML',async t=>{
 const {createStore}=await import('../server/lifecycle/store.mjs'),{createProjectQueue}=await import('../server/lifecycle/project-queue.mjs'),store=createStore({filename:':memory:'});t.after(()=>store.close());
 const project=store.createProject({name:'Queue metadata'}),page=store.createPage(project.id,{title:'Standalone',config:{title:'Standalone'},wpId:41,fullUrl:'https://published.example/one/',remoteSnapshot:{mode:'browser',status:'publish',content:'private-html-sentinel'}}),bound=store.createPage(project.id,{title:'Bound',config:{title:'Bound'},wpId:42,fullUrl:'https://published.example/two/',remoteSnapshot:{mode:'browser',status:'publish',content:'private-html-sentinel'}}),draft=store.createPage(project.id,{title:'Draft with URL',config:{title:'Draft'},wpId:43,fullUrl:'https://published.example/draft/',remoteSnapshot:{mode:'browser',status:'draft',content:'private-html-sentinel'}});
 store.createRecord(project.id,'autopilot',{pageId:bound.id,siteId:null,state:'completed',stage:'completed',publicationMode:'native',nativePublication:{postId:42,url:bound.fullUrl,phase:'published'}});
 const queue=createProjectQueue({store,autopilot:{}}).overview(),rows=queue.projects[0].items;
 assert.deepEqual(rows.find(row=>row.pageId===page.id)&&[rows.find(row=>row.pageId===page.id).wpId,rows.find(row=>row.pageId===page.id).publishedStatus],[41,'publish']);
 assert.deepEqual(rows.find(row=>row.pageId===bound.id)&&[rows.find(row=>row.pageId===bound.id).wpId,rows.find(row=>row.pageId===bound.id).publishedStatus],[42,'publish']);
 assert.equal(rows.find(row=>row.pageId===draft.id).publishedStatus,'draft');assert.ok(!JSON.stringify(queue).includes('private-html-sentinel'));assert.equal(Object.hasOwn(rows[0],'remoteSnapshot'),false);
});
