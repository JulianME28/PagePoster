'use strict';
// Exercises a real Electron window against disposable data; never publishes or calls AI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {stopElectron,cleanupSmoke,assertEndpointClosed}=require('./desktop-smoke-control.cjs');
async function main(){
 const executable=process.argv[2]||path.join(root,'.desktop-build/runtime/node_modules/electron/dist/electron.exe');
 const appPath=process.argv[3];
 const playwright=require(path.join(root,'.desktop-build/production/node_modules/playwright-core'));
 const testRoot=path.join(root,'.desktop-build/smoke',crypto.randomUUID());fs.mkdirSync(testRoot,{recursive:true});
 const env={...process.env,PAGEPOSTER_DESKTOP_TEST_ROOT:testRoot,PAGEPOSTER_MASTER_KEY:Buffer.alloc(32,91).toString('base64')};
 for(const name of ['OPENAI_API_KEY','PAGEPOSTER_ACCESS_TOKEN','PAGEPOSTER_DESKTOP_CONFIG','NODE_OPTIONS','ELECTRON_RUN_AS_NODE'])delete env[name];
 let electronApp,failure=null,phase='initializing';
 const progress=(step,details={})=>{phase=step;console.error(JSON.stringify({desktopSmoke:step,...details}));};
 progress('fixture-created',{testRoot,executable});
 const launch=async()=>{
  progress('launch-start');electronApp=await playwright._electron.launch({executablePath:executable,args:appPath?[appPath]:[],env,timeout:45000});
  const page=await electronApp.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/,{timeout:45000});
  await page.locator('#pq-dashboard[open]').waitFor();progress('launch-ready',{pid:electronApp.process().pid});return page;
 };
 const stop=async()=>{progress('stop-start',{pid:electronApp.process().pid});await stopElectron(electronApp);electronApp=null;progress('stop-complete');};
 try{
  let page=await launch();const origin=new URL(page.url()).origin;
  assert.match(await page.evaluate(()=>navigator.language),/^uk(?:-|$)/,'Built-in browser controls use Ukrainian');
  assert.equal(await page.locator('html').getAttribute('lang'),'uk');
  assert.doesNotMatch(await page.locator('body').innerText(),/[ыэъёЫЭЪЁ]/);
  assert.equal(await page.locator('#ap-runtime').textContent(),'PagePoster Desktop');
  await page.locator('#pq-dashboard').waitFor();assert.equal(await page.locator('#pq-dashboard').evaluate(element=>element.matches(':modal')),false);assert.equal(await page.locator('#pq-dashboard').evaluate(element=>getComputedStyle(element).position),'relative');assert.equal(await page.locator('#ap-launch-form').isVisible(),false);
  assert.equal(await electronApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMenuBarVisible()),false);
  assert.equal(await page.locator('#ap-app-menu').count(),0);
  assert.deepEqual(await page.evaluate(()=>({require:typeof require,process:typeof process,desktop:typeof pageposterDesktop.info})),{require:'undefined',process:'undefined',desktop:'function'});
  const desktopInfo=await page.evaluate(()=>pageposterDesktop.info());
  assert.equal(desktopInfo.desktop,true);
  const identityFile=path.join(path.dirname(executable),'build-metadata.json');
  if(fs.existsSync(identityFile)){
   const identity=JSON.parse(fs.readFileSync(identityFile,'utf8'));
   assert.equal(desktopInfo.buildId,identity.buildId);
   assert.equal(await electronApp.evaluate(()=>process.versions.electron),identity.electron.version);
   const report=await page.evaluate(async()=>await (await fetch('/api/lifecycle/support/export',{method:'POST',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:'{}'})).json());
   assert.equal(report.build.buildId,identity.buildId);
   assert.equal(report.build.manifestSha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executable),'build-manifest.json'))).digest('hex'));
  }
  assert.equal(await page.evaluate(()=>typeof pageposterDesktop.openGooglePage),'function');
  await assert.rejects(page.evaluate(()=>pageposterDesktop.openGooglePage('https://evil.example/')),/Недопустиме посилання Google/);
  assert.equal((await fetch(origin+'/api/lifecycle/projects')).status,401);
  const status=await page.evaluate(async()=>await (await fetch('/api/lifecycle/status')).json());assert.equal(status.runtime,'desktop');
  const project=await page.evaluate(async()=>{
   const response=await fetch('/api/lifecycle/projects',{method:'POST',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify({name:'Desktop persistence check',workflowType:'html'})});
   if(response.status!==201)throw Error('Temporary project creation failed');return (await response.json()).project;
  });assert.ok(project.id);
  const security=await electronApp.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};});
  assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});
  const opening=electronApp.waitForEvent('window',{timeout:10000});await page.evaluate(()=>window.open('/api/lifecycle/autopilot/missing-id/preview','_blank'));
  const popup=await opening;await popup.waitForLoadState();
  assert.deepEqual(await popup.evaluate(()=>({require:typeof require,desktop:typeof pageposterDesktop})),{require:'undefined',desktop:'undefined'});await popup.close();
  // Minimizing may keep the app running; closing its main window must exit.
  // The closing preview may still be in getAllWindows(); select the workspace.
  await electronApp.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===origin+'/').minimize(),origin);
  assert.equal(await electronApp.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===origin+'/').isMinimized(),origin),true);
  const second=spawn(executable,appPath?[appPath]:[],{env,stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Second instance did not exit')),15000);second.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Second instance failed'));});second.once('error',reject);});
  assert.equal(await electronApp.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===origin+'/').isVisible(),origin),true);
  assert.equal(await electronApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  await page.screenshot({path:path.join(testRoot,'desktop.png')});
  const closed=electronApp.waitForEvent('close',{timeout:30000});
  await electronApp.evaluate(({BrowserWindow},origin)=>{const workspace=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===origin+'/');setTimeout(()=>workspace.close(),25);},origin);
  await closed;electronApp=null;
  progress('backend-closed-check');await assertEndpointClosed(origin);progress('backend-closed-confirmed');
  page=await launch();const projects=await page.evaluate(async()=>await (await fetch('/api/lifecycle/projects')).json());
  assert.ok(projects.projects.some(value=>value.id===project.id&&value.name==='Desktop persistence check'));
  await page.getByRole('button',{name:'Керувати проєктами',exact:true}).click();
  const manager=page.locator('#ap-project-manager'),row=()=>manager.locator('[data-project-id="'+project.id+'"]');
  await row().getByRole('button',{name:'Закрити',exact:true}).click();await page.locator('#ap-project-action-confirm').click();await row().waitFor({state:'detached'});
  await page.locator('#ap-project-scope').selectOption('closed');await row().getByRole('button',{name:'До кошика',exact:true}).click();await page.locator('#ap-project-action-confirm').click();await row().waitFor({state:'detached'});
  await page.locator('#ap-project-scope').selectOption('trash');await row().getByRole('button',{name:'Відновити',exact:true}).click();await page.locator('#ap-project-action-confirm').click();await row().waitFor();
  const restored=await page.evaluate(async id=>(await(await fetch('/api/lifecycle/projects/'+id)).json()).project,project.id);assert.equal(restored.archived,false);assert.equal(restored.trashed,false);
  await page.screenshot({path:path.join(testRoot,'project-manager.png')});
  await manager.getByRole('button',{name:'Закрити керування проєктами',exact:true}).click();
  const fixtures=require('../tests/fixtures/project-normalizer.cjs');
  await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();
  await page.locator('#pq-source').selectOption('project-file');
  const input=page.locator('#pq-project-file');
  await input.setInputFiles({name:'Table fixture.xlsx',mimeType:'application/octet-stream',buffer:fixtures.xlsx()});
  await page.locator('#pq-project-file-status').getByText(/Аркуш «Pages»/).waitFor();
  assert.equal(await page.locator('#pq-type').inputValue(),'ai');
  await page.locator('#pq-preview-import').click();
  await page.locator('#pq-import-rows tr').getByText('NZ',{exact:true}).waitFor();
  await input.setInputFiles({name:'Word fixture.docx',mimeType:'application/octet-stream',buffer:fixtures.linkedDocx()});
  await page.locator('#pq-project-file-status').getByText(/Word fixture\.docx.*Генерація AI/).waitFor();
  const wordPreview=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/project-import/preview'));
  await page.locator('#pq-preview-import').click();
  const wordResult=await (await wordPreview).json();
  assert.deepEqual(wordResult.issues,[]);
  assert.deepEqual(wordResult.items[0].links,[{url:'https://example.com/?x=%2F&y=2',anchor:'Exact anchor'}]);
  await page.locator('#pq-import-rows tr').getByText('Word Page',{exact:true}).waitFor();
  const brief=Buffer.from('\n## Сторінка: Brief fixture\n- Посилання: https://example.com/?x=%2F&y=2\n- Анкор: Exact brief anchor\n- Мова: pl\n- Гео: PL');
  await input.setInputFiles({name:'Brief fixture.md',mimeType:'text/markdown',buffer:brief});
  await page.locator('#pq-project-file-status').getByText(/Сторінок у ТЗ: 1/).waitFor();
  const briefPreview=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/project-import/preview'));
  await page.locator('#pq-preview-import').click();
  const briefResult=await (await briefPreview).json();
  assert.deepEqual(briefResult.issues,[]);
  assert.deepEqual(briefResult.items[0].links,[{url:'https://example.com/?x=%2F&y=2',anchor:'Exact brief anchor'}]);
  assert.equal(briefResult.items[0].provenance.source.row,2);
  const briefRow=page.locator('#pq-import-rows tr').filter({hasText:'Brief fixture'});
  await briefRow.getByText('Посилання й анкори (1)',{exact:true}).click();
  await briefRow.getByText('Exact brief anchor',{exact:true}).waitFor();
  await input.setInputFiles({name:'Archive fixture.rar',mimeType:'application/octet-stream',buffer:fixtures.rar(fixtures.pages)});
  await page.locator('#pq-project-file-status').getByText(/HTML-файлів: 2/).waitFor();
  assert.equal(await page.locator('#pq-type').inputValue(),'html');
  await page.locator('#pq-name').fill('Archive normalization check');
  await page.locator('#pq-preview-import').click();
  await page.locator('#pq-import-rows').getByText('pl-guide',{exact:true}).waitFor();
  assert.equal(await page.locator('#pq-import-rows tr').count(),2);
  await page.locator('#pq-commit-import').click();
  await page.locator('#pq-dashboard [data-queue-project]').getByText('Archive normalization check',{exact:true}).waitFor();
  await page.locator('#pq-import-open').click();
  assert.equal(await page.locator('#pq-source').isVisible(),false);
  const autoZip=fixtures.zip([['pages/landing.html','<h1>Exact upload material</h1>'],['plan.csv','file,slug,donor,language,geo\npages/landing.html,exact-upload,https://fixture.example/,en,GB']]);
  const automatic=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/project-queue/import'));
  await page.locator('#pq-auto-file').setInputFiles({name:'One-upload fixture.zip',mimeType:'application/zip',buffer:autoZip});
  const automaticResponse=await automatic;
  assert.equal(automaticResponse.status(),201);
  const uploaded=automaticResponse.request().postDataJSON();
  assert.equal(uploaded.name,'One-upload fixture');
  assert.equal(uploaded.items[0].slug,'exact-upload');
  assert.equal(uploaded.items[0].donor,'https://fixture.example/');
  assert.equal(uploaded.items[0].html,'<h1>Exact upload material</h1>');
  await page.locator('#pq-dashboard [data-queue-project]').getByText('One-upload fixture',{exact:true}).waitFor();
  await page.locator('#pq-import-open').click();if(!await page.locator('#pq-manual-import').evaluate(panel=>panel.open))await page.locator('#pq-manual-import > summary').click();await page.locator('#pq-type').selectOption('html');await page.locator('#pq-source').selectOption('files');
  await page.locator('#pq-html-files').setInputFiles([['hu-page.html','hu'],['nz-page.html','en'],['pl-page.html','pl']].map(([name,language])=>({name,mimeType:'text/html',buffer:Buffer.from('<!doctype html><html lang="'+language+'"><body><h1>Temporary '+language+'</h1></body></html>')})));
  await page.locator('#pq-files-status').getByText(/Файлів: 3/).waitFor();
  await page.locator('#pq-name').fill('Project selection check');await page.locator('#pq-preview-import').click();await page.locator('#pq-region-groups [data-geo="HU"]').waitFor();assert.equal(await page.locator('#pq-region-groups .pq-region-group').count(),3);
  await page.locator('#pq-region-groups [data-geo="HU"]').getByRole('button',{name:'Налаштувати',exact:true}).click();await page.locator('#pq-row-geo').fill('AT');await page.locator('#pq-row-apply').click();await page.locator('#pq-row-settings').waitFor({state:'hidden'});await page.locator('#pq-region-groups [data-geo="AT"]').waitFor();
  await page.locator('#pq-bulk-dr').fill('25');await page.locator('#pq-bulk-traffic').fill('500');await page.locator('#pq-bulk-apply').click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('#pq-import-rows tr')).every(row=>row.cells[4].textContent==='25 / 500'));assert.deepEqual(await page.locator('#pq-import-rows tr').evaluateAll(rows=>rows.map(row=>row.cells[3].textContent)),['AT','NZ','PL']);
  await page.locator('#pq-import-preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(testRoot,'mixed-regions.png')});
  await page.locator('#pq-commit-import').click();await page.locator('#pq-dashboard').waitFor({state:'visible'});
  const waitForSelectionProject=async ready=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const project=await page.evaluate(async()=>{const data=await(await fetch('/api/lifecycle/project-queue')).json();return data.projects.find(p=>p.name==='Project selection check');});if(project&&ready(project))return project;await new Promise(resolve=>setTimeout(resolve,250));}throw Error('Test project preparation did not finish');};
  const selectionProject=await waitForSelectionProject(project=>project.items.length===3&&project.items.every(item=>item.pageId));
  for(const [index,item] of selectionProject.items.entries()){const saved=await page.evaluate(async({runId,index})=>{const response=await fetch('/api/lifecycle/autopilot/'+runId+'/destination',{method:'POST',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify({baseUrl:'https://selected-'+index+'.example/',username:'fixture-only',password:'fixture-only'})});return response.status;},{runId:item.runId,index});assert.equal(saved,200);}
  await waitForSelectionProject(project=>project.items.every(item=>item.selectedSite)&&!!project.publicationPlan?.token);await page.locator('.pq-workspace-actions > .pq-more > summary').click();await page.locator('#pq-refresh').click();
  const selectedProject=page.locator('[data-queue-project="'+selectionProject.projectId+'"]');await selectedProject.getByText('selected-0.example',{exact:true}).waitFor();assert.equal(await selectedProject.locator('[data-action="start-project"]').isEnabled(),true);await selectedProject.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(testRoot,'project-selected-sites.png')});
  {
   assert.equal(await page.locator('#pq-export-prepared').count(),1);
   const exported=await page.evaluate(async projectId=>{
    const project=(await(await fetch('/api/lifecycle/project-queue')).json()).projects.find(entry=>entry.projectId===projectId);
    const items=project.items.map(({id,pageId,pageRevision})=>({id,pageId,pageRevision}));
    const response=await fetch('/api/lifecycle/project-queue/export-prepared',{method:'POST',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify({items})});
    if(!response.ok)throw Error('Prepared ZIP request failed: '+response.status);
    return [...new Uint8Array(await response.arrayBuffer())];
   },selectionProject.projectId);
   const files=await require('../dist/html-package.js').unpackZip(Uint8Array.from(exported));
   const audit=JSON.parse(Buffer.from(files.find(file=>file.name==='audit.json').bytes).toString('utf8'));
   assert.equal(audit.pages.length,3);
   assert.deepEqual(audit.pages.map(item=>item.geo).sort(),['AT','NZ','PL']);
  }
  const projectActions=selectedProject.locator('.pq-more');
  await projectActions.locator('summary').click();
  await projectActions.getByRole('button',{name:'Трафік проксі',exact:true}).click();
  const proxyUsage=page.locator('#pq-proxy-usage');
  await proxyUsage.getByText(/Усього.*отримано 0 Б/).waitFor();
  await proxyUsage.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.locator('#pq-dashboard-close').click();
  await page.locator('#ap-settings-open').click();assert.equal(await page.locator('#ga-mode').inputValue(),'user');assert.equal(await page.locator('#ga-mode option[value=browser]').count(),0);assert.equal(await page.locator('#ga-client-file').count(),0);assert.equal(await page.locator('[name=sheetRange]').isVisible(),false);await page.locator('[name=spreadsheetId]').fill('https://docs.google.com/spreadsheets/d/fixture-sheet/edit?gid=0#gid=0');await page.locator('#ap-source-form button[type=submit]').click();await page.locator('#ap-settings-note').getByText(/Підключіть вибраний акаунт Google/).waitFor();const fullSource=await page.evaluate(async()=>(await(await fetch('/api/lifecycle/autopilot/status')).json()).source);assert.equal(fullSource.authMode,'user');assert.equal(fullSource.sheetId,0);assert.equal(fullSource.spreadsheetUrl,'https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=0');
  if(desktopInfo.buildId){
   await page.locator('#ap-build-identity').waitFor({state:'visible'});
   assert.ok((await page.locator('#ap-build-identity').textContent()).includes(desktopInfo.buildId));
  }
  await page.locator('#ga-connect:enabled').waitFor();assert.equal(await page.locator('#ga-setup').count(),0);assert.doesNotMatch(await page.locator('#ga-user').textContent(),/OAuth|Google Cloud|JSON/);
  const google=await page.evaluate(async()=>await(await fetch('/api/lifecycle/google/account')).json());assert.equal(google.account.managedClient,true);assert.equal(google.account.clientConfigured,true);assert.equal(google.account.connected,false);assert.equal(await page.locator('#ga-reader-install').count(),0);await page.locator('#ga-user').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(testRoot,'google-simple.png')});await page.getByRole('button',{name:'Закрити налаштування',exact:true}).click();
  await stop();
  electronApp=await playwright._electron.launch({executablePath:executable,args:appPath?[appPath]:[],env,timeout:45000});await electronApp.firstWindow();await stop();
  console.log(JSON.stringify({passed:true,executable,checks:['isolated renderer','private backend','desktop runtime','preview window','minimize and restore','single instance','main window close drains and exits','saved project after restart','exit during startup','project close/trash/restore','mixed HTML regions and group edit','bulk DR and traffic preserve separate regions','per-page selected sites and explicit project start before WordPress','full Google tab link and Google account default','ordinary Google signin without extension or JSON import','Google Chrome IPC rejects foreign URLs'],screenshot:path.join(testRoot,'project-selected-sites.png')}));
 }catch(error){failure=error;throw error;}finally{await cleanupSmoke(electronApp,{failure,report:event=>console.error(JSON.stringify({desktopSmoke:phase,...event}))});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;setTimeout(()=>process.exit(1),250);});
