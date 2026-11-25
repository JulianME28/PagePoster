'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createLocalServer}=require('../server/local.cjs');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
const options={timeout:45000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
const passphrase='a private fixture passphrase',projectName='Private backup fixture';
async function runtime(t,{project=false}={}){
 const base=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'pp-backup-ui-'));
 const server=await createLocalServer({env:{},lifecycle:{dataDir:dir,masterKey:Buffer.alloc(32,43).toString('base64')}});
 if(project)server.lifecycle.store.createProject({name:projectName});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;await server.closeResources();const target=path.resolve(dir);assert.ok(target.startsWith(base+path.sep)&&path.basename(target).startsWith('pp-backup-ui-'));fs.rmSync(target,{recursive:true,force:true});});
 const request=async(action,body)=>{const r=await fetch(origin+'/api/recovery/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
 return {server,origin,request};
}
async function workspace(t,config={}){
 const target=await runtime(t,config),{chromium}=require(playwrightPath);
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const errors=[],calls=[];await context.route('**/*',route=>new URL(route.request().url()).origin===target.origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/recovery/'))calls.push({action:r.url().split('/').at(-1),body:r.postDataJSON()});});
 t.after(async()=>{await context.close();await browser.close();assert.deepEqual(errors,[]);});
 await page.goto(target.origin+'/');await page.locator('#ap-settings-open').click();await page.locator('#ap-backup-open').click();await page.locator('#ap-backup[open]').waitFor();
 return {...target,page,calls};
}
async function chooseBackup(page,backup,password=passphrase){
 await page.locator('#ap-backup-restore-details').evaluate(n=>n.open=true);
 await page.locator('#ap-backup-file').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#ap-backup-import-password').fill(password);
}

test('studio exports a real encrypted backup, rejects a wrong password and protects a populated database',options,async t=>{
 const {page,calls}=await workspace(t,{project:true});
 await page.locator('#ap-backup-export-password').fill(passphrase);
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#ap-backup-export').click()]);
 const bytes=fs.readFileSync(await download.path(),'utf8'),backup=JSON.parse(bytes);assert.equal(backup.kind,'pageposter-full-encrypted-backup');assert.doesNotMatch(bytes,new RegExp(projectName));assert.doesNotMatch(bytes,new RegExp(passphrase));
 assert.equal(await page.locator('#ap-backup-export-password').inputValue(),'');
 await chooseBackup(page,backup,'incorrect fixture password');await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-notice.error').waitFor();assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);
 await page.locator('#ap-backup-import-password').fill(passphrase);await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-review').getByText(/Проєктів: 1/).waitFor();assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);assert.match(await page.locator('#ap-backup-review').textContent(),/порожн/i);assert.equal(calls.filter(c=>c.action==='restore').length,0);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.locator('#ap-backup').evaluate(n=>n.scrollWidth<=n.clientWidth+1));}
 await page.locator('#ap-backup-close').click();await page.locator('#ap-backup-open').click();assert.equal(await page.locator('#ap-backup-import-password').inputValue(),'');assert.equal(await page.locator('#ap-backup-file').inputValue(),'');assert.equal(await page.locator('#ap-backup-review').isVisible(),false);assert.ok(!(await page.evaluate(()=>JSON.stringify(sessionStorage))).includes(passphrase));
});

test('studio inspects and explicitly restores the same backup into an empty runtime',options,async t=>{
 const donor=await runtime(t,{project:true}),backup=await donor.request('export',{passphrase});const {page,calls}=await workspace(t);
 await chooseBackup(page,backup);await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-review').getByText(/Проєктів: 1/).waitFor();assert.equal(calls.filter(c=>c.action==='restore').length,0);
 await page.locator('#ap-backup-ack').check();await page.locator('#ap-backup-confirm').click();await page.locator('#ap-backup-notice').getByText(/перезапустіть сервер/i).waitFor();
 const restore=calls.find(c=>c.action==='restore');assert.equal(restore.body.confirmed,true);assert.deepEqual(restore.body.backup,backup);assert.equal(restore.body.passphrase,passphrase);assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);assert.equal(await page.locator('#ap-backup-import-password').inputValue(),'');
 await page.locator('#ap-backup-close').click();assert.equal(await page.locator('#ap-launch').isDisabled(),true);
});

test('changing the file or password invalidates inspection and a late inspection cannot enable restore',options,async t=>{
 const donor=await runtime(t,{project:true}),backup=await donor.request('export',{passphrase});const {page,calls}=await workspace(t);
 let release,started;const inspectionStarted=new Promise(r=>started=r),holdInspection=new Promise(r=>release=r);await page.route('**/api/recovery/inspect',async route=>{started();await holdInspection;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({summary:{projects:1,pages:0,sites:0,runs:0,jobs:0,files:3},canRestore:true})});});
 await chooseBackup(page,backup);await page.locator('#ap-backup-inspect').click();await inspectionStarted;await page.locator('#ap-backup-import-password').fill('a different valid password');release();
 await page.waitForFunction(()=>!document.getElementById('ap-backup-inspect').disabled);assert.equal(await page.locator('#ap-backup-review').isVisible(),false);assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);
 await page.unroute('**/api/recovery/inspect');await page.locator('#ap-backup-import-password').fill(passphrase);await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-review').waitFor();await page.locator('#ap-backup-ack').check();assert.equal(await page.locator('#ap-backup-confirm').isEnabled(),true);
 await page.locator('#ap-backup-file').setInputFiles({name:'another.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...backup,tag:'changed'}))});assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);assert.equal(calls.filter(c=>c.action==='restore').length,0);
});

