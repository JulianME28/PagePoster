'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const key=Buffer.alloc(32,111).toString('base64'),start=Date.parse('2026-11-03T12:00:00.000Z');
const sourceConfig={authMode:'user',spreadsheetId:'policySheet12345',range:'Sites!A1:H100',headerRows:1,columns:{url:'A',username:'B',password:'C',alternateUsername:'D',alternatePassword:'E',dr:'F',traffic:'G',geo:'H'}};
const principal='policy-reader@fixture.example',secrets=['policy-primary-user','policy-primary-password','policy-alternate-user','policy-alternate-password','policy-corrected-password'];
const donor=(id='alpha')=>({id,baseUrl:'https://'+id+'.example/',rowNumber:2,username:secrets[0],password:secrets[1],alternateCredentials:{username:secrets[2],password:secrets[3]},metrics:{dr:80,traffic:15000,geo:['PL']}});
const sourceIdentity=(config=sourceConfig,readerPrincipal=principal)=>({spreadsheetId:config.spreadsheetId,sheetName:'Sites',range:config.range,columns:config.columns,headerRows:config.headerRows,authMode:config.authMode,readerPrincipal});
function assertPrivate(value){const encoded=typeof value==='string'?value:JSON.stringify(value);for(const secret of secrets)assert.ok(!encoded.includes(secret),'A credential escaped its private boundary');assert.doesNotMatch(encoded,/"(?:sourceRef|credentialRefs?|keyMarker|materialRef|candidateCredential|alternateCredential|ciphertext)"/);}

