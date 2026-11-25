const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const G=require('../dist/generator.js');
async function fixture(t,bridgeOverride){const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-workflow-'));let sent=[];const bridge=bridgeOverride||{submitOperation:async({operation})=>{sent.push(operation);return{operationId:operation.operationId,state:'completed',postId:71,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=71',warnings:[]};}};const a=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,21).toString('base64'),bridgeClient:bridge,browserVerifier:{verifyGenerated:async()=>({layoutState:'ok',viewports:[]}),verifyPublished:async()=>({state:'unknown',evidence:'Fixture offline only'})},client:{checkPage:async()=>['wp_access','wp_status','wp_content','public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Fixture'})),checkSite:async()=>({state:'ok'})}});t.after(async()=>{await a.close();fs.rmSync(dir,{recursive:true,force:true});});const q=async(route,b,method=b?'POST':'GET')=>{const r=await a.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method,headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(b?{body:JSON.stringify(b)}:{})}));return{status:r.status,...await r.json()};};const p=(await q('/projects',{name:'Project'})).project,site=(await q('/projects/'+p.id+'/sites',{name:'Site',baseUrl:'https://example.com',username:'user',applicationPassword:'password-unique'})).site;const config={...G.DEFAULT_DATA,cards:[{name:'Offer',url:'https://destination.example/?x=2&b=1',button:'VIEW'}],moreCards:[],tiles:[],services:[],reviews:[],navLinks:[],sections:[],faq:[]};const page=(await q('/projects/'+p.id+'/pages',{title:'Page',config})).page;return{a,q,p,site,page,sent};}
test('chosen publish mode executes once and records exact WordPress URL',async t=>{const {a,q,page,site,sent}=await fixture(t);const launch={siteId:site.id,mode:'publish',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()};const result=await q('/pages/'+page.id+'/publish',launch);assert.equal(result.status,202);await a.tick({schedule:false});assert.equal(sent.length,1);assert.equal(sent[0].status,'publish');const stored=a.store.getPage(page.id);assert.equal(stored.fullUrl,'https://example.com/?page_id=71');assert.equal(stored.wpId,71);await a.tick({schedule:false});assert.equal(sent.length,1);assert.equal((await q('/pages/'+page.id+'/publish',launch)).job.id,result.job.id);});
test('replacement preserves other roles and has no write until explicit confirmation',async t=>{const {a,q,page,site,sent}=await fixture(t);await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});await a.tick({schedule:false});const info=await q('/pages/'+page.id+'/placements'),cta=info.placements.find(x=>x.role==='offer-cta');const proposed=await q('/pages/'+page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:cta.id,url:'https://new.example/?b=3&a=2',expectedUrl:cta.url,expectedAnchor:cta.anchor}]});assert.equal(proposed.status,201);await a.tick({schedule:false});assert.equal(sent.length,1);await q('/proposals/'+proposed.proposal.id+'/confirm',{expectedRevision:proposed.proposal.revision,confirmed:true});await a.tick({schedule:false});assert.equal(sent.length,2);assert.equal(sent[1].kind,'update');const updated=a.store.getPage(page.id);assert.equal(updated.config.cards[0].url,'https://new.example/?b=3&a=2');assert.equal(updated.config.cards[0].logoUrl,cta.url);assert.equal(updated.config.brandUrl,cta.url);});
test('timeout after sending a write stays uncertain and does not requeue automatically',async t=>{let calls=0;const {a,q,p,page,site}=await fixture(t,{submitOperation:async()=>{calls++;throw Object.assign(Error('unknown'),{code:'pp_bridge_uncertain',uncertain:true});}});await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});await a.tick({schedule:false});await a.tick({schedule:false});assert.equal(calls,1);assert.equal(a.store.listJobs(p.id)[0].state,'uncertain');});

