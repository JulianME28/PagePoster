const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-browser-discovery-')),names=['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA','PAGEPOSTER_CHROME'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.PROGRAMFILES=path.join(root,'system');process.env['PROGRAMFILES(X86)']=path.join(root,'system-x86');process.env.LOCALAPPDATA=path.join(root,'user');delete process.env.PAGEPOSTER_CHROME;
 const chrome=path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe');fs.mkdirSync(path.dirname(chrome),{recursive:true});fs.writeFileSync(chrome,'fixture executable is never run');
 t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}fs.rmSync(root,{recursive:true,force:true});});
 return {root,chrome,chromium:{executablePath:()=>path.join(root,'absent-playwright-browser'),launch:async()=>{throw Error('Unconfigured test launch');}}};
}
test('per-user Chrome is found by native WordPress, legacy private mode and public verification',async t=>{
 const f=fixture(t),native=await import('../server/lifecycle/wordpress-ui.mjs'),legacy=await import('../server/lifecycle/visible-wordpress.mjs'),verifier=await import('../server/lifecycle/browser-check.mjs');
 for(const create of [native.createWordPressUI,legacy.createVisibleWordPress]){const launches=[],manager=create({chromium:{...f.chromium,launch:async options=>{launches.push(options.executablePath);throw Error('Stop before launching fixture executable');}},transport:async()=>assert.fail('No network request expected')});try{await assert.rejects(manager.prepare('per-user',{headless:true}),{code:'BROWSER_UNAVAILABLE'});assert.deepEqual(launches,[f.chrome],'The per-user installation must reach the isolated browser launch');}finally{await manager.close();}}
 const launches=[],checker=verifier.createBrowserVerifier({chromium:{...f.chromium,launch:async options=>{launches.push(options.executablePath);throw Error('Stop before browser launch');}}});await checker.verifyGenerated({html:'<div id="pp-landing"><h1>Check</h1></div>',expectedUrls:[]});assert.deepEqual(launches,[f.chrome]);
});
test('ordinary Google sign-in and native WordPress honor the same explicit custom Chrome',async t=>{
 const f=fixture(t),custom=path.join(f.root,'custom','chrome.exe');fs.mkdirSync(path.dirname(custom));fs.writeFileSync(custom,'not executed');process.env.PAGEPOSTER_CHROME=custom;const launches=[];
 const open=require('../desktop/google-tab.cjs').createChromeTabOpener({spawnProcess:(file,args)=>{launches.push({file,args});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});await open('https://docs.google.com/spreadsheets/d/fixture/edit#gid=1');assert.equal(launches[0].file,custom);assert.deepEqual(launches[0].args,['https://docs.google.com/spreadsheets/d/fixture/edit#gid=1']);
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs'),paths=[],manager=createWordPressUI({chromium:{...f.chromium,launch:async options=>{paths.push(options.executablePath);throw Error('Fixture stop');}}});try{await assert.rejects(manager.prepare('custom'),{code:'BROWSER_UNAVAILABLE'});assert.deepEqual(paths,[custom]);}finally{await manager.close();}
});
test('browser discovery preserves a valid override and falls back safely when an optional path is absent',t=>{
 const f=fixture(t),{findBrowserExecutable}=require('../server/lifecycle/browser-executable.cjs'),bundled=path.join(f.root,'bundled.exe');fs.writeFileSync(bundled,'fixture');
 assert.equal(findBrowserExecutable({chromium:{executablePath:()=>bundled}}),bundled);
 process.env.PAGEPOSTER_CHROME=f.chrome;assert.equal(findBrowserExecutable({chromium:{executablePath:()=>bundled}}),f.chrome);
 process.env.PAGEPOSTER_CHROME=path.join(f.root,'missing.exe');assert.equal(findBrowserExecutable({chromium:{executablePath:()=>{throw Error('No cache');}}}),f.chrome);
 for(const executablePath of ['', 'relative.exe',f.chrome+'\0',path.join(f.root,'missing.exe')])assert.equal(findBrowserExecutable({executablePath}),null,'An explicit invalid executable must not silently pick a different browser');
});
test('Edge is available to private automation while ordinary Google Chrome selection stays Chrome-only',async t=>{
 const f=fixture(t),{findBrowserExecutable}=require('../server/lifecycle/browser-executable.cjs');fs.unlinkSync(f.chrome);const edge=path.join(process.env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe');fs.mkdirSync(path.dirname(edge),{recursive:true});fs.writeFileSync(edge,'fixture');
 assert.equal(findBrowserExecutable({chromium:f.chromium}),edge);
 const open=require('../desktop/google-tab.cjs').createChromeTabOpener({spawnProcess:()=>assert.fail('No Chrome exists in this profile')});await assert.rejects(open('https://docs.google.com/spreadsheets/d/fixture/edit#gid=1'),{code:'GOOGLE_CHROME_NOT_FOUND'});
});
