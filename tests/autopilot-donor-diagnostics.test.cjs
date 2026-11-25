'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const key=Buffer.alloc(32,94).toString('base64'),username='diagnostic-private-user',password='diagnostic-private-password',privateKey='diagnostic-private-source-key';
const pl={minDr:20,minTraffic:50,geo:'PL'},hu={minDr:20,minTraffic:50,geo:'HU'};
const sourceConfig={spreadsheetId:'fixtureDiagnostics12345',range:'Sites!A1:G100',serviceAccount:{client_email:'reader@fixture.example',private_key:privateKey},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F',enabled:'G'},headerRows:1};
const row=(host,dr=50,traffic=100,geo='PL',enabled='true')=>[host,username,password,dr,traffic,geo,enabled];
const values=[['URL','Username','Password','DR','Traffic','GEO','Enabled'],
 row('published-diagnostic.example',60,200),row('https://published-diagnostic.example/blog/',80,300,'HU'),
 row('reserved-diagnostic.example'),row('excluded-diagnostic.example'),
 row('unknown-diagnostic.example','','',''),row('https://unknown-diagnostic.example/blog/','','',''),row('hu-free-diagnostic.example',45,100,'HU'),
 row('disabled-diagnostic.example',50,100,'PL','false'),row('not a valid url'),'diagnostic-private-malformed-row',row('bad-flag-diagnostic.example',50,100,'PL','maybe'),
 ['no-login-diagnostic.example','','',50,100,'PL','true'],[]];
const input={unit:'rows',nonempty:12,disabled:1,invalidUrl:1,invalidRow:2,missingCredentials:1};
const unknown={unit:'origins',dr:1,traffic:1,geo:1},unavailable={unit:'origins',published:1,reserved:1,excluded:1,other:0,manual:0,temporary:0,credentials:1,visual:0,security:0};
function aggregateOnly(diagnostics){const text=JSON.stringify(diagnostics);assert.doesNotMatch(text,/https?:|\.example|diagnostic-private|ciphertext|candidateCredential|rowNumber/);}
function assertShortage(diagnostics){
 assert.deepEqual(diagnostics,{criteria:pl,total:5,geo:3,dr:3,eligible:3,reserved:3,available:0,input,unknown,unavailable});aggregateOnly(diagnostics);
 assert.equal(diagnostics.unavailable.published+diagnostics.unavailable.reserved+diagnostics.unavailable.excluded+diagnostics.unavailable.other,diagnostics.reserved);
}
async function fixture(t){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createSecretBox}=await import('../server/lifecycle/secrets.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-donor-diagnostics-'));let reads=0;
 const forbidden=()=>assert.fail('Donor diagnostics must not contact Google, WordPress, a browser or paid APIs'),source=createSiteSource({transport:forbidden,readSheet:async()=>{reads++;return {values:structuredClone(values)};}});
 const service=await createLifecycleService({dataDir:dir,masterKey:key,autopilotOptions:{source,bootstrapFactory:forbidden},visibleBrowser:{nativeEditor:true,prepare:forbidden,open:forbidden,reset:async()=>{},close:async()=>{}},client:{checkSite:forbidden,checkPage:forbidden},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:forbidden}});
 t.after(async()=>{await service.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'pp-donor-diagnostics-'));fs.rmSync(dir,{recursive:true,force:true});});
 async function q(route,body){const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.ok(response);const text=await response.text();for(const secret of [username,password,privateKey,'diagnostic-private-malformed-row'])assert.ok(!text.includes(secret),'Private sheet data escaped into an API response');return {status:response.status,...JSON.parse(text)};}
 const imported=await q('/project-queue/import',{idempotencyKey:randomUUID(),name:'Synthetic diagnostic groups',type:'html',items:[pl,hu].map((criteria,index)=>({key:'diagnostic-page-'+index,source:'html',title:'Diagnostic page '+index,html:'<h1>Exact diagnostic material '+index+'</h1><p>Preserved local HTML.</p>',language:index?'hu':'pl',geo:criteria.geo,siteSelection:criteria}))});assert.equal(imported.status,201);
 const projectId=imported.project.id,project=service.store.getProject(projectId);service.store.updateProject(projectId,{siteSelection:pl},project.revision);
 for(let attempt=0;attempt<4;attempt++)await service.tick({lane:'generation'});
 const runs=service.store.listRecords(projectId,'autopilot');assert.equal(runs.length,2);assert.ok(runs.every(run=>run.state==='awaiting_review'&&run.stage==='selecting'&&!run.candidate));assert.equal(reads,0);
 const owner=service.store.createProject({name:'Synthetic existing donor ownership'}),template=service.store.getPage(runs[0].pageId),box=createSecretBox(key);
 for(const [id,host]of [['published-reservation','published-diagnostic.example'],['prepared-reservation','reserved-diagnostic.example']]){const page=service.store.createPage(owner.id,{title:'Prepared local holder',config:template.config});service.store.createRecord(owner.id,'autopilot',{source:'html',state:'awaiting_review',stage:'installing',queueItemId:'held-'+id,reviewBeforePublish:true,pageId:page.id,siteSelection:pl,candidate:{id,baseUrl:'https://'+host+'/',rowNumber:2,metrics:{dr:50,traffic:100,geo:['PL']}},candidateCredential:box.encrypt(id,{username,applicationPassword:password})},id);}
 const site=service.store.createSite(owner.id,{name:'Synthetic already published origin',baseUrl:'https://published-diagnostic.example/'});service.store.createPage(owner.id,{title:'Already bound fixture page',siteId:site.id,wpId:17,fullUrl:'https://published-diagnostic.example/existing/'});
 service.store.createRecord(owner.id,'autopilot',{source:'html',state:'paused',stage:'selecting',donorSkips:['published-diagnostic.example','reserved-diagnostic.example','excluded-diagnostic.example'].map((host,index)=>({id:'history-'+index,baseUrl:'https://'+host+'/',code:'bootstrap_auth_failed',at:new Date().toISOString()}))},randomUUID());
 const configured=await q('/autopilot/source',sourceConfig);assert.equal(configured.status,200);assert.equal(configured.source.configured,true);
 return {service,q,projectId,runs,get reads(){return reads;},shortage:()=>service.autopilot.list(projectId).find(run=>run.selectionDiagnostics),queue:()=>q('/project-queue')};
}

