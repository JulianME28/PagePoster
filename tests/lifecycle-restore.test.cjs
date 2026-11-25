'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
async function fixture(t){
 const {createStore}=await import('../server/lifecycle/store.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-restore-')),stores=[];
 const open=name=>{const filename=path.join(dir,name+'.sqlite'),s=createStore({filename,masterKey:Buffer.alloc(32,22).toString('base64')});stores.push(s);return{s,filename};};
 t.after(()=>{stores.forEach(s=>s.close());fs.rmSync(dir,{recursive:true,force:true});});
 const {s:source}=open('source'),p=source.createProject({name:'Project',description:'Keep me',language:'uk',country:'UA',tags:['one']});
 const site=source.createSite(p.id,{name:'Site',baseUrl:'https://example.com/blog/',username:'editor',applicationPassword:'private-secret-restore-38911'});
 const exact='https://offer.example/?editor_id=10&b=%2f&b=2#A';
 const initial=source.createPage(p.id,{siteId:site.id,title:'First',config:{cards:[{name:'Manual',url:exact}]},fullUrl:'https://example.com/blog/page/?q=%2f#x',expectedUrls:[exact],wpId:73});
 const page=source.updatePage(initial.id,{title:'Second'},initial.revision);
 source.addCheck(page.id,{kind:'links',state:'unknown',evidence:{details:'Not exported'}});
 source.recordEvent({projectId:p.id,type:'saved',entityId:page.id,message:'Not exported'});
 source.enqueueJob({projectId:p.id,pageId:page.id,type:'replace',idempotencyKey:'never-resume',payload:{private:'Never exported'}});
 source.createProposal(page.id,{expectedPageRevision:page.revision,diff:[],nextConfig:{title:'Never restored'},expectedContentHash:'hash'});
 return {source,p,site,page,exact,backup:source.exportBackup(),open};
}
test('restore preserves exact authored records and history but disables sites and drops all credentials/jobs/proposals',async t=>{
 const {backup,p,site,page,exact,open}=await fixture(t),{s:target,filename}=open('target');
 const result=target.restoreBackup(backup);
 assert.deepEqual(result,{projects:1,sites:1,pages:1,pageVersions:2,checks:1,events:1,skippedJobs:1});
 assert.deepEqual(target.getProject(p.id),p);
 const restored=target.getPage(page.id);assert.deepEqual(restored,page);assert.equal(restored.config.cards[0].url,exact);
 assert.equal(target.getSite(site.id).enabled,false);assert.equal(target.getSite(site.id).hasCredential,false);assert.equal(target.getSiteCredentials(site.id),null);
 assert.equal(target.listChecks(page.id)[0].state,'unknown');assert.equal(target.listEvents(p.id)[0].type,'saved');
 assert.deepEqual(target.listJobs(p.id),[]);assert.equal(target.claimJob({workerId:'worker',leaseMs:1000}),null);
 const raw=new DatabaseSync(filename);assert.equal(raw.prepare('SELECT count(*) AS n FROM proposals').get().n,0);assert.equal(raw.prepare('SELECT count(*) AS n FROM site_credentials').get().n,0);raw.close();
 assert.equal(target.exportBackup().pages[0].config.cards[0].url,exact);
 assert.throws(()=>target.restoreBackup(backup),{code:'RESTORE_NOT_EMPTY'});assert.equal(target.getPage(page.id).versions.length,2);
});
test('malformed references anywhere in backup reject the entire restore',async t=>{
 const {backup,open}=await fixture(t);
 const mutations=[
  x=>x.sites[0].projectId='missing-project',
  x=>x.pages[0].siteId='missing-site',
  x=>x.pageVersions[0].snapshot.id='different-page',
  x=>x.pageVersions[0].pageId='missing-page',
  x=>x.pageVersions[1].revision=1,
  x=>x.pages[0].revision=9,
  x=>x.checks[0].pageId='missing-page',
  x=>x.events[0].projectId='missing-project',
  x=>x.jobs[0].siteId='missing-site',
  x=>x.projects.push({...x.projects[0]}),
  x=>x.pages[0].fullUrl='javascript:alert(1)',
  x=>x.sites[0].applicationPassword='must-not-import',
  x=>x.pages[0].unknownField='must-not-import',
  x=>x.proposals=[{}],
  x=>x.schemaVersion=99
 ];
 for(let i=0;i<mutations.length;i++){
  const damaged=structuredClone(backup);mutations[i](damaged);const{s:target}=open('bad-'+i);
  assert.throws(()=>target.restoreBackup(damaged),{code:'VALIDATION'},'mutation '+i);
  assert.deepEqual(target.listProjects(),[],'no partial imports for mutation '+i);
 }
});
test('SQL failure while restoring history rolls back all inserted rows',async t=>{
 const {backup,open}=await fixture(t),{s:target,filename}=open('fault');
 const raw=new DatabaseSync(filename);raw.exec("CREATE TRIGGER reject_history BEFORE INSERT ON checks BEGIN SELECT RAISE(ABORT,'fixture restore failure'); END");
 assert.throws(()=>target.restoreBackup(backup),/fixture restore failure/);assert.deepEqual(target.listProjects(),[]);
 for(const table of ['sites','pages','page_versions','events','jobs'])assert.equal(raw.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
 raw.exec('DROP TRIGGER reject_history');raw.close();
 assert.equal(target.restoreBackup(backup).pages,1);
});
test('backup object cannot smuggle live jobs, credentials or unknown data through restore',async t=>{
 const {backup,open}=await fixture(t),{s:target}=open('strict');
 const bad=structuredClone(backup);bad.jobs[0].payload={operation:{kind:'create'}};
 assert.throws(()=>target.restoreBackup(bad),{code:'VALIDATION'});
 const secret=structuredClone(backup);secret.pages[0].config.applicationPassword='unexpected-secret';
 secret.pageVersions.at(-1).snapshot.config.applicationPassword='unexpected-secret';
 assert.throws(()=>target.restoreBackup(secret),{code:'BACKUP_SECRET'});
 assert.deepEqual(target.listProjects(),[]);
});

test('restore accepts valid historical job relationships after a completed job and later site reassignment',async t=>{
 const {source,p,page,open}=await fixture(t);
 const claimed=source.claimJob({workerId:'w',leaseMs:1000});source.finishJob(claimed.id,claimed.leaseToken,{state:'failed'});
 const alternate=source.createSite(p.id,{name:'Alternate',baseUrl:'https://alternate.example'});
 source.updatePage(page.id,{siteId:alternate.id},page.revision);
 const{s:target}=open('history');target.restoreBackup(source.exportBackup());
 assert.equal(target.getPage(page.id).siteId,alternate.id);assert.equal(target.getPage(page.id).versions[0].snapshot.siteId,page.siteId);
 assert.deepEqual(target.listJobs(p.id),[]);
});
