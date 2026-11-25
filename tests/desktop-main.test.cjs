'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
function harness(loadURL){
 const googleTabs=[];
 const child=new EventEmitter();child.connected=true;child.stdout=child.stderr={resume(){}};child.messages=[];child.send=value=>child.messages.push(value);
 const window={webContents:{getURL:()=>'',send(){}},loadURL,isMinimized:()=>false,show(){},focus(){},isDestroyed:()=>false};
 const electron={app:{setName(){},setAppUserModelId(){},commandLine:{appendSwitch(name,value){assert.equal(name,'lang');assert.equal(value,'uk');}},requestSingleInstanceLock:()=>false,quit(){}},BrowserWindow:{},Menu:{},Tray:{},nativeImage:{},session:{},dialog:{},shell:{},ipcMain:{}};
 const context={require:name=>name==='./startup-diagnostics.cjs'?{createStartupDiagnostics:()=>({mark(){return false;},setDirectory(){},flush:async()=>{}})}:name==='electron'?electron:name==='./google-tab.cjs'?{createChromeTabOpener:()=>async url=>{googleTabs.push(url);return {opened:true};}}:name==='node:child_process'?{fork:()=>child}:name==='node:fs'?{existsSync:()=>true}:name.startsWith('./')?require(path.resolve(__dirname,'../desktop',name)):require(name),__dirname:path.resolve(__dirname,'../desktop'),process:{env:{}},Buffer,setTimeout:()=>1,clearTimeout(){}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8')+'\n globalThis.testMain={quit,startBackend,openGooglePage,setReady:value=>ready=value,setOrigin:value=>origin=value,setWindow:w=>window=w,setPaths:p=>paths=p};',context);
 context.testMain.setWindow(window);context.testMain.setPaths({nodePath:'C:/node.exe',dataDir:'C:/data',keyDir:'C:/keys',legacyEnvFile:null});context.testMain.startBackend();
 return {api:context.testMain,child,window,googleTabs};
}
test('desktop Exit sends shutdown even when rendering the stopping screen fails',async()=>{
 const h=harness(async()=>{throw Object.assign(Error('Navigation aborted'),{code:'ERR_ABORTED'});});
 await assert.doesNotReject(h.api.quit());assert.equal(h.child.messages.some(value=>value.type==='shutdown'),true);
});
test('backend readiness cannot navigate back to the workspace while desktop Exit is pending',async()=>{
 const loads=[];let finish;const h=harness(url=>{loads.push(url);return new Promise(resolve=>finish=resolve);});
 const exiting=h.api.quit();h.child.emit('message',{type:'ready',port:49622,pid:123});
 assert.equal(loads.some(url=>url.startsWith('http:')),false);finish();await exiting;assert.equal(h.child.messages.some(value=>value.type==='shutdown'),true);
});

test('only the ready workspace main frame may open a Google tab in personal Chrome',async()=>{
 const h=harness(async()=>{}),url='https://docs.google.com/spreadsheets/d/fixture/edit#gid=1',origin='http://127.0.0.1:49622';
 h.api.setOrigin(origin);h.window.webContents.mainFrame={url:origin+'/'};
 const event={sender:h.window.webContents,senderFrame:h.window.webContents.mainFrame};
 await assert.rejects(h.api.openGooglePage(event,url),/Недоступно/);h.api.setReady(true);
 await assert.rejects(h.api.openGooglePage({...event,sender:{}},url),/Недоступно/);
 await assert.rejects(h.api.openGooglePage({...event,senderFrame:{url:origin+'/'}},url),/Недоступно/);
 h.window.webContents.mainFrame.url='https://evil.example/';await assert.rejects(h.api.openGooglePage(event,url),/Недоступно/);
 h.window.webContents.mainFrame.url=origin+'/';await h.api.openGooglePage(event,url);assert.deepEqual(h.googleTabs,[url]);
 await h.api.quit();await assert.rejects(h.api.openGooglePage(event,url),/Недоступно/);assert.deepEqual(h.googleTabs,[url]);
});

function desktopHarness({platform='win32',balloon='supported',startupLoad}={}){
 const handlers=new Map(),popups=[],balloons=[],openedPaths=[],aboutDialogs=[],errors=[];
 const child=new EventEmitter();child.connected=true;child.stdout=child.stderr={resume(){}};child.messages=[];child.send=value=>child.messages.push(value);
 const window=new EventEmitter(),contents=new EventEmitter();contents.mainFrame={url:''};contents.session={};contents.messages=[];contents.getURL=()=>contents.mainFrame.url;contents.send=(channel,value)=>contents.messages.push({channel,value});contents.setWindowOpenHandler=()=>{};
 window.webContents=contents;window.loads=[];window.loadURL=async url=>{window.loads.push(url);if(url.startsWith('file:'))await startupLoad?.();contents.mainFrame.url=url;};window.isMinimized=()=>false;window.isDestroyed=()=>false;window.hides=0;window.shows=0;window.hide=()=>window.hides++;window.show=()=>window.shows++;window.focus=()=>{};window.setMenuBarVisibility=value=>window.menuBarVisible=value;
 let trayCreations=0;const tray=new EventEmitter();tray.setToolTip=()=>{};tray.setContextMenu=value=>tray.menu=value;tray.isDestroyed=()=>false;
 if(balloon!=='unsupported')tray.displayBalloon=value=>{balloons.push(value);if(balloon==='throws')throw Error('Notifications unavailable');};
 let boot,applicationMenu=null;
 const app=new EventEmitter();Object.assign(app,{quits:0,setName(){},setAppUserModelId(){},commandLine:{appendSwitch(name,value){assert.equal(name,'lang');assert.equal(value,'uk');}},requestSingleInstanceLock:()=>true,whenReady:()=>({then:callback=>(boot=Promise.resolve().then(callback))}),getPath:()=> 'C:/PagePoster/profile',getVersion:()=> '1.2.3',quit(){this.quits++;},relaunch(){},exit(){}});
 const desktopSession=new EventEmitter();Object.assign(desktopSession,{webRequest:{onBeforeSendHeaders(){},onCompleted(){}},setPermissionRequestHandler(){},setPermissionCheckHandler(){}});
 const electron={app,BrowserWindow:function(options){window.options=options;return window;},Tray:function(){trayCreations++;return tray;},Menu:{buildFromTemplate:items=>({items,popup:options=>popups.push({items,options})}),setApplicationMenu:value=>applicationMenu=value},nativeImage:{createFromPath:()=>({})},session:{fromPartition:()=>desktopSession},dialog:{showMessageBox:(_window,options)=>aboutDialogs.push(options),showErrorBox:(_title,message)=>errors.push(message)},shell:{openPath:value=>openedPaths.push(value)},ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)}};
 let forks=0;
 const context={require:name=>name==='./startup-diagnostics.cjs'?{createStartupDiagnostics:()=>({mark(){return false;},setDirectory(){},flush:async()=>{}})}:name==='electron'?electron:name==='./google-tab.cjs'?{createChromeTabOpener:()=>async()=>({opened:true})}:name==='node:child_process'?{fork:()=>{forks++;return child;}}:name==='node:fs'?{existsSync:()=>true,readFileSync(){throw Object.assign(Error('No bootstrap'),{code:'ENOENT'});}}:name==='./runtime.cjs'?{resolveDesktopPaths:()=>({nodePath:'C:/node.exe',dataDir:'C:/PagePoster/data',keyDir:'C:/PagePoster/keys',legacyEnvFile:null})}:name.startsWith('./')?require(path.resolve(__dirname,'../desktop',name)):require(name),__dirname:path.resolve(__dirname,'../desktop'),process:{env:{},platform},URL,Buffer,setTimeout:()=>1,clearTimeout(){}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8'),context);
 return {app,boot,window,tray,child,handlers,popups,balloons,openedPaths,aboutDialogs,errors,get trayCreations(){return trayCreations;},get forks(){return forks;},get applicationMenu(){return applicationMenu;},workspace(){child.emit('message',{type:'ready',port:49622});return Promise.resolve();},event(){return {sender:contents,senderFrame:contents.mainFrame};}};
}
function menuItems(items){return items.flatMap(item=>[item,...(item.submenu?menuItems(item.submenu):[])]);}

