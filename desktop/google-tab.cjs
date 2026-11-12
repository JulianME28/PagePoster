'use strict';
const path=require('node:path'),{existsSync}=require('node:fs'),{spawn}=require('node:child_process');
const {findBrowserExecutable}=require('../server/lifecycle/browser-executable.cjs');
const messages={GOOGLE_TAB_URL_INVALID:'Недопустиме посилання Google.',GOOGLE_CHROME_NOT_FOUND:'Google Chrome не знайдено. Встановіть або відкрийте Chrome й повторіть дію.',GOOGLE_CHROME_OPEN_FAILED:'Не вдалося відкрити вкладку у Google Chrome. Відкрийте Chrome й повторіть дію.'};
function fail(code){throw Object.assign(new Error(messages[code]),{code});}
function validateGoogleTabURL(value){
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f\\]/.test(value))fail('GOOGLE_TAB_URL_INVALID');
 const sheet=/^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]{1,200}(?:\/(?:edit|view))?\/?(?:[?#].*)?$/.test(value);
 const oauth=/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth(?:\?[^#]*)?$/.test(value);
 const setup=/^https:\/\/console\.cloud\.google\.com\/(?:projectcreate|auth\/(?:branding|clients)|apis\/library\/(?:sheets|drive)\.googleapis\.com)$/.test(value);
 if(!sheet&&!oauth&&!setup)fail('GOOGLE_TAB_URL_INVALID');
 return value;
}
// Launch only a URL in ordinary Chrome. Chrome routes it into its current user
// profile; PagePoster does not inspect, copy, debug, manage or close that profile.
function createChromeTabOpener({spawnProcess=spawn,exists=existsSync,env=process.env}={}){
 return async value=>{
  const url=validateGoogleTabURL(value),executable=findBrowserExecutable({env,exists,browsers:['chrome'],preferBundled:false});if(!executable)fail('GOOGLE_CHROME_NOT_FOUND');
  try{await new Promise((resolve,reject)=>{const child=spawnProcess(executable,[url],{stdio:'ignore',shell:false,windowsHide:true});child.once('error',()=>reject(new Error('launch')));child.once('spawn',()=>{child.unref?.();resolve();});});}
  catch{fail('GOOGLE_CHROME_OPEN_FAILED');}
  return {opened:true};
 };
}
function recentBrowserWindow({execFile=require('node:child_process').execFile}={}){
 return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'recent-browser.ps1')],{windowsHide:true,timeout:5000,maxBuffer:4096},(error,stdout)=>{
  if(error)return reject(Error('Browser detection unavailable'));
  try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(Error('Browser detection unavailable'));}
 }));
}
// Pass only the URL. The ordinary browser chooses its existing profile/window;
// no profile files, cookies, debugging ports or new private windows are used.
function createLastBrowserTabOpener({recentBrowser=recentBrowserWindow,spawnProcess=spawn,exists=existsSync,openExternal}={}){
 return async value=>{
  const url=validateGoogleTabURL(value);let browser;
  try{browser=await recentBrowser();}catch{}
  if(browser&&typeof browser.executable==='string'&&path.isAbsolute(browser.executable)&&/^(?:chrome|msedge|firefox|brave|opera|vivaldi)\.exe$/i.test(path.basename(browser.executable))&&exists(browser.executable)){
   try{await new Promise((resolve,reject)=>{const child=spawnProcess(browser.executable,[url],{stdio:'ignore',shell:false,windowsHide:true});child.once('error',()=>reject(Error('launch')));child.once('spawn',()=>{child.unref?.();resolve();});});return {opened:true,target:'last-browser',browser:String(browser.name||'Браузер').slice(0,30)};}catch{}
  }
  try{if(typeof openExternal!=='function')throw Error('No browser opener');await openExternal(url);return {opened:true,target:'default-browser'};}catch{fail('GOOGLE_CHROME_OPEN_FAILED');}
 };
}
module.exports={createChromeTabOpener,createLastBrowserTabOpener,recentBrowserWindow,validateGoogleTabURL};
