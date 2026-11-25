'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const key=Buffer.alloc(32,39).toString('base64'),baseUrl='https://account-fixture.example/',credentials={username:'PRIVATE_USER',applicationPassword:'PRIVATE_PASSWORD'};
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-capabilities-')),storeMod=await import('../server/lifecycle/store.mjs');let store=storeMod.createStore({filename:path.join(dir,'fixture.sqlite'),masterKey:key}),now=Date.UTC(2026,10,2);const project=store.createProject({name:'Fixture'}),other=store.createProject({name:'Other'});const {createAccountCapabilityHistory}=await import('../server/lifecycle/account-capabilities.mjs');const open=()=>createAccountCapabilityHistory({store,masterKey:key,clock:()=>now});let history=open();t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {project,other,get history(){return history;},get store(){return store;},setTime:value=>{now=value;},restart(){store.close();store=storeMod.createStore({filename:path.join(dir,'fixture.sqlite'),masterKey:key});history=open();}};}
const scope={runId:'fixture-run',destinationRevision:1,publicationAttempt:0};
test('primary and backup observations survive restart without persisting credentials',async t=>{
 const f=await fixture(t),first=f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'login',facts:{login:true}});
 f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'plugin',facts:{pluginAccess:false,plugin:'unavailable'}});
 const second=f.history.observe({projectId:f.project.id,baseUrl,credentials:{username:'PRIVATE_BACKUP',applicationPassword:'PRIVATE_BACKUP_PASSWORD'},accountIndex:1,scope,phase:'login',facts:{login:true}});
 f.restart();const view=f.history.view({projectId:f.project.id,baseUrl,accountRef:second.accountRef,scope});
 assert.equal(view.rows.length,2);assert.equal(view.rows[0].facts.login.value,true);assert.equal(view.rows[0].facts.pluginAccess.value,false);assert.equal(view.rows[1].accountIndex,1);assert.equal(view.rows[1].active,true);assert.equal(view.rows[1].observedInThisRun,true);assert.equal(first.historyId,second.historyId);
 const stored=f.store.getRecord(first.historyId);assert.doesNotMatch(JSON.stringify(stored),/PRIVATE_/);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|accountRef|historyId|fixture-run|account-fixture/);
 assert.equal(f.history.view({projectId:f.other.id,baseUrl,accountRef:second.accountRef,scope}).rows.length,0);
});
test('changed credentials and donor identities retain history but cannot reuse old proof as current',async t=>{
 const f=await fixture(t),old=f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'login',facts:{login:true}});
 const next=f.history.observe({projectId:f.project.id,baseUrl,credentials:{...credentials,applicationPassword:'CHANGED_PASSWORD'},accountIndex:0,scope:{...scope,runId:'new-run'},phase:'login',facts:{login:false}});
 assert.notEqual(old.accountRef,next.accountRef);const view=f.history.view({projectId:f.project.id,baseUrl,accountRef:next.accountRef,scope:{...scope,runId:'new-run'}});
 assert.equal(view.rows.length,2);assert.equal(view.rows[0].active,false);assert.equal(view.rows[0].observedInThisRun,false);assert.equal(view.rows[1].facts.login.value,false);
 assert.equal(f.history.view({projectId:f.project.id,baseUrl:'https://different.example/',accountRef:next.accountRef,scope}).rows.length,0);
 assert.equal(f.history.view({projectId:f.project.id,baseUrl:'https://account-fixture.example/other/',accountRef:next.accountRef,scope}).rows.length,0);
 f.setTime(Date.UTC(2026,10,4));assert.ok(f.history.view({projectId:f.project.id,baseUrl,accountRef:next.accountRef,scope}).rows.every(row=>row.stale));
});
test('only real phase-compatible facts enter history; a read preflight cannot promise markup preservation',async t=>{
 const f=await fixture(t);
 for(const input of [{phase:'preflight',facts:{markup:true}},{phase:'login',facts:{markup:true,login:'yes'}},{phase:'plugin',facts:{pluginAccess:'PRIVATE_SECRET',html:'PRIVATE_SECRET'}}])assert.equal(f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,...input}),null);
 assert.equal(f.history.view({projectId:f.project.id,baseUrl,scope}).rows.length,0);
 const proof=f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'markup',facts:{markup:true},postId:42});
 assert.equal(f.history.view({projectId:f.project.id,baseUrl,accountRef:proof.accountRef,scope}).rows[0].facts.markup.value,true);
 assert.equal(f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'markup',facts:{markup:true}}),null);
});
test('history bounds accounts and events and distinguishes actual unknown plugin outcome from access denial',async t=>{
 const f=await fixture(t);let latest;
 for(let i=0;i<12;i++)latest=f.history.observe({projectId:f.project.id,baseUrl,credentials:{username:'private-'+i,applicationPassword:'private-'+i},accountIndex:i%2,scope,phase:'plugin',facts:{plugin:'unavailable'}});
 for(let i=0;i<40;i++)f.history.observe({projectId:f.project.id,baseUrl,credentials:{username:'private-11',applicationPassword:'private-11'},accountIndex:1,scope,phase:'plugin',facts:{plugin:'active',pluginAccess:true}});
 const view=f.history.view({projectId:f.project.id,baseUrl,accountRef:latest.accountRef,scope}),stored=f.store.getRecord(latest.historyId);
 assert.ok(view.rows.length<=8);assert.equal(view.truncated,true);assert.ok(stored.accounts.every(row=>row.events.length<=32));assert.equal(view.rows[0].facts.pluginAccess,undefined);assert.equal(view.rows.at(-1).facts.pluginAccess.value,true);
});
test('last known facts survive event-ring eviction and retain per-fact observation provenance',async t=>{
 const f=await fixture(t),first=f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope,phase:'login',facts:{login:true}});
 for(let i=0;i<40;i++)f.history.observe({projectId:f.project.id,baseUrl,credentials,accountIndex:0,scope:{...scope,runId:'next-run'},phase:'plugin',facts:{plugin:'active'}});
 const view=f.history.view({projectId:f.project.id,baseUrl,accountRef:first.accountRef,scope:{...scope,runId:'next-run'}});
 assert.equal(view.rows[0].facts.login?.value,true);assert.equal(view.rows[0].facts.login?.observedInThisRun,false);assert.equal(view.rows[0].facts.plugin?.observedInThisRun,true);
});
test('normal publication projection recomputes cached history age after days and marks old individual facts',async()=>{
 const {publicPublication}=await import('../server/lifecycle/publication-diagnostics.mjs'),at='2026-11-02T00:00:00.000Z',now=Date.parse(at)+3*86400000;
 const history={rows:[{accountIndex:0,active:true,observedInThisRun:true,stale:false,firstSeenAt:at,lastSeenAt:new Date(now).toISOString(),facts:{login:{value:true,at,observedInThisRun:true},plugin:{value:'active',at:new Date(now).toISOString(),observedInThisRun:true}}}],truncated:false};
 const run={publicationMode:'native',state:'completed',publicationCapabilities:{history},nativePublication:{postId:42,phase:'published'}};
 const first=publicPublication(run,{}, {now});assert.equal(first.capabilities.history.rows[0].facts.login.stale,true);assert.equal(first.capabilities.history.rows[0].facts.plugin.stale,false);
 assert.equal(publicPublication(run,{}, {now:now+2*86400000}).capabilities.history.rows[0].stale,true);
});