test('a slow startup renderer does not delay backend initialization or race workspace navigation',async()=>{
 let finishStartup;
 const pending=new Promise(resolve=>finishStartup=resolve),h=desktopHarness({startupLoad:()=>pending});
 try{
  await Promise.resolve();
  assert.equal(h.forks,1,'backend must initialize while the startup renderer is still loading');
  await h.workspace();
  assert.equal(h.window.loads.some(url=>url.startsWith('http:')),false,'ready backend must not cancel the startup navigation');
 }finally{finishStartup();await h.boot;}
 await Promise.resolve();
 assert.equal(h.window.loads.filter(url=>url.startsWith('http:')).length,1);
 assert.deepEqual(h.errors,[]);
});

test('Exit during startup reuses pending navigation and sends shutdown immediately',async()=>{
 let finishStartup;
 const pending=new Promise(resolve=>finishStartup=resolve),h=desktopHarness({startupLoad:()=>pending});
 try{
  await Promise.resolve();
  h.window.emit('close',{preventDefault(){}});
  await Promise.resolve();
  assert.equal(h.child.messages.some(value=>value.type==='shutdown'),true);
  assert.equal(h.window.loads.length,1,'Exit must not abort the startup renderer by loading it again');
 }finally{finishStartup();await h.boot;}
 assert.deepEqual(h.errors,[]);
});