test('an uncertain restore response never reports success or permits a blind repeat',options,async t=>{
 const donor=await runtime(t,{project:true}),backup=await donor.request('export',{passphrase});const {page,calls}=await workspace(t);
 await page.route('**/api/recovery/restore',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Результат восстановления не подтверждён"}'}));
 await chooseBackup(page,backup);await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-review').waitFor();await page.locator('#ap-backup-ack').check();await page.locator('#ap-backup-confirm').click();await page.locator('#ap-backup-notice.error').waitFor();assert.equal(await page.locator('#ap-backup-confirm').isDisabled(),true);assert.equal(calls.filter(c=>c.action==='restore').length,1);assert.doesNotMatch(await page.locator('#ap-backup-notice').textContent(),/успішно|відновлено/i);
});

test('export keeps its password fixed while running and late restore completion freezes a reopened dialog',options,async t=>{
 const donor=await runtime(t,{project:true}),backup=await donor.request('export',{passphrase});const {page}=await workspace(t);
 let releaseExport,startedExport;const exportStarted=new Promise(r=>startedExport=r);
 await page.route('**/api/recovery/export',async route=>{startedExport();await new Promise(r=>releaseExport=r);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(backup)});});
 await page.locator('#ap-backup-export-password').fill(passphrase);await page.locator('#ap-backup-export').click();await exportStarted;
 assert.equal(await page.locator('#ap-backup-export-password').isDisabled(),true);
 const downloaded=page.waitForEvent('download');releaseExport();await downloaded;await page.waitForFunction(()=>!document.getElementById('ap-backup-inspect').disabled);
 let releaseRestore,startedRestore;const restoreStarted=new Promise(r=>startedRestore=r);
 await page.route('**/api/recovery/restore',async route=>{startedRestore();await new Promise(r=>releaseRestore=r);await route.fulfill({status:200,contentType:'application/json',body:'{"restored":true}'});});
 await chooseBackup(page,backup);await page.locator('#ap-backup-inspect').click();await page.locator('#ap-backup-review').waitFor();await page.locator('#ap-backup-ack').check();await page.locator('#ap-backup-confirm').click();await restoreStarted;
 assert.equal(await page.locator('#ap-backup-file').isDisabled(),true);assert.equal(await page.locator('#ap-backup-import-password').isDisabled(),true);
 await page.locator('#ap-backup-close').click();await page.locator('#ap-backup-open').click();releaseRestore();
 await page.locator('#ap-backup-notice').getByText(/перезапустіть сервер/i).waitFor();assert.equal(await page.locator('#ap-backup-inspect').isDisabled(),true);assert.equal(await page.locator('#ap-backup-export').isDisabled(),true);assert.equal(await page.locator('#ap-backup-import-password').inputValue(),'');
});
