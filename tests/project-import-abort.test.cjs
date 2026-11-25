const test=require('node:test'),assert=require('node:assert/strict');

test('the project import HTTP handler forwards cancellation before obtaining Google credentials',async()=>{
 const {createProjectQueue}=await import('../server/lifecycle/project-queue.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 let tokenCalls=0,readCalls=0;const importer=createProjectImporter({getAccessToken:async()=>{tokenCalls++;return 'fixture-token';},transport:async url=>{readCalls++;return {url,status:200,text:JSON.stringify({values:[['key','url','anchor'],['one','https://target.example','Exact anchor']]})};}});
 const queue=createProjectQueue({store:{},autopilot:{},importer}),controller=new AbortController();controller.abort();
 const request=new Request('http://localhost/api/lifecycle/project-import/preview',{method:'POST',signal:controller.signal});
 const response=await queue.handle(request,'/project-import/preview',async()=>({type:'ai',spreadsheetUrl:'fixture-sheet'})),result=await response.json();
 assert.equal(response.status,200);assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'GOOGLE_READ_ABORTED');assert.equal(tokenCalls,0);assert.equal(readCalls,0);
});