test('an early backend failure waits for the startup screen without cancelling its navigation',async()=>{
 let finishStartup;
 const pending=new Promise(resolve=>finishStartup=resolve),h=desktopHarness({startupLoad:()=>pending});
 try{
  await Promise.resolve();h.child.emit('error',Error('launch failed'));await Promise.resolve();
  assert.equal(h.window.loads.length,1,'an early error must not abort the initial navigation');
 }finally{finishStartup();await h.boot;}
 await Promise.resolve();
 assert.deepEqual(h.errors,[]);
 assert.equal(h.window.webContents.messages.some(message=>message.channel==='pageposter:status'&&message.value.state==='error'),true);
});

test('desktop hides the native menu bar while retaining Edit and view shortcut roles',async()=>{
 const h=desktopHarness();await h.boot;assert.deepEqual(h.errors,[]);
 assert.equal(h.window.options.autoHideMenuBar,true);assert.equal(h.window.menuBarVisible,false);
 const items=menuItems(h.applicationMenu.items);
 for(const role of ['undo','redo','cut','copy','paste','selectAll','resetZoom','zoomIn','zoomOut','togglefullscreen'])assert.ok(items.some(item=>item.role===role),role);
 assert.equal(items.some(item=>item.label==='Показати застосунок'),false);
 const reload=items.find(item=>item.accelerator==='Ctrl+R');await h.workspace();h.window.webContents.mainFrame.url='http://127.0.0.1:49622/other';reload.click();
 assert.equal(h.window.webContents.mainFrame.url,'http://127.0.0.1:49622/');
});

test('only the ready workspace main frame can open the desktop app menu',async()=>{
 const h=desktopHarness();await h.boot;
 const openMenu=h.handlers.get('pageposter:app-menu');assert.equal(typeof openMenu,'function');
 const startupURL=h.window.webContents.getURL();assert.throws(()=>openMenu(h.event()),/Недоступно/);await h.workspace();
 assert.throws(()=>openMenu({...h.event(),sender:{}}),/Недоступно/);
 assert.throws(()=>openMenu({...h.event(),senderFrame:{url:'http://127.0.0.1:49622/'}}),/Недоступно/);
 h.window.webContents.mainFrame.url='https://evil.example/';assert.throws(()=>openMenu(h.event()),/Недоступно/);
 h.window.webContents.mainFrame.url=startupURL;assert.throws(()=>openMenu(h.event()),/Недоступно/);
 assert.equal(h.popups.length,0);h.window.webContents.mainFrame.url='http://127.0.0.1:49622/';openMenu(h.event());
 assert.equal(h.popups.length,1);assert.equal(h.popups[0].options.window,h.window);
 h.window.emit('close',{preventDefault(){}});
 assert.throws(()=>openMenu(h.event()),/Недоступно/);assert.equal(h.popups.length,1);
});

