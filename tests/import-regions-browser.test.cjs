'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath,chrome=require('./browser-runtime.cjs').chromePath;
test('bulk import criteria reach every page while preserving languages, regions, HTML and untouched metrics',{timeout:60000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chrome))},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-bulk-ui-')),{createLocalServer}=require('../server/local.cjs'),server=await createLocalServer({env:{},lifecycle:{dataDir:dir,masterKey:Buffer.alloc(32,53).toString('base64')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await require(playwrightPath).chromium.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-networking']}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],commits=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/project-queue/import'))commits.push(request.postDataJSON());});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));await server.closeResources();fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await page.goto(origin);await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');
 const files=[];for(const [prefix,language,count] of [['hu-page','hu',5],['nz-page','en-nz',5],['pl-page','pl',10],['sk-page','sk',5]])for(let i=0;i<count;i++)files.push({name:prefix+'-'+i+'.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><html lang="'+language+'"><body><h1>'+prefix+' '+i+'</h1></body></html>')});
 await page.locator('#pq-html-files').setInputFiles(files);await page.locator('#pq-name').fill('Bulk criteria');await page.locator('#pq-default-traffic').fill('300');await page.locator('#pq-preview-import').click();await page.locator('#pq-import-rows tr').nth(24).waitFor();
 await page.locator('#pq-import-rows tr').first().getByRole('button',{name:'Змінити',exact:true}).click();await page.locator('#pq-row-traffic').fill('50');await page.locator('#pq-row-apply').click();await page.locator('#pq-row-settings').waitFor({state:'hidden'});
 const before=await page.locator('#pq-import-rows tr').evaluateAll(rows=>rows.map(row=>Array.from(row.cells).slice(0,4).map(cell=>cell.textContent)));
 await page.locator('#pq-bulk-dr').fill('25.5');await page.locator('#pq-bulk-apply').click();await page.getByText('Спільні вимоги застосовано до всіх сторінок: 25.',{exact:true}).waitFor();
 const metrics=()=>page.locator('#pq-import-rows tr').evaluateAll(rows=>rows.map(row=>row.cells[4].textContent));
 assert.deepEqual(await metrics(),['25.5 / 50',...Array(24).fill('25.5 / 300')]);
 await page.locator('#pq-bulk-dr').fill('101');await page.locator('#pq-bulk-apply').click();assert.equal(await page.locator('#pq-bulk-dr').evaluate(input=>input.validity.rangeOverflow),true);assert.deepEqual(await metrics(),['25.5 / 50',...Array(24).fill('25.5 / 300')]);
 await page.locator('#pq-bulk-dr').fill('0');await page.locator('#pq-bulk-traffic').fill('800');
 let entered,release;const began=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/lifecycle/project-import/preview',async route=>{entered();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary criteria failure'})});});
 try{await page.locator('#pq-bulk-apply').click();await began;for(const id of ['pq-bulk-dr','pq-bulk-traffic','pq-bulk-apply','pq-commit-import'])assert.equal(await page.locator('#'+id).isDisabled(),true);}finally{release();}
 await page.locator('#pq-bulk-note.error').waitFor();assert.deepEqual(await metrics(),['25.5 / 50',...Array(24).fill('25.5 / 300')]);await page.unroute('**/api/lifecycle/project-import/preview');
 await page.locator('#pq-bulk-apply').click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('#pq-import-rows tr')).every(row=>row.cells[4].textContent==='0 / 800'));
 assert.deepEqual(await page.locator('#pq-import-rows tr').evaluateAll(rows=>rows.map(row=>Array.from(row.cells).slice(0,4).map(cell=>cell.textContent))),before);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.setViewportSize({width:1440,height:1000});
 await page.locator('#pq-bulk-settings').scrollIntoViewIfNeeded();await page.screenshot({path:path.resolve(__dirname,'../.desktop-build/bulk-criteria-preview.png')});
 await page.locator('#pq-commit-import').click();await page.locator('#pq-dashboard').waitFor({state:'visible'});assert.equal(commits.length,1);
 assert.equal(commits[0].items.length,25);for(const [index,item] of commits[0].items.entries()){assert.equal(item.html,files[index].buffer.toString('utf8'));assert.deepEqual(item.siteSelection,{minDr:0,minTraffic:800,geo:index<5?'HU':index<10?'NZ':index<20?'PL':'SK'});}
 const project=server.lifecycle.store.listProjects().find(p=>p.name==='Bulk criteria'),stored=server.lifecycle.store.listRecords(project.id,'project_queue_item');assert.equal(stored.length,25);assert.ok(stored.every(item=>item.input.siteSelection.minDr===0&&item.input.siteSelection.minTraffic===800));
});
test('one HTML project imports mixed regions with group and per-file overrides without rewriting content',{timeout:60000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chrome))},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-region-ui-')),{createLocalServer}=require('../server/local.cjs'),server=await createLocalServer({env:{},lifecycle:{dataDir:dir,masterKey:Buffer.alloc(32,51).toString('base64')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await require(playwrightPath).chromium.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-networking']}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],commits=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/project-queue/import'))commits.push(request.postDataJSON());});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 t.after(async()=>{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));await server.closeResources();fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await page.goto(origin);await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');await page.locator('#pq-source').selectOption('files');
 await page.locator('#pq-detect-regions').waitFor({timeout:5000});assert.equal(await page.locator('#pq-detect-regions').isChecked(),true);
 const files=[];for(const [prefix,language] of [['hu-uj-kaszinok','hu'],['nz-new-casinos','en'],['pl-bez-weryfikacji','pl']])for(let i=0;i<5;i++)files.push({name:prefix+'-'+i+'.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><html lang="'+language+'"><body><h1>Exact '+prefix+' '+i+'</h1><p>Original customer HTML.</p></body></html>')});
 await page.locator('#pq-html-files').setInputFiles(files);await page.locator('#pq-name').fill('Mixed markets');await page.locator('#pq-default-dr').fill('20');await page.locator('#pq-default-traffic').fill('300');await page.locator('#pq-preview-import').click();
 const groups=page.locator('#pq-region-groups'),hu=()=>groups.locator('[data-geo="HU"]');await hu().waitFor();assert.equal(await groups.locator('.pq-region-group').count(),3);assert.match(await hu().textContent(),/5/);
 const firstImportKey=await page.locator('#pq-import-rows tr').filter({hasText:'hu-uj-kaszinok-0'}).getAttribute('data-import-key');assert.ok(firstImportKey);
 await hu().getByRole('button',{name:'Налаштувати',exact:true}).click();await page.locator('#pq-row-geo').fill('invalid');await page.locator('#pq-row-apply').click();await page.locator('#pq-row-note.error').waitFor();
 assert.equal(await hu().count(),1);await page.locator('#pq-row-geo').fill('AT');await page.locator('#pq-row-dr').fill('30');await page.locator('#pq-row-traffic').fill('700');
 let release,entered;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>entered=resolve);
 await page.route('**/api/lifecycle/project-import/preview',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});
 try{await page.locator('#pq-row-apply').click();await began;for(const id of ['pq-row-language','pq-row-geo','pq-row-dr','pq-row-traffic'])assert.equal(await page.locator('#'+id).isDisabled(),true);}finally{release();}
 await page.locator('#pq-row-settings').waitFor({state:'hidden',timeout:7000}).catch(async error=>{throw Error(error.message+'; notice: '+await page.locator('#pq-row-note').textContent());});await page.unroute('**/api/lifecycle/project-import/preview');await groups.locator('[data-geo="AT"]').waitFor();
 await page.locator('#pq-import-rows [data-import-key="'+firstImportKey+'"]').getByRole('button',{name:'Змінити',exact:true}).click();await page.locator('#pq-row-geo').fill('CH');await page.locator('#pq-row-apply').click();await page.locator('#pq-row-settings').waitFor({state:'hidden'});await groups.locator('[data-geo="CH"]').waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:path.resolve(__dirname,'../.desktop-build/regions-preview.png')});await page.locator('#pq-commit-import').click();await page.locator('#pq-dashboard').waitFor({state:'visible'});
 assert.equal(commits.length,1);const items=commits[0].items;assert.equal(items.length,15);assert.equal(items[0].key,firstImportKey);assert.deepEqual(items.map(i=>i.geo),['CH',...Array(4).fill('AT'),...Array(5).fill('NZ'),...Array(5).fill('PL')]);
 assert.deepEqual(items.map(i=>i.language),[...Array(5).fill('hu'),...Array(5).fill('en'),...Array(5).fill('pl')]);assert.ok(items.slice(0,5).every(i=>i.siteSelection.minDr===30&&i.siteSelection.minTraffic===700));assert.equal(items[0].html,files[0].buffer.toString('utf8'));
 const project=server.lifecycle.store.listProjects().find(p=>p.name==='Mixed markets');assert.ok(project);assert.equal(server.lifecycle.store.listRecords(project.id,'project_queue_item').length,15);
});
