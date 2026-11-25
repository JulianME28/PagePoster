const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const key=Buffer.alloc(32,42).toString('base64');
async function fixture(t,source){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-google-lifetime-'));
 const app=await createLifecycleService({dataDir:dir,masterKey:key,autopilotOptions:{source},googleAuth:{status:()=>({connected:true,email:'fixture@example.com'}),close:async()=>{}},googleBrowser:{close:async()=>{}}});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 await app.autopilot.saveSource({authMode:'user',spreadsheetId:'fixtureSheetId12345',range:'Sites!A1:C100',columns:{url:'A',username:'B',password:'C'},headerRows:1});return {app,dir};
}
test('source-check HTTP request carries cancellation to the actual source read',async t=>{
 let calls=0;const {app}=await fixture(t,{readCandidates:async()=>{calls++;return {candidates:[],issues:[]};}}),controller=new AbortController();controller.abort();
 const result=await app.handle(new Request('http://localhost/api/lifecycle/autopilot/source/check',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-PagePoster-Request':'1'},body:'{}',signal:controller.signal}));
 assert.equal(result.status,400);assert.equal((await result.json()).code,'source_read_aborted');assert.equal(calls,0);
});
test('Desktop shutdown cancels a pending background donor read and preserves its waiting item',async t=>{
 let entered,observed=false;const started=new Promise(resolve=>entered=resolve),{app,dir}=await fixture(t,{readCandidates:async(config,{signal}={})=>new Promise((resolve,reject)=>{
  entered();if(!signal)return;const stop=()=>{observed=true;reject(Object.assign(Error('cancelled'),{code:'source_read_aborted'}));};if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
 })});
 const project=app.store.createProject({name:'Waiting fixture',workflowType:'html'}),page=app.store.createPage(project.id,{title:'Fixture',config:{title:'Fixture',cards:[],sections:[],faq:[]}}),id=crypto.randomUUID();
 app.store.createRecord(project.id,'autopilot',{state:'awaiting_review',stage:'selecting',source:'html',queueItemId:'fixture-item',reviewBeforePublish:true,pageId:page.id,siteSelection:{minDr:null,minTraffic:null,geo:''},destinationRevision:0,links:[]},id);
 app.start();await started;
 const closing=app.close();let timer;
 try{await Promise.race([closing,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Shutdown did not cancel Google read.')),1000);})]);}finally{clearTimeout(timer);}
 assert.equal(observed,true);
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(dir,'pageposter.sqlite'),{readOnly:true});
 try{const run=JSON.parse(db.prepare('SELECT data FROM workspace_records WHERE id=?').get(id).data);assert.equal(run.state,'awaiting_review');assert.equal(run.candidate,undefined);}finally{db.close();}
});
