'use strict';
// Installed PagePoster; disposable profile; demo status snapshots; no external publication.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const {_electron}=require(path.join(root,'.desktop-build/production/node_modules/playwright-core'));
const {cleanupSmoke}=require(path.join(root,'scripts/desktop-smoke-control.cjs'));
const out=path.join(root,'docs/user-guide-images'),clone=value=>JSON.parse(JSON.stringify(value));
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'pageposter-guide-ua-'));
 const staged=path.join(testRoot,'screenshots');fs.mkdirSync(staged);
 const env={...process.env,PAGEPOSTER_DESKTOP_TEST_ROOT:testRoot,PAGEPOSTER_MASTER_KEY:Buffer.alloc(32,93).toString('base64')};
 for(const key of ['OPENAI_API_KEY','PAGEPOSTER_ACCESS_TOKEN','PAGEPOSTER_DESKTOP_CONFIG','PAGEPOSTER_DATA_DIR','PAGEPOSTER_KEY_DIR','NODE_OPTIONS','ELECTRON_RUN_AS_NODE'])delete env[key];
 let app,failure=null,phase='ready',overview=null,project=null,originalOverview=null,mockSettings=false,googleConfigured=false;const captures=[],blocked=[];
 try{
  const executablePath=process.env.PAGEPOSTER_GUIDE_EXE||path.resolve(root,'../PagePoster Desktop/PagePoster.exe');
  app=await _electron.launch({executablePath,env,timeout:45000});
  const page=await app.firstWindow();await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);await page.locator('#pq-dashboard[open]').waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:20,y:20,width:1440,height:1000}));
  page.setDefaultTimeout(12000);const origin=new URL(page.url()).origin;
  const info=await page.evaluate(()=>pageposterDesktop.info());assert.match(await page.evaluate(()=>navigator.language),/^uk/);
  if(process.env.PAGEPOSTER_GUIDE_BUILD_ID)assert.equal(info.buildId,process.env.PAGEPOSTER_GUIDE_BUILD_ID);
  const api=async(route,body)=>page.evaluate(async({route,body})=>{const response=await fetch('/api/lifecycle'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;},{route,body});
  await page.context().route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==origin){blocked.push(url.origin);return route.abort();}
   const endpoint=url.pathname.replace('/api/lifecycle','');
   if(endpoint==='/autopilot/status'&&mockSettings){
    const response=await route.fetch(),data=await response.json();return route.fulfill({json:{...data,aiConfigured:true,aiModel:'gpt-5.4-mini',source:{...data.source,configured:true,authMode:'user',spreadsheetId:'DEMO_SHEET',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/DEMO_SHEET/edit#gid=0',sheetId:0,range:'B:O',headerRows:1,columns:{url:'B',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O',dr:'D',traffic:'E',geo:'F'}}}});
   }
   if(endpoint==='/google/account'&&googleConfigured)return route.fulfill({json:{account:{clientConfigured:true,managedClient:true,connected:false,phase:'idle',email:''}}});
   if(/\/donors$/.test(endpoint)){
    const runId=endpoint.split('/')[2],exact={group:'exact',reason:'Точний збіг GEO: UA.',primary:false,reserveRank:null};
    const candidates=[
     {id:'demo-a',baseUrl:'https://ua-travel.example/',dr:42,traffic:1800,geo:['UA'],available:true,matchesCriteria:true,current:true,recommendation:exact},
     {id:'demo-b',baseUrl:'https://travel-notes.example/',dr:36,traffic:950,geo:['UA'],available:true,matchesCriteria:true,recommendation:{...exact,reserveRank:1}},
     {id:'demo-c',baseUrl:'https://busy-site.example/',dr:55,traffic:2900,geo:['UA'],available:false,reason:'Донор уже використовується для іншої сторінки.',matchesCriteria:true,recommendation:exact}
    ];
    if(url.searchParams.get('all')==='1'){
     candidates.pop();
     candidates.push({id:'demo-d',baseUrl:'https://pl-guides.example/',dr:34,traffic:750,geo:['PL'],available:true,matchesCriteria:false,recommendation:{group:'locale',reason:'UA → Європа (PL).',primary:false,reserveRank:2}});
    }
    return route.fulfill({json:{run:{id:runId,canSetDestination:true,selectedDomain:'https://ua-travel.example/',donorPinned:true},token:'training-catalogue',destinationRevision:1,offset:0,limit:30,total:candidates.length,criteria:{geo:'UA',minDr:null,minTraffic:null},candidates}});
   }
   if(endpoint==='/project-queue'&&request.method()==='GET'&&overview)return route.fulfill({json:overview});
   const allowedPost=/^(?:\/projects|\/project-queue\/import|\/project-import\/preview|\/autopilot\/[^/]+\/destination)$/;
   if(!['GET','HEAD'].includes(request.method())&&!(request.method()==='POST'&&allowedPost.test(endpoint))){
    blocked.push(endpoint);return route.abort();
   }
   return route.continue();
  });
  const [{projects},{aiConfigured},{account}]=await Promise.all([api('/projects'),api('/autopilot/status'),api('/google/account')]);
  const emptyProfile={projects:projects.length,aiConfigured,googleClientConfigured:account.clientConfigured,googleConnected:account.connected};
  assert.deepEqual(emptyProfile,{projects:0,aiConfigured:false,googleClientConfigured:false,googleConnected:false});
  assert.equal(await page.locator('#pq-dashboard-open').innerText(),'Сторінки й черги');
  mockSettings=true;
  await page.evaluate(()=>{window.open=()=>null;});
  async function capture(name,selector,options={}){
   if(selector)await page.locator(selector).waitFor({state:'visible'});
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(100);
   const viewport=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));let clip;
   if(!selector&&options.maxHeight)clip={x:0,y:0,width:viewport.width,height:Math.min(viewport.height,options.maxHeight)};
   if(selector){const b=await page.locator(selector).boundingBox(),pad=options.pad??12,x=Math.max(0,b.x-pad),y=Math.max(0,b.y-pad);clip={x,y,width:Math.min(viewport.width-x,b.width+pad*2+(options.extraWidth||0)),height:Math.min(viewport.height-y,options.maxHeight||b.height+pad*2+(options.extraHeight||0))};}
   if(options.endSelector&&clip){const end=await page.locator(options.endSelector).boundingBox();clip.height=Math.min(viewport.height-clip.y,end.y+end.height+12-clip.y);}
   const filename=name+'.png';await page.screenshot({path:path.join(staged,filename),...(clip?{clip}:{})});
   captures.push({file:filename,selector,phase});console.log('Captured '+filename);
  }
  async function closeSettings(){await page.getByRole('button',{name:'Закрити налаштування',exact:true}).click();}
  async function resetScroll(){await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('#pq-dashboard').scrollTop=0;document.querySelectorAll('.pq-table-wrap').forEach(el=>el.scrollTop=0);});}
  async function refresh(){await page.locator('#pq-refresh').evaluate(el=>el.click());await page.waitForTimeout(220);}
  await capture('01-workspace',null,{maxHeight:460});
  await page.locator('#ap-settings-open').click();await page.locator('[data-settings-tab=ai]').click();await page.locator('#ap-key-editor > summary').click();
  await capture('02-openai','[data-settings-pane=ai]');
  phase='google-clean-demo';
  await page.locator('[data-settings-tab=google]').click();
  assert.equal((await api('/google/account')).account.clientConfigured,false,'Fresh profile must show Google onboarding');
  await page.getByRole('button',{name:'Імпортувати реєстрацію',exact:true}).waitFor();
  await page.locator('#ga-user').scrollIntoViewIfNeeded();await capture('23-google-setup','#ga-user');
  phase='ready';googleConfigured=true;
  await closeSettings();await page.locator('#ap-settings-open').click();await page.locator('[data-settings-tab=google]').click();
  await page.locator('#ga-connect:enabled').waitFor();await capture('03-google-link','#ap-settings',{maxHeight:535});
  await page.locator('#ga-user').scrollIntoViewIfNeeded();await capture('04-google-account','#ga-user');
  await page.locator('#ap-source-advanced').evaluate(el=>el.open=true);await page.locator('#ap-source-advanced').scrollIntoViewIfNeeded();await capture('05-google-columns','#ap-source-advanced');
  await closeSettings();
  await page.locator('#pq-import-open').click();await capture('06-import','label:has(#pq-auto-file)');
  const imported=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/project-queue/import'));
  await page.locator('#pq-auto-file').setInputFiles(path.join(root,'docs/user-guide-examples/02-html-project.zip'));
  const result=await (await imported).json();console.log('Demo imported');
  for(let i=0;i<80;i++){
   const current=await api('/project-queue');project=current.projects.find(p=>p.items?.length===3);
   if(project&&project.items.every(item=>item.pageId))break;await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(project.items.length,3);assert.ok(project.items.every(item=>item.pageId));
  const siteNames=['ua-travel.example','gb-travel.example','nz-travel.example'];
  for(const [i,item] of project.items.entries())await api('/autopilot/'+item.runId+'/destination',{baseUrl:'https://'+siteNames[i]+'/',username:'training-only',password:'training-only'});
  originalOverview=await api('/project-queue');project=originalOverview.projects.find(p=>p.items.length===3);
  overview=clone(originalOverview);overview.manualPublishedReview=true;
  const display=overview.projects.find(p=>p.projectId===project.projectId);display.name='Навчальний проєкт · 3 сторінки';
  for(const item of display.items){item.canEditRequirements=true;item.canEditLanguage=true;}
  for(const [i,item] of display.items.entries())item.selectedSite={...item.selectedSite,dr:[42,48,38][i],traffic:[1800,2400,1250][i],geo:[['UA'],['GB'],['NZ']][i]};
  await refresh();await page.locator('[data-queue-item]').first().waitFor();
  await page.evaluate(()=>{document.documentElement.scrollTop=0;});
  await capture('07-project','.pq-project');
  const section=page.locator('[data-queue-project]').filter({hasText:'Навчальний проєкт'}).first();
  await section.locator('.pq-project-heading .pq-more > summary').click();await section.getByRole('button',{name:'Змінити мову / GEO / DR / трафік',exact:true}).click();await section.locator('.pq-project-heading .pq-more').evaluate(el=>el.open=false);
  await page.locator('#pq-requirements-dr-change').check();await page.locator('#pq-requirements-dr').fill('30');await page.locator('#pq-requirements-traffic-change').check();await page.locator('#pq-requirements-traffic').fill('500');await capture('08-requirements','#pq-requirements');await page.locator('#pq-requirements-close').click();
  const row=page.locator('[data-queue-item]').first();
  const firstId=await row.getAttribute('data-queue-item');
  const first=display.items.find(item=>item.id===firstId);
  assert.ok(first,'Visible row belongs to the demo snapshot');
  console.log('Donor buttons: '+JSON.stringify(await row.locator('button').allTextContents()));
  await row.locator('[data-action=choose-donor]').click();await page.locator('#ap-donor-all').check();
  await page.locator('#ap-donor-list').getByText('pl-guides.example',{exact:true}).waitFor();
  await page.locator('#ap-donor-list').getByText('Резерв №2 · UA → Європа (PL).',{exact:true}).waitFor();
  await capture('09-donors','#ap-donor-list');
  await page.locator('#ap-destination-manual-tab').click();await capture('10-manual-donor','#ap-destination',{maxHeight:660});await page.getByRole('button',{name:'Закрити вибір сайту',exact:true}).click();
  await resetScroll();await row.locator('[data-action=preview]').evaluate(el=>el.click());await page.locator('#pq-mark-reviewed:enabled').waitFor();await capture('11-preview','#pq-review',{maxHeight:520});await page.locator('#pq-mark-reviewed').scrollIntoViewIfNeeded();await capture('22-preview-actions','#pq-mark-reviewed',{extraWidth:230,extraHeight:16});
  await page.locator('#pq-mark-reviewed').click();if(await page.locator('#pq-review').evaluate(el=>el.open))await page.locator('#pq-review-close').click();await resetScroll();await row.locator('input[type=checkbox]').check();await capture('12-publish','.pq-workspace-actions',{maxHeight:510});
  await page.locator('#pq-clear-selection').click();
  phase='publishing-demo';display.counts={...display.counts,waiting:2,ready:0,publishing:1,completed:0};display.publicationPlan={count:0,blockedReason:'Поточна сторінка публікується. Наступна почнеться після завершення.'};
  for(const item of display.items.slice(1)){item.state='queued';item.stage='selecting';item.canApprove=false;}
  overview.publication={active:1,waiting:2,concurrency:1,owner:{runId:first.runId,projectId:project.projectId,title:first.title,state:'publishing'}};
  Object.assign(first,{state:'publishing',stage:'publishing',canApprove:false,canSetDestination:false});await refresh();await resetScroll();await capture('13-progress','.pq-project',{endSelector:'[data-queue-item="'+first.id+'"]'});
  phase='parking-demo';Object.assign(first,{state:'needs_attention',stage:'publishing',canPark:true,publication:{state:'manual_action',postId:315,checkpoint:'draft'},error:{code:'BROWSER_CAPTCHA_REQUIRED',message:'Пройдіть CAPTCHA у відкритому вікні WordPress, потім натисніть «Продовжити».'}});display.counts={...display.counts,publishing:0,attention:1};
  await refresh();await resetScroll();await row.locator('[data-action=park]').waitFor();await capture('27-park-action','[data-queue-item="'+first.id+'"]');
  phase='parked-demo';Object.assign(first,{canPark:false,publicationParked:true});overview.publication={active:0,waiting:2,concurrency:1};
  await refresh();await resetScroll();await row.locator('[data-action=resume-parked]').waitFor();await capture('25-parked','[data-queue-item="'+first.id+'"]');
  phase='published-demo';Object.assign(first,{state:'completed',stage:'completed',wpId:315,publishedStatus:'publish',fullUrl:'https://ua-travel.example/putivnyk/',error:null,publicationParked:false,publication:{state:'published',postId:315,checkpoint:'published'},manualReview:{state:'pending',canTrash:true,canOpenEditor:true,editorUrl:'https://ua-travel.example/wp-admin/post.php?post=315&action=edit'}});display.counts={...display.counts,publishing:0,attention:0,completed:1};overview.publication={active:0,waiting:0,concurrency:1};await refresh();
  await resetScroll();await row.locator('[data-action=published-review]').evaluate(el=>el.click());await capture('14-manual-review','#pq-published-review');await page.locator('#pq-published-review-close').click();
  phase='approved-demo';first.manualReview.state='approved';await refresh();await capture('15-approved','[data-queue-item="'+first.id+'"] td:nth-child(5)');
  phase='trash-retry-demo';Object.assign(first.manualReview,{state:'trash_failed',retryTrashRevision:3,trashMessage:'WordPress підтвердив, що сторінка досі опублікована без змін. Відхиліть її ще раз для перенесення в кошик.'});await refresh();await resetScroll();
  await row.locator('[data-action=published-review]').evaluate(el=>el.click());await capture('26-trash-retry','#pq-published-review');await page.locator('#pq-published-review-close').click();
  phase='trashed-demo';first.manualReview={state:'trashed',canTrash:false};first.publishedStatus='trash';first.fullUrl='';await refresh();await capture('16-trashed','[data-queue-item="'+first.id+'"] td:nth-child(5)');
  phase='error-demo';Object.assign(first,{state:'needs_attention',stage:'installing',wpId:null,publishedStatus:null,publication:{state:'blocked',diagnostics:[{phase:'browser',code:'BROWSER_TIMEOUT'}]},manualReview:null,canRetry:true,error:{code:'BROWSER_TIMEOUT',message:'WordPress не завершив дію за відведений час. Перевірте відкрите вікно.'}});display.counts={...display.counts,completed:0,attention:1};await refresh();await capture('17-attention','[data-queue-item="'+first.id+'"]');
  phase='ready';overview=clone(originalOverview);overview.projects[0].name='Навчальний проєкт · 3 сторінки';await refresh();
  await page.locator('.pq-workspace-actions > .pq-more > summary').click();await capture('18-export','.pq-workspace-actions > .pq-more > div');await page.locator('.pq-workspace-actions > .pq-more > summary').click();
  await page.locator('#ap-settings-open').click();await page.locator('[data-settings-tab=advanced]').click();await page.locator('#ap-backup-open').click();await capture('19-backup','#ap-backup-export-form');await page.locator('#ap-backup-close').click();
  await page.locator('[data-settings-tab=proxy]').click();await capture('20-proxy','#ap-proxy-form',{maxHeight:610});await closeSettings();
  await section.locator('.pq-project-heading .pq-more').evaluate(el=>el.open=true);await capture('21-project-actions','.pq-project-heading .pq-more[open] > div');
  phase='generation-demo';overview=null;
  await page.locator('#pq-dashboard').evaluate(el=>el.close());
  await page.locator('#ap-project-dialog').evaluate(el=>el.showModal());
  await page.locator('#ap-project-form [name=projectName]').fill('Навчальний проєкт · генерація');
  await page.locator('#ap-project-form button[type=submit]').click();
  await page.locator('#pq-dashboard[open] #pq-dashboard-close').click();
  await page.locator('#ap-composer').waitFor();
  await page.locator('#ap-editorial-language').selectOption('el');
  await page.locator('#ap-card-count').fill('4');
  await page.locator('#ap-add-link').click();
  const demoLinks=[['https://offer.example/travel','План поїздки'],['https://tips.example/travel','Поради для мандрівників']];
  for(const [i,[url,anchor]] of demoLinks.entries()){
   await page.locator('[name=linkUrl]').nth(i).fill(url);
   await page.locator('[name=linkAnchor]').nth(i).fill(anchor);
  }
  await page.locator('#ap-ai-inputs').scrollIntoViewIfNeeded();await capture('24-generation','#ap-ai-inputs');
  assert.deepEqual(blocked,[],'The guide should not attempt external requests or writes outside the demo fixture endpoints');
  assert.equal(captures.length,27);
  for(const {file} of captures)fs.copyFileSync(path.join(staged,file),path.join(out,file));
  const proof={buildId:info.buildId,locale:await page.evaluate(()=>navigator.language),emptyProfile,demo:true,isolated:true,externalRequests:blocked,captures};
  fs.mkdirSync(path.join(root,'.desktop-build/guide-ua'),{recursive:true});fs.writeFileSync(path.join(root,'.desktop-build/guide-ua/capture-proof.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify({buildId:proof.buildId,locale:proof.locale,emptyProfile,captures:captures.length,isolated:true,externalRequests:blocked.length}));
 }catch(error){failure=error;throw error;}finally{await cleanupSmoke(app,{failure});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});


