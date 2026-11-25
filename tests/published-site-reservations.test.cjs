const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const key=Buffer.alloc(32,53).toString('base64');
async function fixture(t){
 const {createStore}=await import('../server/lifecycle/store.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-published-reservations-'));
 const store=createStore({filename:path.join(dir,'workspace.sqlite'),masterKey:key});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,dir};
}
const project=(store,name)=>store.createProject({name});
const site=(store,p,name)=>store.createSite(p.id,{name,baseUrl:'https://'+name+'.example/'});
const page=(store,p,s,extra={})=>store.createPage(p.id,{title:'Customer page',siteId:s.id,...extra});
test('published-site projection equals full page semantics and stays fresh across updates and connections',async t=>{
 const {store,dir}=await fixture(t),p=project(store,'Open'),closed=project(store,'Closed'),trashed=project(store,'Trash');
 store.updateProject(closed.id,{archived:true},1);store.updateProject(trashed.id,{archived:true,trashed:true},1);
 const a=site(store,p,'a'),b=site(store,p,'b'),c=site(store,closed,'c'),d=site(store,trashed,'d'),unused=site(store,p,'unused');
 const published=page(store,p,a,{wpId:1,lifecycleState:'published'});page(store,p,a,{wpId:2});page(store,p,b);page(store,p,unused,{wpId:3,lifecycleState:'discarded'});
 page(store,closed,c,{wpId:4,lifecycleState:'review_required'});page(store,trashed,d,{wpId:5,lifecycleState:'draft'});
 const expected=()=>new Set(store.listProjects().flatMap(project=>store.listPages(project.id)).filter(page=>page.wpId).map(page=>page.siteId));
 assert.equal(typeof store.listPublishedSiteIds,'function','donor guards need a minimal authoritative projection');
 assert.deepEqual(new Set(store.listPublishedSiteIds()),expected());
 const returned=store.listPublishedSiteIds();returned.length=0;assert.deepEqual(new Set(store.listPublishedSiteIds()),expected());
 store.updatePage(published.id,{siteId:b.id},published.revision);assert.deepEqual(new Set(store.listPublishedSiteIds()),expected());
 const {createStore}=await import('../server/lifecycle/store.mjs'),other=createStore({filename:path.join(dir,'workspace.sqlite'),masterKey:key});
 try{
  const live=other.createPage(p.id,{siteId:unused.id,title:'Committed elsewhere',wpId:8});assert.equal(store.listPublishedSiteIds().includes(unused.id),true,'fresh connection writes reserve immediately');
  other.updatePage(live.id,{lifecycleState:'discarded'},live.revision);assert.equal(store.listPublishedSiteIds().includes(unused.id),false,'confirmed discard releases only its reservation');
  assert.deepEqual(new Set(store.listPublishedSiteIds()),expected());
 }finally{other.close();}
});
test('source check uses fresh published IDs without expanding customer pages or version history',async t=>{
 const {store,dir}=await fixture(t),p=project(store,'Selection'),s=site(store,p,'published'),unused=site(store,p,'unused');
 const saved=page(store,p,s,{wpId:9,config:{importHtml:'customer-private-body'}}),reads=[];
 const {createAutopilot}=await import('../server/lifecycle/autopilot.mjs');let expanded=0;
 const adapter={...store,listPages(...args){expanded++;return store.listPages(...args);}};
 const a=await createAutopilot({store:adapter,dataDir:dir,masterKey:key,source:{readCandidates:async(config,options)=>{reads.push(options);return {candidates:[],issues:[]};}}});
 await a.saveSource({spreadsheetId:'fixture',range:'Sites!A1:F10',serviceAccount:{client_email:'fixture@example.com',private_key:'fixture'},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}});
 const check=()=>a.handle(new Request('http://localhost/autopilot/source/check',{method:'POST'}),'/autopilot/source/check',async()=>({}));
 assert.equal((await check()).status,200);assert.deepEqual(reads[0].usedOrigins,['https://published.example']);assert.equal(expanded,0,'selection must not reconstruct full page DTOs and their versions');
 store.updatePage(saved.id,{siteId:unused.id},saved.revision);
 assert.equal((await check()).status,200);assert.deepEqual(reads[1].usedOrigins,['https://unused.example']);assert.equal(expanded,0);
 assert.equal(store.getPage(saved.id).config.importHtml,'customer-private-body');
});
