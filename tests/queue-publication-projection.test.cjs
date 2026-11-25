'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('queue item publication uses the same bounded native projection as the run contract',async()=>{
 const {createProjectQueue}=await import('../server/lifecycle/project-queue.mjs'),{publicPublication}=await import('../server/lifecycle/publication-diagnostics.mjs');
 const page={id:'page',title:'Fixture',wpId:1106,fullUrl:'https://fixture.invalid/exact%2Fpath',verification:{state:'unknown'},revision:2},run={id:'run',kind:'autopilot',projectId:'p',pageId:'page',publicationMode:'native',nativePublication:{phase:'published',postId:1106,url:page.fullUrl},state:'needs_attention',stage:'publishing',revision:7,publicationDiagnostics:[{phase:'check',code:'CHECK_FAILED',elapsedMs:1200,raw:'PRIVATE'}],input:{source:'html',siteSelection:{geo:'GB'}},siteSelection:{geo:'GB'},links:[]},project={id:'p',name:'Fixture',revision:1};
 const store={listProjects:()=>[project],listRecords:(id,kind)=>kind==='autopilot'?[run]:[],getRecord:id=>id==='run'?run:null,getPage:id=>id==='page'?page:null,getProject:()=>project,listPages:()=>[page],listJobs:()=>[]};
 const queue=createProjectQueue({store,clock:()=>1000,autopilot:{destinationStatus:()=>({canSetDestination:false})}}),item=queue.overview().projects[0].items[0];
 assert.deepEqual(item.publication,publicPublication(run,page,{now:1000}));assert.equal(item.publication.state,'verification_unknown');assert.equal(item.publication.postId,1106);assert.doesNotMatch(JSON.stringify(item.publication),/PRIVATE/);
});