async function fixture(t,{candidates=[donor()],picker=false}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{createDonorExclusions}=await import('../server/lifecycle/donor-exclusions.mjs'),{createSecretBox}=await import('../server/lifecycle/secrets.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-policy-integration-'));let now=start,reads=0,remoteCalls=0,rows=structuredClone(candidates),account={connected:true,email:principal,phase:'connected'},service;
 const forbidden=()=>{remoteCalls++;assert.fail('Donor policy integration must not perform network, browser publication, generation, or paid API actions.');},remote=new Proxy({},{get:()=>forbidden});
 const source=picker?{pickUnused:async(_config,input)=>{reads++;return structuredClone(rows.find(candidate=>!input.usedRowIds.includes(candidate.id)&&!input.usedOrigins.includes(new URL(candidate.baseUrl).origin))||null);}}:{readCandidates:async(config,input)=>{reads++;assert.deepEqual(input.criteria,{minDr:null,minTraffic:null,geo:''});assert.equal(input.preserveOrigins,true);return {candidates:structuredClone(rows),issues:[],sourceIdentity:sourceIdentity(config,account.email)};},pickUnused:forbidden};
 const settings={dataDir:dir,masterKey:key,clock:()=>now,googleAuth:{status:()=>account,accessToken:forbidden,close:async()=>{}},autopilotOptions:{source,planner:{generate:forbidden},bootstrapFactory:forbidden},client:remote,bridgeClient:remote,browserVerifier:remote};
 service=await createLifecycleService(settings);
 t.after(async()=>{await service.close();assert.equal(remoteCalls,0);const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^pp-policy-integration-/);fs.rmSync(target,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.ok(response,'Service must handle '+route);const text=await response.text();assertPrivate(text);return {status:response.status,...JSON.parse(text)};};
 const raw=id=>service.store.getRecord(id),patch=(id,changes)=>{const current=raw(id);return service.store.updateRecord(id,changes,current.revision);};
 const policy=()=>createDonorExclusions({store:service.store,masterKey:key,clock:()=>now,allRuns:()=>service.store.listProjects().flatMap(project=>service.store.listRecords(project.id,'autopilot'))});
 const add=async(name='Prepared policy material')=>{
  const imported=await q('/project-queue/import',{idempotencyKey:randomUUID(),name,type:'html',items:[{key:'one',source:'html',title:name,html:'<!doctype html><html><body><h1>'+name+'</h1><p>Keep exact authored material and <a href="https://offer.example/?x=%2f&amp;b=2#A">Exact anchor</a>.</p></body></html>',language:'pl',geo:'PL',siteSelection:{minDr:20,minTraffic:100,geo:'PL'}}]});assert.equal(imported.status,201,JSON.stringify(imported));
  const item=service.store.listRecords(imported.project.id,'project_queue_item')[0];
  for(let pass=0;pass<6;pass++){service.projectQueue.feed();await service.autopilot.tick({lane:'generation',slot:0});if(raw(item.runId)?.pageId&&raw(item.runId).stage==='selecting')break;}
  const run=raw(item.runId);assert.ok(run?.pageId);assert.equal(run.stage,'selecting');assert.equal(run.candidate??null,null);return {project:imported.project,item,runId:run.id};
 };
 const configure=async(config=sourceConfig)=>{const result=await q('/autopilot/source',config);assert.equal(result.status,200,JSON.stringify(result));};
 const list=(runId,query='')=>q('/autopilot/'+runId+'/donors'+query),choose=(runId,catalog,candidateId='alpha')=>q('/autopilot/'+runId+'/donor',{token:catalog.token,candidateId,expectedRevision:catalog.destinationRevision});
 const snapshot=async runId=>{const run=raw(runId);return {run,page:service.store.getPage(run.pageId),html:(await q('/autopilot/'+runId+'/html')).html};};
 const assertMaterial=async saved=>{const run=raw(saved.run.id);assert.equal(run.pageId,saved.run.pageId);assert.equal(run.requestHash,saved.run.requestHash);assert.equal(run.source,saved.run.source);assert.deepEqual(service.store.getPage(run.pageId),saved.page);assert.equal((await q('/autopilot/'+run.id+'/html')).html,saved.html);assert.equal(run.publicationApproval??null,null);assert.equal(run.jobId??null,null);};
 const ban=async(origin='https://alpha.example/',expectedRevision=0)=>{const result=await q('/autopilot/donor-exclusions/ban',{origin,expectedRevision});assert.ok([200,201].includes(result.status),JSON.stringify(result));const listing=await q('/autopilot/donor-exclusions?state=active');assert.equal(listing.status,200);const record=listing.items.find(item=>item.type==='manual'&&item.origin===new URL(origin).origin);assert.ok(record);return record;};
 const release=record=>q('/autopilot/donor-exclusions/release',{id:record.id,expectedRevision:record.revision});
 const history=(projectId,skips)=>service.store.createRecord(projectId,'autopilot',{source:'html',state:'failed',stage:'selecting',pageId:null,donorSkips:skips},randomUUID());
 return {q,add,configure,list,choose,raw,patch,policy,snapshot,assertMaterial,ban,release,history,box:createSecretBox(key),get s(){return service;},get reads(){return reads;},get now(){return now;},advance:ms=>now+=ms,setRows:value=>{rows=structuredClone(value);},setAccount:changes=>{account={...account,...changes};},restart:async()=>{await service.close();service=await createLifecycleService(settings);}};
}

test('another run regains a legacy transient donor at the exact 15-minute boundary without changing prepared material',async t=>{
 const f=await fixture(t),item=await f.add(),saved=await f.snapshot(item.runId);f.history(item.project.id,[{id:'alpha',baseUrl:donor().baseUrl,code:'BROWSER_PAGE_UNAVAILABLE',at:new Date(start-899999).toISOString()}]);await f.configure();await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate??null,null);assert.equal(f.raw(item.runId).state,'needs_attention');
 f.advance(1);assert.equal((await f.q('/project-queue/items/'+item.item.id+'/retry',{})).status,200);await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate?.id,'alpha');await f.assertMaterial(saved);
});