test('source check wires persisted ownership precedence, row issues and unique unknown origins into every criteria group',async t=>{
 const f=await fixture(t),checked=await f.q('/autopilot/source/check',{projectId:f.projectId});assert.equal(checked.status,200);assert.equal(checked.candidateCount,0);assert.equal(checked.issueCount,4);assertShortage(checked.diagnostics);assert.equal(f.reads,1);
 assert.deepEqual(checked.groups.map(group=>({criteria:group.criteria,pages:group.pages,selected:group.selected,total:group.total,geo:group.geo,dr:group.dr,eligible:group.eligible,reserved:group.reserved,available:group.available,unavailable:group.unavailable})),[
  {criteria:pl,pages:1,selected:0,total:5,geo:3,dr:3,eligible:3,reserved:3,available:0,unavailable},
  {criteria:hu,pages:1,selected:0,total:5,geo:2,dr:2,eligible:2,reserved:1,available:1,unavailable:{unit:'origins',published:1,reserved:0,excluded:0,other:0,manual:0,temporary:0,credentials:0,visual:0,security:0}}
 ]);for(const group of checked.groups){assert.deepEqual(group.input,input);assert.deepEqual(group.unknown,unknown);aggregateOnly(group);}
 await f.service.autopilot.selectPending();const shortage=f.shortage();assert.equal(shortage.error.code,'SOURCE_EMPTY');assert.equal(shortage.state,'needs_attention');assertShortage(shortage.selectionDiagnostics);assert.equal(f.reads,2);
 const queued=await f.queue(),item=queued.projects.find(project=>project.projectId===f.projectId).items.find(item=>item.geo==='PL');assertShortage(item.selectionDiagnostics);assert.equal(item.selectedSite,null);
});

test('catalogue-cached source input diagnostics survive selectPending shortage and subsequent grouped source checks',async t=>{
 const f=await fixture(t),plRun=f.runs.find(run=>run.siteSelection.geo==='PL'),catalog=await f.q('/autopilot/'+plRun.id+'/donors');assert.equal(catalog.status,200);assert.equal(catalog.total,3);assert.equal(catalog.candidates.filter(candidate=>candidate.available===false).length,2);const historical=catalog.candidates.find(candidate=>candidate.baseUrl==='https://excluded-diagnostic.example/');assert.equal(historical.available,true);assert.ok(historical.warning);assert.equal(f.reads,1);
 await f.service.autopilot.selectPending();assert.equal(f.reads,1,'selectPending must use the exact pool already read by the catalogue');const shortage=f.shortage();assert.equal(shortage.id,plRun.id);assert.equal(shortage.error.code,'SOURCE_EMPTY');assertShortage(shortage.selectionDiagnostics);
 const selected=f.service.autopilot.list(f.projectId).find(run=>run.id!==plRun.id);assert.equal(selected.selectedDomain,'https://hu-free-diagnostic.example/');assert.equal(selected.state,'awaiting_review');assert.equal(selected.stage,'installing');
 const checked=await f.q('/autopilot/source/check',{projectId:f.projectId});assert.equal(checked.status,200);assertShortage(checked.diagnostics);assert.equal(f.reads,2);const groups=checked.groups;assert.deepEqual(groups.map(group=>({geo:group.criteria.geo,pages:group.pages,selected:group.selected,available:group.available})),[{geo:'PL',pages:1,selected:0,available:0},{geo:'HU',pages:1,selected:1,available:0}]);assert.deepEqual(groups.find(group=>group.criteria.geo==='HU').unavailable,{unit:'origins',published:1,reserved:1,excluded:0,other:0,manual:0,temporary:0,credentials:0,visual:0,security:0});for(const group of groups){assert.deepEqual(group.input,input);assert.deepEqual(group.unknown,unknown);aggregateOnly(group);}
});