test('a remote commit followed by a local acceptance failure stays uncertain, with no second create',async t=>{
 const {a,q,p,page,site,sent}=await fixture(t);
 await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});
 // Simulate a pause occurring while a valid remote result is being returned.
 const original=a.store.completeRemoteWrite;
 // Store is frozen; a deferred bridge is used below for the adversarial test instead.
 assert.equal(typeof original,'function');
 const job=a.store.listJobs(p.id)[0];const claimed=a.store.claimJob({workerId:'fixture',leaseMs:180000});
 const {createWorkflow}=await import('../server/lifecycle/workflow.mjs');
 const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');let writes=0;
 const workflow=createWorkflow({store:a.store,verifier:{verifyGenerated:async()=>({layoutState:'ok',viewports:[]})},bridge:{submitOperation:async({operation})=>{writes++;a.store.pauseJob(job.id);return {state:'completed',postId:71,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=71'};}}});
 await assert.rejects(workflow.perform(claimed,site,a.store.getSiteCredentials(site.id)),e=>e.uncertain===true);
 await a.tick({schedule:false});assert.equal(writes,1);assert.equal(sent.length,0);assert.equal(a.store.getJob(job.id).state,'uncertain');assert.equal(a.store.getPage(page.id).wpId,null);
});
test('an in-flight page cannot move to another WordPress site',async t=>{
 const {a,q,p,page,site}=await fixture(t);const other=(await q('/projects/'+p.id+'/sites',{name:'Other',baseUrl:'https://other.example',username:'u',applicationPassword:'another-pass'})).site;
 await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});
 const current=a.store.getPage(page.id);const changed=await q('/pages/'+page.id,{siteId:other.id,expectedRevision:current.revision},'PATCH');assert.equal(changed.status,409);assert.equal(a.store.getPage(page.id).siteId,site.id);
});
test('a link-only proposal cannot include unrelated local text changes',async t=>{
 const {a,q,page,site}=await fixture(t);await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});await a.tick({schedule:false});
 const current=a.store.getPage(page.id);await q('/pages/'+page.id,{config:{...current.config,intro:'Unpublished manual text'},expectedRevision:current.revision},'PATCH');
 const info=await q('/pages/'+page.id+'/placements'),cta=info.placements.find(x=>x.role==='offer-cta');const result=await q('/pages/'+page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:cta.id,url:'https://new.example/',expectedUrl:cta.url,expectedAnchor:cta.anchor}]});assert.equal(result.status,409);
});

test('rollback restores an exact committed snapshot only after review and confirmation',async t=>{
 const {a,q,page,site,sent}=await fixture(t);
 await q('/pages/'+page.id+'/publish',{siteId:site.id,mode:'draft',expectedRevision:page.revision,idempotencyKey:crypto.randomUUID()});await a.tick({schedule:false});
 const initial=a.store.getPage(page.id).remoteSnapshot;
 const info=await q('/pages/'+page.id+'/placements'),cta=info.placements.find(x=>x.role==='offer-cta');const proposal=(await q('/pages/'+page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:cta.id,url:'https://new.example/?x=%2F',expectedUrl:cta.url,expectedAnchor:cta.anchor}]})).proposal;
 await q('/proposals/'+proposal.id+'/confirm',{expectedRevision:proposal.revision,confirmed:true});await a.tick({schedule:false});
 const versions=await q('/pages/'+page.id+'/rollback-versions');assert.equal(versions.versions.length,1);
 const rollback=(await q('/pages/'+page.id+'/rollback-proposals',{expectedRevision:versions.pageRevision,versionId:versions.versions[0].id})).proposal;assert.equal(rollback.kind,'rollback');assert.equal(sent.length,2);
 const beforeHash=a.store.getPage(page.id).remoteSnapshot.contentHash;
 await q('/proposals/'+rollback.id+'/confirm',{expectedRevision:rollback.revision,confirmed:true});await a.tick({schedule:false});
 assert.equal(sent.length,3);assert.equal(sent[2].content,initial.content);assert.equal(sent[2].expectedContentHash,beforeHash);assert.equal(a.store.getPage(page.id).remoteSnapshot.contentHash,initial.contentHash);
});