test('release, expiry and restart never retry a donor already skipped by the current run or approve its material',async t=>{
 const f=await fixture(t),item=await f.add(),skip={id:'alpha',baseUrl:donor().baseUrl,code:'network_timeout',at:new Date(start).toISOString()};f.patch(item.runId,{donorSkips:[skip]});await f.configure();f.advance(900000);await f.restart();
 const saved=await f.snapshot(item.runId),listing=await f.q('/autopilot/donor-exclusions?state=all');assert.equal(listing.status,200);const record=listing.items.find(row=>row.origin==='https://alpha.example');assert.ok(record);assert.equal((await f.release(record)).status,200);assert.deepEqual(f.raw(item.runId),saved.run,'Release changes policy history only');
 await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate??null,null);assert.deepEqual(f.raw(item.runId).donorSkips,[skip]);await f.assertMaterial(saved);
});

test('a typed primary rejection selects and encrypts the good alternate before any browser or remote action',async t=>{
 const f=await fixture(t),item=await f.add(),saved=await f.snapshot(item.runId);f.policy().observe({runId:'prior-login-run',origin:donor().baseUrl,code:'bootstrap_auth_failed',sourceIdentity:sourceIdentity(),credentials:donor(),proof:{loginRejectedBeforeWrites:true}});await f.configure();await f.s.autopilot.selectPending();
 const run=f.raw(item.runId);assert.equal(run.candidate?.id,'alpha');assert.deepEqual(f.box.decrypt(run.id,run.candidateCredential),{username:secrets[2],applicationPassword:secrets[3]});assert.equal(run.alternateCredential??null,null);for(const secret of secrets)assert.ok(!JSON.stringify(run).includes(secret));await f.assertMaterial(saved);await f.restart();assert.deepEqual(f.box.decrypt(run.id,f.raw(run.id).candidateCredential),{username:secrets[2],applicationPassword:secrets[3]});
});

for(const change of ['password','source','reader'])test('a changed '+change+' does not inherit rejection of an exact source and credential pair',async t=>{
 const candidate=donor();delete candidate.alternateCredentials;const f=await fixture(t,{candidates:[candidate]}),item=await f.add();f.policy().observe({runId:'prior-login-run',origin:candidate.baseUrl,code:'bootstrap_auth_failed',sourceIdentity:sourceIdentity(),credentials:candidate,proof:{loginRejectedBeforeWrites:true}});
 let config=sourceConfig;if(change==='password')f.setRows([{...candidate,password:secrets[4]}]);if(change==='source')config={...sourceConfig,range:'Sites!A1:H200'};if(change==='reader')f.setAccount({email:'other-policy-reader@fixture.example'});await f.configure(config);await f.s.autopilot.selectPending();const run=f.raw(item.runId);assert.equal(run.candidate?.id,'alpha');assert.deepEqual(f.box.decrypt(run.id,run.candidateCredential),{username:secrets[0],applicationPassword:change==='password'?secrets[4]:secrets[1]});
});

test('rejecting both exact pairs blocks automatic selection without converting one account failure into an origin ban',async t=>{
 const f=await fixture(t),item=await f.add();for(const credentials of [donor(),donor().alternateCredentials])f.policy().observe({runId:'prior-login-run',origin:donor().baseUrl,code:'bootstrap_auth_failed',sourceIdentity:sourceIdentity(),credentials,proof:{loginRejectedBeforeWrites:true}});await f.configure();await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate??null,null);assert.equal(f.raw(item.runId).state,'needs_attention');assert.equal(f.s.store.listPolicyRecords('donor_exclusion').filter(record=>record.type==='manual').length,0);
});

test('legacy picker admission applies typed pair suppression to the credentials actually encrypted for the chosen donor',async t=>{
 const f=await fixture(t,{picker:true}),item=await f.add();f.policy().observe({runId:'prior-picker-login',origin:donor().baseUrl,code:'bootstrap_auth_failed',sourceIdentity:sourceIdentity(),credentials:donor(),proof:{loginRejectedBeforeWrites:true}});await f.configure();await f.s.autopilot.selectPending();const run=f.raw(item.runId);assert.equal(run.candidate?.id,'alpha');assert.deepEqual(f.box.decrypt(run.id,run.candidateCredential),{username:secrets[2],applicationPassword:secrets[3]});assert.equal(f.reads,1);assert.equal(run.publicationApproval??null,null);
});