test('compact app menu keeps view diagnostics and about without a separate Exit action',async()=>{
 const h=desktopHarness();await h.boot;await h.workspace();const openMenu=h.handlers.get('pageposter:app-menu');assert.equal(typeof openMenu,'function');openMenu(h.event());
 const items=h.popups[0].items,all=menuItems(items);
 for(const role of ['resetZoom','zoomIn','zoomOut','togglefullscreen'])assert.ok(all.some(item=>item.role===role),role);
 const diagnostics=items.find(item=>item.label==='Діагностика');assert.ok(diagnostics);diagnostics.submenu.find(item=>item.label==='Відкрити теку даних').click();assert.deepEqual(h.openedPaths,['C:/PagePoster/data']);
 all.find(item=>item.label==='Про PagePoster').click();assert.equal(h.aboutDialogs.length,1);assert.match(h.aboutDialogs[0].message,/1\.2\.3/);
 assert.doesNotMatch(h.aboutDialogs[0].detail,/тре[їю]/);
 assert.equal(all.some(item=>item.label==='Завершити роботу'),false);
 assert.equal(menuItems(h.applicationMenu.items).some(item=>item.label==='Завершити роботу'),false);
 assert.equal(h.child.messages.some(value=>value.type==='shutdown'),false);
});

test('window close requests shutdown once and exits after backend drains instead of hiding to tray',async()=>{
 const h=desktopHarness();await h.boot;await h.workspace();let prevented=0;const close={preventDefault:()=>prevented++};
 h.window.emit('close',close);h.window.emit('close',close);
 assert.equal(prevented,2);assert.equal(h.child.messages.filter(value=>value.type==='shutdown').length,1);
 assert.equal(h.window.hides,0);assert.equal(h.trayCreations,0);assert.equal(h.balloons.length,0);assert.equal(h.app.quits,0);
 h.child.emit('exit',0);assert.equal(h.app.quits,1);h.window.emit('close',close);assert.equal(prevented,2);
});

test('normal app quit and close share the same safe shutdown',async()=>{
 const h=desktopHarness();await h.boot;await h.workspace();let prevented=0;
 h.app.emit('before-quit',{preventDefault:()=>prevented++});h.window.emit('close',{preventDefault:()=>prevented++});
 assert.equal(prevented,2);assert.equal(h.child.messages.filter(value=>value.type==='shutdown').length,1);assert.equal(h.window.hides,0);
 h.child.emit('exit',0);assert.equal(h.app.quits,1);
});

test('closing after backend failure exits and desktop info does not claim background mode',async()=>{
 const h=desktopHarness();await h.boot;await h.workspace();
 assert.equal(h.handlers.get('pageposter:info')(h.event()).background,false);
 h.child.emit('exit',1);h.window.emit('close',{preventDefault(){}});
 assert.equal(h.app.quits,1);assert.equal(h.window.hides,0);assert.equal(h.trayCreations,0);
});

test('desktop preload exposes a fixed app-menu invocation beside its existing API',async()=>{
 let api;const invoked=[],electron={contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'pageposterDesktop');api=value;}},ipcRenderer:{invoke:async(...args)=>{invoked.push(args);return {opened:true};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return electron;}});
 assert.equal(typeof api.showAppMenu,'function');assert.equal(Object.isFrozen(api),true);await api.showAppMenu('untrusted menu template');await api.info();await api.restart();await api.openGooglePage('https://docs.google.com/');
 assert.deepEqual(invoked,[['pageposter:app-menu'],['pageposter:info'],['pageposter:restart'],['pageposter:open-google-page','https://docs.google.com/']]);assert.equal(typeof api.onStatus,'function');
});