async function exactPage(f,html){
 const [{inspectExactImport},{bridgeContentHash}]=await Promise.all([import('../server/lifecycle/exact-import.mjs'),import('../server/lifecycle/bridge-client.mjs')]);
 const config={...inspectExactImport(html).config,title:'Existing'},snapshot={postId:71,postType:'page',title:'Existing',content:html,status:'draft',config};snapshot.contentHash=bridgeContentHash(snapshot);
 return f.a.store.updatePage(f.page.id,{siteId:f.site.id,config,wpId:71,wpType:'page',fullUrl:'https://example.com/?page_id=71',remoteSnapshot:snapshot,lifecycleState:'draft'},f.page.revision);
}
test('exact-import UI replacement validates stale guards and reviews navigation normalization before confirmed write',async t=>{
 const f=await fixture(t),runtime=require('../dist/page-runtime.js'),html=runtime.prepare('<style>.cta{color:red}</style><div id="pp-landing"><a class="cta" href="https://one.example/">One</a><a class="cta" href="https://one.example/">Again</a></div>');
 await exactPage(f,html);const info=await f.q('/pages/'+f.page.id+'/placements'),place=info.placements[1],change={id:place.id,url:'https://two.example/?b=%2F&a=1',expectedUrl:place.url,expectedAnchor:place.anchor,...(place.binding===undefined?{}:{expectedBinding:place.binding})};
 for(const guard of [{expectedUrl:'https://stale.example/'},{expectedAnchor:'Stale'},{expectedBinding:'stale-binding'}]){
  const denied=await f.q('/pages/'+f.page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{...change,...guard}]});assert.equal(denied.code,'CONFLICT');
 }
 const proposed=await f.q('/pages/'+f.page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[change]});assert.equal(proposed.status,201);assert.equal(proposed.proposal.diff.length,2);
 const technical=proposed.proposal.diff.find(d=>d.before.anchor==='Повторна кнопка з переходом');assert.ok(technical);assert.equal(technical.after.anchor,'Основне посилання');assert.equal(technical.before.url,change.url);assert.equal(technical.after.url,change.url);assert.equal(f.sent.length,0);
 const confirmed=await f.q('/proposals/'+proposed.proposal.id+'/confirm',{expectedRevision:proposed.proposal.revision,confirmed:true});assert.equal(confirmed.status,202);await f.a.tick({schedule:false});assert.equal(f.sent.length,1);assert.equal(f.sent[0].content,proposed.proposal.nextConfig.exactImport.html);assert.match(f.sent[0].content,/href="https:\/\/two.example\/\?b=%2F&amp;a=1"/);assert.match(f.sent[0].content,/<style>\.cta\{color:red\}<\/style>/);
});
test('exact-import workflow retains actionable IMPORT errors from unsafe legacy link collisions',async t=>{
 const f=await fixture(t);await exactPage(f,'<div id="pp-universal-pl"><a href="https://one.example/">One</a><span data-pp-url="https://one.example/">Again</span></div>');const info=await f.q('/pages/'+f.page.id+'/placements'),place=info.placements[1];
 const result=await f.q('/pages/'+f.page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:place.id,url:'https://two.example/',expectedUrl:place.url,expectedAnchor:place.anchor}]});assert.equal(result.code,'IMPORT_LINK_COLLISION');assert.equal(f.sent.length,0);
});

test('create and update remote snapshots retain exact WordPress modified GMT metadata',async t=>{
 const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs'),dates=['2025-06-07 08:09:10','2026-10-15 12:34:56'];let writes=0;
 const f=await fixture(t,{submitOperation:async({operation})=>({operationId:operation.operationId,state:'completed',postId:71,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=71',modifiedGmt:dates[writes++],warnings:[]})});
 await f.q('/pages/'+f.page.id+'/publish',{siteId:f.site.id,mode:'draft',expectedRevision:f.page.revision,idempotencyKey:crypto.randomUUID()});await f.a.tick({schedule:false});assert.equal(f.a.store.getPage(f.page.id).remoteSnapshot.modifiedGmt,dates[0]);
 const info=await f.q('/pages/'+f.page.id+'/placements'),place=info.placements.find(p=>p.role==='offer-cta'),proposed=await f.q('/pages/'+f.page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:place.id,url:'https://new.example/',expectedUrl:place.url,expectedAnchor:place.anchor}]});await f.q('/proposals/'+proposed.proposal.id+'/confirm',{expectedRevision:proposed.proposal.revision,confirmed:true});await f.a.tick({schedule:false});const page=f.a.store.getPage(f.page.id);assert.equal(page.remoteSnapshot.modifiedGmt,dates[1]);assert.equal(page.fullUrl,'https://example.com/?page_id=71');assert.equal(writes,2);
});