test('workspace manual bans are revision-bound, searchable and cannot be overridden with catalogue all=1',async t=>{
 const f=await fixture(t),item=await f.add(),saved=await f.snapshot(item.runId);await f.configure();const record=await f.ban('https://alpha.example/blog/');assert.equal(record.active,true);assert.equal(record.expiresAt,null);
 const catalog=await f.list(item.runId,'?all=1'),row=catalog.candidates.find(candidate=>candidate.id==='alpha');assert.equal(catalog.status,200);assert.ok(row);assert.equal(row.available,false);assert.ok(row.reason);assert.equal((await f.choose(item.runId,catalog)).status,409);assert.equal(f.raw(item.runId).candidate??null,null);
 assert.equal((await f.q('/autopilot/donor-exclusions/ban',{origin:'https://alpha.example/',expectedRevision:0})).status,409);assert.equal((await f.q('/autopilot/donor-exclusions?search=ALPHA.EXAMPLE&offset=0&limit=1&state=active')).items.length,1);assert.equal((await f.q('/autopilot/donor-exclusions?search=absent.example&state=all')).total,0);
 assert.equal((await f.release(record)).status,200);assert.equal((await f.release(record)).status,409);const available=await f.list(item.runId,'?all=1');assert.equal(available.candidates.find(candidate=>candidate.id==='alpha').available,true);assert.equal((await f.q('/autopilot/donor-exclusions?state=active')).items.some(item=>item.id===record.id),false);await f.assertMaterial(saved);
});

test('ban and release invalidate an already returned donor choice even when the origin is eligible again',async t=>{
 const f=await fixture(t),item=await f.add();await f.configure();const before=await f.list(item.runId),record=await f.ban();assert.equal((await f.release(record)).status,200);const stale=await f.choose(item.runId,before);assert.equal(stale.status,409);assert.equal(stale.code,'DONOR_SELECTION_EXPIRED');assert.equal(f.raw(item.runId).candidate??null,null);const fresh=await f.list(item.runId);assert.equal((await f.choose(item.runId,fresh)).status,200);assert.equal(f.raw(item.runId).publicationApproval??null,null);
});

test('cached raw source candidates are re-evaluated against current policy and restart retains the ban',async t=>{
 const f=await fixture(t),item=await f.add();await f.configure();assert.equal((await f.list(item.runId)).candidates[0].available,true);assert.equal(f.reads,1);
 const record=f.policy().setManualBan({origin:'https://alpha.example/',expectedRevision:0});assert.equal((await f.list(item.runId)).candidates[0].available,false);assert.equal(f.reads,1,'Policy changes must be applied to cached source data');f.policy().release({id:record.id,expectedRevision:record.revision});assert.equal((await f.list(item.runId)).candidates[0].available,true);assert.equal(f.reads,1);
 const released=f.policy().listPublic({state:'all'}).items.find(item=>item.id===record.id);f.policy().setManualBan({origin:'https://alpha.example/',expectedRevision:released.revision});await f.restart();assert.equal((await f.list(item.runId)).candidates[0].available,false);assert.equal(f.reads,2);
});

for(const material of ['same','different'])test('a visual rejection '+(material==='same'?'blocks the same':'allows different')+' exact prepared material in a later run',async t=>{
 const f=await fixture(t),rejected=await f.add('Rejected visual material');f.patch(rejected.runId,{state:'paused'});const current=await f.add(material==='same'?'Rejected visual material':'Different visual material'),saved=await f.snapshot(current.runId),rejectedHash=f.raw(rejected.runId).approvedHtmlHash;
 assert.equal(typeof rejectedHash,'string');assert.equal(f.raw(current.runId).approvedHtmlHash===rejectedHash,material==='same');f.policy().observe({runId:rejected.runId,origin:donor().baseUrl,code:'NATIVE_VISUAL_REJECTED',materialHash:rejectedHash,proof:{ownedTrashConfirmed:true}});await f.configure();await f.s.autopilot.selectPending();assert.equal(f.raw(current.runId).candidate?.id??null,material==='same'?null:'alpha');await f.assertMaterial(saved);
});

