'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const key=Buffer.alloc(32,33).toString('base64'),origin='https://capability-native.example/',secret='PRIVATE_ACCOUNT_PASSWORD';
async function fixture(t,{rejectPrimary=false,pluginBoth=false,onPlugin}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-cap-native-'));let app,account=null,writes=0,creates=0,remote=null;
 const deny=()=>assert.fail('No Bridge/REST/paid calls');
 const session={baseUrl:origin,status:async()=>{},login:async auth=>{if(rejectPrimary&&auth.username==='primary')throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});account=auth.username;},ensureCleanLinks:async()=>{await onPlugin?.(app,account);if(account==='primary'||pluginBoth)throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});},publishPage:async input=>{if(!input.saved){creates++;await input.checkpoint({postId:42,phase:'draft'});}await input.checkpoint({postId:42,phase:'dispatching'});input.beforeSend();writes++;remote={postId:42,status:'publish',title:input.title,content:input.html,url:origin+'page/'};await input.checkpoint({postId:42,phase:'published',url:remote.url});return remote;},inspectPublished:async()=>remote};
 const browser={nativeEditor:true,open:async()=>session,assertOpen(){},switchAccount:async()=>{account=null;},reset:async()=>{},error:async()=>{},done:async()=>{},result:async()=>{},close:async()=>{}};
 const source={pickUnused:async()=>({id:'fixture-site',baseUrl:origin,username:'primary',password:secret,alternateCredentials:{username:'backup',password:secret}})};
 const settings={dataDir:dir,masterKey:key,visibleBrowser:browser,autopilotOptions:{source,bootstrapFactory:deny},client:{checkSite:deny,checkPage:async()=>['public','content','noindex','robots','links'].map(kind=>({kind,state:'ok'}))},browserVerifier:{verifyPublished:async()=>({state:'ok',viewports:[],visual:{state:'ok',viewports:[{name:'desktop',state:'ok'}]}})}};
 app=await createLifecycleService(settings);const project=app.store.createProject({name:'Capability fixture'});
 const q=async(route,body)=>{const r=await app.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};};
 const input={source:'html',html:'<h1>Exact customer page</h1><p>Exact original details.</p>',chromeMode:'overlay-only'},preview=await q('/autopilot/preview',input),launched=await q('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken,reviewBeforePublish:true});const id=launched.run.id;
 await app.tick();await app.autopilot.saveSource({spreadsheetId:'fixtureSheetId12345',range:'Sites!A1:O100',serviceAccount:{client_email:'fixture@example.com',private_key:'fixture'},columns:{url:'A',username:'K',password:'L'}});
 const prepared=await q('/autopilot/'+id+'/html');assert.equal((await q('/autopilot/'+id+'/approve',{reviewToken:prepared.reviewToken})).status,202);
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get app(){return app;},id,project,q,stats:()=>({writes,creates}),async run(){for(let i=0;i<12;i++)await app.tick();return app.autopilot.list(project.id)[0];},async restart(){await app.close();app=await createLifecycleService(settings);}};
}
test('real native flow retains both account observations through backup publication and restart',async t=>{
 const f=await fixture(t),run=await f.run();assert.equal(run.state,'completed',JSON.stringify(run));
 const history=run.publication?.capabilities?.history;assert.equal(history?.rows.length,2);
 assert.equal(history.rows[0].facts.login.value,true);assert.equal(history.rows[0].facts.pluginAccess.value,false);assert.equal(history.rows[1].facts.plugin.value,'active');assert.equal(history.rows[1].facts.markup.value,true);assert.equal(history.rows[1].accountIndex,1);
 assert.deepEqual(f.stats(),{creates:1,writes:1});assert.doesNotMatch(JSON.stringify(run),/PRIVATE_|accountRef|historyId|ciphertext/);
 await f.restart();const response=await f.q('/autopilot/'+f.id+'/capabilities');assert.equal(response.status,200);assert.equal(response.capabilities.rows.length,2);assert.deepEqual(f.stats(),{creates:1,writes:1});
});

test('verified native publication retains only encrypted ordinary login and complete exact snapshot for later updates',async t=>{
 const f=await fixture(t),run=await f.run();assert.equal(run.state,'completed');const page=f.app.store.getPage(run.pageId),site=f.app.store.getSite(page.siteId);
 assert.equal(site.bootstrap.mode,'browser');assert.equal(site.hasBrowserCredential,true,'ordinary browser access must survive restart without Bridge setup');assert.equal(site.hasCredential,false);assert.equal(f.app.store.getSiteCredentials(site.id),null,'ordinary password must not become an API credential');
 assert.deepEqual(f.app.store.getBrowserCredentials(site.id),{username:'backup',applicationPassword:secret});
 assert.equal(page.remoteSnapshot.postId,page.wpId);assert.equal(page.remoteSnapshot.title,page.title);assert.equal(page.remoteSnapshot.url,page.fullUrl);assert.deepEqual(page.remoteSnapshot.config,page.config);
 assert.equal(f.app.store.getRecord(f.id).candidateCredential,null,'temporary login envelope can still be cleared');
 const publicData=JSON.stringify([run,site,(await f.q('/projects/'+f.project.id+'/sites')).sites]);assert.doesNotMatch(publicData,/PRIVATE_ACCOUNT_PASSWORD|ciphertext|applicationPassword/);
 await f.restart();assert.deepEqual(f.app.store.getBrowserCredentials(site.id),{username:'backup',applicationPassword:secret});assert.equal(f.app.store.getPage(page.id).remoteSnapshot.postId,page.wpId);assert.deepEqual(f.stats(),{creates:1,writes:1});
 const available=await f.q('/pages/'+page.id+'/replacement-status');assert.equal(available.status,200);assert.equal(available.replacement.mode,'native');assert.equal(available.replacement.available,true,'actual autopilot hash and encrypted browser login must be usable by the update controller');
});
test('wrong primary password is historical evidence while optional plugin denial preserves successful backup markup',async t=>{
 const f=await fixture(t,{rejectPrimary:true,pluginBoth:true}),run=await f.run();assert.equal(run.state,'completed',JSON.stringify(run));
 const rows=run.publication?.capabilities?.history?.rows;assert.equal(rows?.length,2);assert.equal(rows[0].facts.login.value,false);assert.equal(rows[1].facts.login.value,true);assert.equal(rows[1].facts.pluginAccess.value,false);assert.equal(rows[1].facts.markup.value,true);assert.deepEqual(f.stats(),{creates:1,writes:1});
 const before=f.app.store.getRecord(f.id).revision;assert.equal((await f.q('/autopilot/'+f.id+'/capabilities')).status,200);assert.equal(f.app.store.getRecord(f.id).revision,before);
});
test('switching to backup credentials does not inherit primary plugin denial as a current fact',async t=>{
 let observed;const f=await fixture(t,{onPlugin:(app,account)=>{if(account!=='backup')return;const run=app.store.listProjects().flatMap(project=>app.store.listRecords(project.id,'autopilot'))[0];observed=structuredClone(run.publicationCapabilities);}});
 const run=await f.run();assert.equal(run.state,'completed');assert.equal(observed?.accountIndex,1);assert.equal(observed?.pluginAccess,undefined);assert.equal(observed?.plugin,undefined);assert.deepEqual(f.stats(),{creates:1,writes:1});
});
