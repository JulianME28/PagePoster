'use strict';
const startupTimings=require('./startup-diagnostics.cjs').createStartupDiagnostics();startupTimings.mark('main-entered');
const {app,BrowserWindow,Menu,nativeImage,session,dialog,shell,ipcMain}=require('electron');
const {fork}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const {resolveDesktopPaths}=require('./runtime.cjs'),{isWorkspaceURL,isExternalURL,authorizeHeaders,windowPreferences}=require('./policy.cjs');
const openChromeTab=require('./google-tab.cjs').createChromeTabOpener();
app.setName('PagePoster');app.setAppUserModelId('PagePoster.Desktop');
// Chromium's built-in file controls and validation messages follow this locale.
app.commandLine.appendSwitch('lang','uk');
const testRoot=process.env.PAGEPOSTER_DESKTOP_TEST_ROOT;
if(testRoot&&path.isAbsolute(testRoot))app.setPath('userData',path.join(testRoot,'profile'));
let window=null,backend=null,origin=null,quitting=false,exiting=false,ready=false,paths=null,startupNavigation=null,rarRead=null;
const appRoot=path.resolve(__dirname,'..'),startupURL=pathToFileURL(path.join(__dirname,'startup.html')).href;
const authorization='Basic '+Buffer.from('pageposter:'+crypto.randomBytes(32).toString('hex')).toString('base64');
function show(){if(!window)return;if(window.isMinimized())window.restore();window.show();window.focus();}
function status(state,message){if(!window?.isDestroyed())window.webContents.send('pageposter:status',{state,message});}
function icon(){const file=path.join(__dirname,'icon.ico');return fs.existsSync(file)?nativeImage.createFromPath(file):nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==');}
function safeSender(event){return !!window&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&(isWorkspaceURL(event.senderFrame.url,origin)||event.senderFrame.url===startupURL);}
async function openGooglePage(event,url){if(!ready||quitting||!safeSender(event)||!isWorkspaceURL(event.senderFrame.url,origin))throw Error('Недоступно');return openChromeTab(url);}
function bindWindow(target,{primary=false}={}){
 target.webContents.on('will-navigate',(event,url)=>{if(isWorkspaceURL(url,origin)||primary&&url===startupURL)return;event.preventDefault();if(isExternalURL(url))void shell.openExternal(url);});
 target.webContents.on('will-redirect',(event,url)=>{if(!isWorkspaceURL(url,origin))event.preventDefault();});
 target.webContents.setWindowOpenHandler(({url})=>{
  if(isWorkspaceURL(url,origin)&&/^\/api\/lifecycle\/autopilot\/[a-zA-Z0-9-]+\/preview$/.test(new URL(url).pathname))return {action:'allow',overrideBrowserWindowOptions:{title:'PagePoster — перегляд',width:1250,height:850,autoHideMenuBar:true,webPreferences:{...windowPreferences(undefined),session:target.webContents.session}}};
  if(isExternalURL(url)&&!isWorkspaceURL(url,origin))void shell.openExternal(url);return {action:'deny'};
 });
 target.webContents.on('did-create-window',child=>bindWindow(child));
 target.webContents.on('will-attach-webview',event=>event.preventDefault());
}
async function failStartup(message){if(quitting||window?.isDestroyed())return;ready=false;markStartup('failed');void startupTimings.flush();show();try{if(startupNavigation)await startupNavigation;if(quitting||window?.isDestroyed())return;if(window.webContents.getURL()!==startupURL)await window.loadURL(startupURL);if(!quitting)status('error',message);}catch{}}
function sendShutdown(child=backend){if(child?.connected)try{child.send({type:'shutdown'},()=>{});}catch{}}
function sendSupportMetadata(){
 if(!backend?.connected||typeof startupTimings.snapshot!=='function')return;
 try{backend.send({type:'support-metadata',metadata:{startup:startupTimings.snapshot(),...(process.versions?.electron?{runtime:{electron:process.versions.electron}}:{})}},()=>{});}catch{}
}
function markStartup(name){const changed=startupTimings.mark(name);if(changed)sendSupportMetadata();return changed;}
function backendEnvironment(config){const result={...process.env,PAGEPOSTER_DESKTOP_CONFIG:JSON.stringify(config),PAGEPOSTER_ACCESS_TOKEN:Buffer.from(authorization.slice(6),'base64').toString().slice('pageposter:'.length)};for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_NO_ASAR','NODE_OPTIONS'])delete result[key];return result;}
function startBackend(){
 if(!fs.existsSync(paths.nodePath))return failStartup('Не знайдено вбудований Node.js. Відновіть повну теку PagePoster Desktop.');
 const config={appRoot,dataDir:paths.dataDir,keyDir:paths.keyDir,legacyEnvFile:paths.legacyEnvFile,port:0};
 backend=fork(path.join(__dirname,'backend.cjs'),[],{execPath:paths.nodePath,cwd:appRoot,env:backendEnvironment(config),silent:true,windowsHide:true});backend.stdout?.resume();backend.stderr?.resume();
 markStartup('backend-spawned');sendSupportMetadata();
 const deadline=setTimeout(()=>{if(!ready&&!quitting){void failStartup('Робочий процес не відповів. Перезапустіть застосунок; збережені сторінки залишаються в базі.');sendShutdown();}},45000);
 backend.on('message',async value=>{
  if(quitting)return;
  if(value?.type==='ready'&&!ready){if(!Number.isInteger(value.port)||value.port<1||value.port>65535)return;markStartup('backend-ready');clearTimeout(deadline);origin='http://127.0.0.1:'+value.port;ready=true;try{if(startupNavigation)await startupNavigation;if(quitting)return;await window.loadURL(origin+'/');markStartup('workspace-loaded');void startupTimings.flush();show();}catch{await failStartup('Не вдалося завантажити робоче місце. Перезапустіть PagePoster.');}}
  else if(value?.type==='error'){clearTimeout(deadline);await failStartup(typeof value.message==='string'?value.message:'Не вдалося відкрити захищену базу PagePoster.');}
 });
 backend.on('error',()=>{clearTimeout(deadline);void failStartup('Не вдалося запустити робочий процес PagePoster. Перевірте повноту теки застосунку.');});
 backend.on('exit',()=>{clearTimeout(deadline);backend=null;if(quitting)void finishQuit();else void failStartup('Робочий процес зупинився. Перезапустіть PagePoster, щоб продовжити збережені завдання.');});
}
async function finishQuit(){
 if(rarRead)await rarRead.done;
 exiting=true;app.quit();
}
async function quit(){
 if(quitting)return;quitting=true;
 rarRead?.controller.abort();
 if(!backend){await finishQuit();return;}
 // Shutdown must not depend on a renderer navigation finishing successfully.
 sendShutdown();
 try{show();if(startupNavigation)await startupNavigation;else await window.loadURL(startupURL);if(!exiting)status('stopping','Зупиняємо отримання нових завдань і чекаємо завершення вже розпочатих дій.');}catch{}
}
function zoomItems(){return [{role:'resetZoom',label:'Звичайний масштаб'},{role:'zoomIn',label:'Збільшити'},{role:'zoomOut',label:'Зменшити'}];}
function diagnosticsMenu(){return {label:'Діагностика',submenu:[{label:'Відкрити теку даних',click:()=>shell.openPath(paths.dataDir)}]};}
function about(){return dialog.showMessageBox(window,{type:'info',title:'PagePoster',message:'PagePoster Desktop '+app.getVersion(),detail:'Проєкти, генерація та публікація у Windows.\nЗакриття вікна завершує роботу програми.\nДані: '+paths.dataDir});}
function showAppMenu(event){
 if(!ready||quitting||!safeSender(event)||!isWorkspaceURL(event.senderFrame.url,origin))throw Error('Недоступно');
 Menu.buildFromTemplate([...zoomItems(),{role:'togglefullscreen',label:'На весь екран'},{type:'separator'},diagnosticsMenu(),{label:'Про PagePoster',click:about}]).popup({window});
 return {opened:true};
}
function menu(){return Menu.buildFromTemplate([
 {label:'PagePoster',submenu:[diagnosticsMenu()]},
 {label:'Редагування',submenu:[{role:'undo',label:'Скасувати'},{role:'redo',label:'Повторити'},{type:'separator'},{role:'cut',label:'Вирізати'},{role:'copy',label:'Копіювати'},{role:'paste',label:'Вставити'},{role:'selectAll',label:'Вибрати все'}]},
 {label:'Перегляд',submenu:[{label:'Оновити вікно',accelerator:'Ctrl+R',click:()=>{if(ready)window.loadURL(origin+'/');}},...zoomItems(),{role:'togglefullscreen',label:'На весь екран'}]},
 {label:'Довідка',submenu:[{label:'Про PagePoster',click:about}]}
]);}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',show);app.on('activate',show);app.on('before-quit',event=>{if(!exiting){event.preventDefault();void quit();}});
 app.whenReady().then(async()=>{
  startupTimings.mark('electron-ready');startupTimings.setDirectory(app.getPath('userData'));
  let bootstrap=null;try{bootstrap=JSON.parse(fs.readFileSync(path.join(__dirname,'bootstrap.json'),'utf8'));}catch{}
  const isolatedTest=!!testRoot&&path.isAbsolute(testRoot);
  paths=resolveDesktopPaths({appRoot:isolatedTest?testRoot:appRoot,resourcesPath:process.resourcesPath,userDataPath:app.getPath('userData'),isPackaged:app.isPackaged,bootstrap:isolatedTest?null:bootstrap,env:isolatedTest?{USERPROFILE:process.env.USERPROFILE,PAGEPOSTER_NODE_PATH:process.env.PAGEPOSTER_NODE_PATH}:process.env});
  if(testRoot&&path.isAbsolute(testRoot)){paths={...paths,dataDir:path.join(testRoot,'workspace','data'),keyDir:path.join(testRoot,'workspace','keys'),legacyEnvFile:null};}
  const desktopSession=session.fromPartition('persist:pageposter-desktop');
  desktopSession.webRequest.onCompleted(details=>{try{const url=new URL(details.url);if(details.statusCode===200&&url.origin===origin&&url.pathname==='/api/lifecycle/project-queue'&&markStartup('queue-response'))void startupTimings.flush();}catch{}});
  desktopSession.webRequest.onBeforeSendHeaders((details,callback)=>callback({requestHeaders:authorizeHeaders(details.url,details.requestHeaders,origin,authorization)}));
  desktopSession.setPermissionRequestHandler((webContents,permission,callback,details)=>callback(permission==='clipboard-sanitized-write'&&isWorkspaceURL(details.requestingUrl||webContents.getURL(),origin)));
  desktopSession.setPermissionCheckHandler((webContents,permission,requestingOrigin)=>permission==='clipboard-sanitized-write'&&isWorkspaceURL(requestingOrigin||webContents.getURL(),origin));
  desktopSession.on('will-download',(_event,item)=>{item.setSaveDialogOptions({title:'Зберегти файл PagePoster',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))});});
  window=new BrowserWindow({title:'PagePoster',width:1500,height:980,minWidth:1000,minHeight:700,backgroundColor:'#f4f7fc',icon:icon(),show:false,autoHideMenuBar:true,webPreferences:{...windowPreferences(path.join(__dirname,'preload.cjs')),session:desktopSession}});
  startupTimings.mark('window-created');
  bindWindow(window,{primary:true});window.on('close',event=>{if(!exiting){event.preventDefault();void quit();}});window.once('ready-to-show',show);
  Menu.setApplicationMenu(menu());window.setMenuBarVisibility(false);
  ipcMain.handle('pageposter:info',event=>{if(!safeSender(event))throw Error('Недоступно');const {build}=require('./support-metadata.cjs').createSupportMetadata({appRoot}).get();return {version:app.getVersion(),platform:process.platform,desktop:true,background:false,buildId:build.buildId||null};});
  ipcMain.handle('pageposter:open-google-page',openGooglePage);
  ipcMain.handle('pageposter:app-menu',showAppMenu);
  ipcMain.handle('pageposter:read-project-rar',async(event,bytes)=>{
   if(!ready||quitting||!safeSender(event)||!isWorkspaceURL(event.senderFrame.url,origin))throw Error('Недоступно');
   if(rarRead)return {error:'Дочекайтеся завершення читання поточного RAR.'};
   const controller=new AbortController();
   const done=Promise.resolve().then(async()=>({entries:await require('./project-rar.cjs').readProjectRar(bytes,{signal:controller.signal})}))
    .catch(error=>({error:error.message}));
   rarRead={controller,done};
   try{return await done;}finally{rarRead=null;}
  });
  ipcMain.handle('pageposter:restart',event=>{if(!safeSender(event)||backend)throw Error('Спочатку завершіть активний процес.');app.relaunch();exiting=true;app.exit(0);});
  // Initialize the database while Chromium loads its first renderer, rather than
  // adding both cold-start costs together. Keep navigation ordered if Node wins.
  startupNavigation=window.loadURL(startupURL);startBackend();await startupNavigation;startupNavigation=null;markStartup('startup-loaded');
 }).catch(()=>{sendShutdown();if(quitting)return;markStartup('failed');void startupTimings.flush();void dialog.showErrorBox('PagePoster','Не вдалося відкрити застосунок. Перевірте повноту теки PagePoster Desktop.');exiting=true;app.quit();});
}