test('unknown security policy remains blocked under all=1 catalogue choices and automatic selection',async t=>{
 const f=await fixture(t),item=await f.add();f.policy().observe({runId:'prior-security-run',origin:donor().baseUrl,code:'unsafe_address',proof:{prePage:true}});await f.configure();f.advance(7*86400000);const catalog=await f.list(item.runId,'?all=1');assert.equal(catalog.candidates.find(candidate=>candidate.id==='alpha').available,false);assert.equal((await f.choose(item.runId,catalog)).status,409);await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate??null,null);assert.equal(f.raw(item.runId).publicationApproval??null,null);
});

for(const ownership of ['published','uncertain','reserved'])test('releasing policy leaves '+ownership+' ownership unavailable at both catalogue and automatic admission',async t=>{
 const f=await fixture(t),item=await f.add(),ownerProject=f.s.store.createProject({name:'Existing '+ownership});let owned;
 if(ownership==='published'){const site=f.s.store.createSite(ownerProject.id,{name:'Published donor',baseUrl:donor().baseUrl});owned=f.s.store.createPage(ownerProject.id,{title:'Already published',siteId:site.id,wpId:71,fullUrl:'https://alpha.example/existing/'});}
 else owned=f.s.store.createRecord(ownerProject.id,'autopilot',{source:'html',state:ownership==='uncertain'?'uncertain':'awaiting_review',stage:'installing',candidate:{id:'alpha',baseUrl:donor().baseUrl},...(ownership==='uncertain'?{nativePublication:{postId:72,phase:'dispatching'}}:{})},randomUUID());
 await f.configure();const record=await f.ban();assert.equal((await f.release(record)).status,200);const catalog=await f.list(item.runId,'?all=1');assert.equal(catalog.candidates.find(candidate=>candidate.id==='alpha').available,false);const result=await f.choose(item.runId,catalog);assert.equal(result.status,409);assert.equal(result.code,'SOURCE_RESERVED');await f.s.autopilot.selectPending();assert.equal(f.raw(item.runId).candidate??null,null);assert.deepEqual(ownership==='published'?f.s.store.getPage(owned.id):f.raw(owned.id),owned);
});

test('public stop-list, errors, run DTOs and support export omit private references and credentials',async t=>{
 const f=await fixture(t),item=await f.add();f.policy().observe({runId:'prior-private-run',origin:donor().baseUrl,code:'bootstrap_auth_failed',sourceIdentity:sourceIdentity(),credentials:donor(),proof:{loginRejectedBeforeWrites:true}});await f.configure();const record=await f.ban();
 const privateRecord=f.s.store.listPolicyRecords('donor_exclusion').find(row=>row.type==='auth'),references=[privateRecord.sourceRef,privateRecord.keyMarker,...Object.values(privateRecord.credentialRefs)];
 for(const route of ['/autopilot/donor-exclusions?state=all','/autopilot/donor-exclusions?state=active','/projects/'+item.project.id+'/autopilot','/autopilot/'+item.runId+'/donors?all=1']){const result=await f.q(route);assert.equal(result.status,200);for(const reference of references)assert.ok(!JSON.stringify(result).includes(reference));}
 const support=await f.q('/support/export',{});assert.equal(support.status,200);for(const reference of references)assert.ok(!JSON.stringify(support).includes(reference));assertPrivate(f.s.store.exportBackup());
 for(const query of ['?offset=-1','?limit=0','?state=unrecognized','?unexpected=1'])assert.equal((await f.q('/autopilot/donor-exclusions'+query)).status,400,query);
 assert.equal((await f.q('/autopilot/donor-exclusions/release',{id:record.id,expectedRevision:-1})).status,400);assert.equal((await f.q('/autopilot/donor-exclusions/ban',{origin:'https://alpha.example/',expectedRevision:record.revision,password:secrets[1]})).status,400);
});
