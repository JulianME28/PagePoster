"use strict";
// Real browser QA is isolated from user state, WordPress, and OpenAI.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomBytes}=require('node:crypto');
const {createLocalServer}=require('../server/local.cjs');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
const ready=fs.existsSync(playwrightPath)&&fs.existsSync(chromePath);
const evidenceDir=path.resolve(__dirname,'../.pageposter/qa-browser-evidence');

test('legacy compatibility fixture verifies editor and lifecycle UI without external requests', {skip:ready?false:'Bundled Playwright and Chrome are required for this optional local-browser check.',timeout:90000},async()=>{
  const {chromium}=require(playwrightPath);
  const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),'pageposter-browser-ui-'));
  let server,browser,context;const errors=[],blocked=[],requests=[],screenshots=[];
  let apiCalls=0,siteChecks=0,pageChecks=0,bridgeCalls=0;
  try{
    await fsp.mkdir(evidenceDir,{recursive:true});
    const client={
      async checkSite(){siteChecks++;return {state:'problem',code:'auth_failed',capabilities:{},checks:[]};},
      async checkPage(){pageChecks++;return [{kind:'public',state:'ok',evidence:'Local QA fixture only; no external page was requested.'},{kind:'links',state:'unknown',evidence:'No live WordPress verification in this test.'}];}
    };
    const noBridge=async()=>{bridgeCalls++;throw Error('Browser UI QA must not write to WordPress');};
    server=await createLocalServer({env:{},fetchImpl:async()=>{apiCalls++;throw Error('Browser UI QA must not call OpenAI');},lifecycle:{dataDir,masterKey:randomBytes(32).toString('base64'),client,bridgeClient:{submitOperation:noBridge,getOperation:noBridge},workerIntervalMs:100,monitorIntervalMs:60000}});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run','--disable-features=MediaRouter,OptimizationHints']});
    context=await browser.newContext({viewport:{width:1440,height:1000},locale:'uk-UA'});
    // Playwright's built-in block accesses navigator.serviceWorker unguarded in sandboxed srcdoc.
    // The fresh profile has no workers; block registration without throwing in opaque preview frames.
    await context.addInitScript(()=>{try{if(navigator.serviceWorker)navigator.serviceWorker.register=async()=>{throw Error('Service workers are disabled in isolated UI QA');};}catch(error){if(error.name!=='SecurityError')throw error;}});
    await context.route('**/*',route=>{
      const url=route.request().url();if(new URL(url).pathname==='/'&&new URL(url).origin===origin)return route.fulfill({status:200,contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/legacy-editor.html'),'utf8')});
      if(/^https?:/.test(url)&&new URL(url).origin!==origin){blocked.push(url);return route.abort('blockedbyclient');}
      requests.push({url,method:route.request().method()});return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const screenshot=async name=>{await page.locator('#toast').waitFor({state:'hidden',timeout:9000});const target=path.join(evidenceDir,name+'.png');await page.screenshot({path:target,fullPage:true,animations:'disabled'});screenshots.push(path.relative(path.resolve(__dirname,'..'),target).replaceAll('\\','/'));};
    const loaded=await page.goto(origin,{waitUntil:'domcontentloaded'});assert.equal(loaded.status(),200);
    await page.locator('#lifecycle-panel').waitFor({state:'visible'});await page.locator('#lifecycle-editor').click();
    await page.locator('[data-path="title"]').fill('Перевірка браузера — ручний текст');
    await page.locator('[data-path="intro"]').fill('Цей ручний вступ має залишитися після зміни оформлення.');
    const snapshot=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('pageposter.micro.v1')));
    const waitForPreview=async config=>{
      await page.waitForFunction(color=>document.querySelector('#preview-frame').srcdoc.includes('--pp-bg:'+color),config.colors.background);
      const expected='rgb('+config.colors.background.slice(1).match(/../g).map(value=>parseInt(value,16)).join(', ')+')';
      const deadline=Date.now()+5000;let observed,lastError;
      while(Date.now()<deadline){try{observed=await page.frameLocator('#preview-frame').locator('#pp-landing').evaluate(el=>({background:getComputedStyle(el).backgroundColor,font:getComputedStyle(el).fontFamily,title:el.querySelector('h1')?.textContent}),undefined,{timeout:1000});if(observed.background===expected&&observed.font.includes(config.fontFamily)&&observed.title===config.title)return;}catch(error){lastError=error.message;}await new Promise(resolve=>setTimeout(resolve,40));}
      assert.fail('Preview failed to render current saved design: '+JSON.stringify({observed,expected,font:config.fontFamily,lastError}));
    };
    const initial=await snapshot();await page.locator('[data-tab="design"]').click();
    await page.locator('[data-design-action="next"]').click();const first=await snapshot();
    assert.equal(first.title,initial.title);assert.equal(first.intro,initial.intro);assert.deepEqual(first.cards,initial.cards);assert.ok(first.designVariant);
    await page.locator('[data-design-action="next"]').click();const second=await snapshot();assert.notDeepEqual(second.colors,first.colors);assert.ok(second.designVariant.sequence>first.designVariant.sequence);
    await waitForPreview(second);await screenshot('editor-desktop');
    await page.reload({waitUntil:'domcontentloaded'});assert.deepEqual((await snapshot()).designVariant,second.designVariant);assert.equal((await snapshot()).title,initial.title);
    if(await page.locator('#lifecycle-open').isVisible())await page.locator('#lifecycle-open').click();
    await page.locator('[data-lc-form="project"] [name="projectName"]').fill('QA — браузерний проєкт');
    await page.locator('[name="projectDescription"]').fill('Ізольована перевірка. Жодних живих сайтів.');
    await page.locator('[data-lc-form="project"] button[type="submit"]').click();
    await page.locator('.lc-tabs [data-lc-tab="pages"][aria-pressed="true"]').waitFor();
    assert.deepEqual(await page.locator('.lc-tabs [data-lc-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.lcTab)),['pages','sites','settings']);
    assert.equal(await page.locator('.lc-journey').count(),0);
    assert.ok(await page.locator('.lc-project-heading [data-lc-tab="campaigns"]').isVisible());
    assert.equal(await page.locator('.lc-backup-menu').getAttribute('open'),null);
    assert.equal(await page.locator('.lc-backup-menu [data-lc-action="backup"]').isVisible(),false);
    assert.equal(await page.locator('.lc-manual-tools').getAttribute('open'),null);
    const openSecondary=async destination=>{
      await page.locator('.lc-tabs [data-lc-tab="pages"]').click();
      await page.locator('.lc-secondary-tools > summary').click();
      await page.locator('.lc-secondary-tools [data-lc-tab="'+destination+'"]').click();
    };
    const openManual=async action=>{
      await page.locator('.lc-tabs [data-lc-tab="pages"]').click();
      await page.locator('.lc-manual-tools > summary').click();
      await page.locator('.lc-manual-tools [data-lc-action="'+action+'"]').click();
    };
    const projectId=await page.locator('[data-lc-project][aria-current="true"]').getAttribute('data-lc-project');
    await openManual('save-new');
    await page.getByRole('heading',{name:initial.title,exact:true}).waitFor();
    const storedPages=server.lifecycle.store.listPages(projectId);assert.equal(storedPages.length,1);assert.equal(storedPages[0].config.title,initial.title);assert.deepEqual(storedPages[0].config.designVariant,second.designVariant);
    await page.reload({waitUntil:'domcontentloaded'});if(await page.locator('#lifecycle-open').isVisible())await page.locator('#lifecycle-open').click();await page.locator('[data-lc-project="'+projectId+'"]').click();await page.locator('.lc-tabs [data-lc-tab="pages"]').click();
    await page.getByRole('heading',{name:initial.title,exact:true}).waitFor();
    // Exercise the real generation coordinator with an explicit no-AI local review.
    const localCard=page.locator('.lc-card').filter({has:page.getByRole('heading',{name:initial.title,exact:true})});
    await localCard.locator('[data-lc-action="automation-page"]').click();
    const runPanel=page.locator('.pp-runs');
    await runPanel.locator('[data-run-submit]:enabled').waitFor();
    await runPanel.locator('[name="mode"]').selectOption('manual');
    await runPanel.locator('[name="status"]').selectOption('review');
    assert.equal(await runPanel.locator('input[type="password"]').count(),0);
    const runRequest=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===origin+'/api/lifecycle/pages/'+storedPages[0].id+'/runs');
    await runPanel.locator('[data-run-submit]').click();
    const accepted=await runRequest;assert.equal(accepted.status(),202);
    const submitted=accepted.request().postDataJSON();assert.deepEqual(submitted.paths,[]);assert.deepEqual(submitted.linkInsertions,[]);assert.equal(submitted.status,'review');assert.equal(submitted.expectedRevision,storedPages[0].revision);
    const run=(await accepted.json()).run;assert.ok(run.id);assert.equal(run.idempotencyKey,submitted.idempotencyKey);
    await page.waitForFunction(async pageId=>{const response=await fetch('/api/lifecycle/pages/'+pageId+'/runs');return (await response.json()).runs.some(run=>run.state==='review');},storedPages[0].id);
    await runPanel.locator('[data-run-action="refresh"]').click();
    await runPanel.getByText('Готово до перегляду',{exact:true}).waitFor();
    const reviewedPage=server.lifecycle.store.getPage(storedPages[0].id);
    assert.ok(reviewedPage.revision>storedPages[0].revision);assert.equal(reviewedPage.lifecycleState,'review_required');
    assert.deepEqual(reviewedPage.config,storedPages[0].config);assert.equal(reviewedPage.wpId,null);
    assert.equal(requests.filter(request=>request.method==='POST'&&request.url===origin+'/api/lifecycle/pages/'+storedPages[0].id+'/runs').length,1);
    await localCard.getByText('Потрібна перевірка',{exact:true}).waitFor();
    assert.ok(await runPanel.isVisible(),'Automatic project reload after a completed run must preserve its panel.');
    await screenshot('automation-desktop');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Automation panel must fit 390px without horizontal overflow');
    await screenshot('automation-mobile');
    await page.locator('[data-lc-action="close-runs"]').click();
    assert.equal(await page.locator('.pp-runs').count(),0);
    await localCard.locator('[data-lc-action="automation-page"]').click();
    await page.locator('.pp-runs [data-run-submit]:enabled').waitFor();
    assert.equal(requests.filter(request=>request.method==='POST'&&request.url===origin+'/api/lifecycle/pages/'+storedPages[0].id+'/runs').length,1,'Reopening a completed run must not start another one.');
    await page.locator('[data-lc-action="close-runs"]').click();
    await page.setViewportSize({width:1440,height:1000});
    await openSecondary('overview');
    await page.locator('.lc-metrics').waitFor();await screenshot('workspace-overview-desktop');
    await openManual('new-page');
    await page.locator('[name="newKeyword"]').fill('Нова сторінка прямо з проєкту');
    const newLinks='Один | https://offer.test/?a=%2F&b=1#part\nДва | https://offer.test/?a=%2F&b=2';
    await page.locator('[name="newLinks"]').fill(newLinks);await page.locator('[name="newCardCount"]').fill('10');
    await page.locator('[data-lc-form="new-page"] button[type="submit"]').click();
    await page.locator('.pp-runs [data-run-submit]:enabled').waitFor();
    const newSaved=server.lifecycle.store.listPages(projectId).find(p=>p.title==='Нова сторінка прямо з проєкту');
    assert.ok(newSaved);assert.equal(newSaved.config.cards.length+newSaved.config.moreCards.length,10);
    assert.equal(newSaved.config.cards[0].url,'https://offer.test/?a=%2F&b=1#part');
    assert.equal((await snapshot()).title,initial.title,'New project page must not overwrite editor draft');
    assert.equal(requests.filter(r=>r.method==='POST'&&r.url===origin+'/api/lifecycle/pages/'+newSaved.id+'/runs').length,0,'Preparing inputs must not start paid generation');
    await page.locator('[data-lc-action="close-runs"]').click();
    await openSecondary('overview');await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await screenshot('workspace-overview-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.lc-tabs [data-lc-tab="sites"]').click();
    await page.locator('[name="siteName"]').fill('QA local fixture');await page.locator('[name="siteUrl"]').fill('https://qa-fixture.invalid/');
    await page.locator('[name="siteUsername"]').fill('qa-user');await page.locator('[name="sitePassword"]').fill('fake-test-application-password');
    await page.locator('[data-lc-form="site"] button[type="submit"]').click();
    await page.getByRole('heading',{name:'QA local fixture',exact:true}).waitFor();
    assert.equal(await page.locator('[name="sitePassword"]').inputValue(),'');assert.equal((await page.locator('#lifecycle-panel').innerText()).includes('fake-test-application-password'),false);
    const savedSite=server.lifecycle.store.listSites(projectId)[0];assert.ok(savedSite.hasCredential);
    await page.locator('[data-lc-action="check-site"]').click();await openSecondary('jobs');
    await page.waitForFunction(async()=>{const b=document.querySelector('[data-lc-project][aria-current="true"]');const r=await fetch('/api/lifecycle/projects/'+b.dataset.lcProject+'/jobs');return (await r.json()).jobs.some(j=>j.state==='failed'&&j.error&&j.error.code==='auth_failed');});
    await page.locator('[data-lc-action="refresh"]').click();await page.getByText('Неправильні реквізити доступу до сайту.',{exact:true}).first().waitFor();
    await page.locator('.lc-tabs [data-lc-tab="pages"]').click();await page.locator('.lc-register summary').click();
    await page.locator('[name="monitorTitle"]').fill('Вже опублікована — лише перевірки');const exactUrl='https://qa-fixture.invalid/already-published/?a=%2F&b=2#kept';
    await page.locator('[name="monitorUrl"]').fill(exactUrl);await page.locator('[name="monitorSite"]').selectOption(savedSite.id);await page.locator('[name="monitorWpId"]').fill('77');
    await page.locator('[data-lc-form="monitor-page"] button[type="submit"]').click();
    const existingCard=page.locator('.lc-card').filter({has:page.getByRole('heading',{name:'Вже опублікована — лише перевірки',exact:true})});await existingCard.waitFor();
    assert.equal(await existingCard.locator('a.lc-url').getAttribute('href'),exactUrl);assert.equal(await existingCard.locator('[data-lc-action="publish-page"]').count(),0);assert.equal(await existingCard.locator('[data-lc-action="update-page"]').count(),0);
    await screenshot('projects-desktop');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Project UI must fit a narrow viewport without horizontal overflow');
    await screenshot('projects-mobile');
    const failurePattern=origin+'/api/lifecycle/projects/'+projectId+'/pages';
    await context.route(failurePattern,route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'network_error'})}):route.continue());
    await page.locator('[data-lc-action="refresh"]').click();await page.locator('.lc-notice[role="alert"]').waitFor();
    assert.match(await page.locator('.lc-notice').innerText(),/з’єднатися|виконати|сервер/i);
    assert.equal(await page.locator('[data-lc-project="'+projectId+'"]').count(),1);await screenshot('api-error-mobile');
    await context.unroute(failurePattern);await page.locator('[data-lc-action="refresh"]').click();await page.getByRole('heading',{name:initial.title,exact:true}).waitFor();
    await page.locator('#lifecycle-editor').click();await page.locator('[data-tab="base"]').click();
    assert.equal(await page.locator('[data-path="title"]').inputValue(),initial.title);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Editor must fit a narrow viewport without horizontal overflow');
    await waitForPreview(second);
    await page.locator('#preview-frame').scrollIntoViewIfNeeded();
    const mobileMenu=page.frameLocator('#preview-frame').locator('.pp-mobile-nav');
    await mobileMenu.locator('summary').click();assert.equal(await mobileMenu.getAttribute('open'),'');
    assert.ok(await mobileMenu.locator('.pp-mobile-links').isVisible());
    const previewShot=path.join(evidenceDir,'preview-mobile.png');await page.screenshot({path:previewShot,animations:'disabled'});screenshots.push(path.relative(path.resolve(__dirname,'..'),previewShot).replaceAll('\\','/'));
    await mobileMenu.locator('summary').click();
    await screenshot('editor-mobile');
    assert.equal(apiCalls,0);assert.equal(bridgeCalls,0);assert.ok(siteChecks>0);assert.equal(errors.length,0,errors.join('\n'));
    assert.ok(requests.filter(r=>/^https?:/.test(r.url)).every(r=>new URL(r.url).origin===origin));
    const evidence={capturedAt:new Date().toISOString(),browser:await browser.version(),viewports:[{width:1440,height:1000},{width:390,height:844}],screenshots,externalRequestsBlocked:blocked.length,siteChecksUsingStub:siteChecks,pageChecksUsingStub:pageChecks,openAICalls:apiCalls,wordPressWrites:bridgeCalls,uncaughtBrowserErrors:errors,assertions:['editor manual text and exact URLs survive new design','distinct successive designs persist after reload','project opens its page list with three primary views and collapsed administrative controls','project create/save/reload uses isolated SQLite','manual automation review completes with exactly one run POST, unchanged config and newer saved revision','automation panel survives project refresh and fits desktop/mobile without overflow','completed review reopens without duplicate dispatch','fake credential rejection is shown without crash','existing URL registration preserves query/hash and remains read-only','503 API response produces visible recoverable error','editor and project views fit 390px viewport','sandbox preview paints selected colors/font and mobile menu opens']};
    await fsp.writeFile(path.join(evidenceDir,'result.json'),JSON.stringify(evidence,null,2)+'\n','utf8');
  }finally{
    if(context)await context.close();if(browser)await browser.close();
    if(server){await new Promise(resolve=>server.close(resolve));await server.lifecycle.close();}
    const resolved=path.resolve(dataDir),tmp=path.resolve(os.tmpdir());assert.equal(path.dirname(resolved),tmp);assert.ok(path.basename(resolved).startsWith('pageposter-browser-ui-'));await fsp.rm(resolved,{recursive:true,force:true});
  }
});
