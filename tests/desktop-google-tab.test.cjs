'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');

test('Google tab uses the last active browser executable with only a URL',async()=>{
 const {createLastBrowserTabOpener}=require('../desktop/google-tab.cjs'),calls=[];
 const open=createLastBrowserTabOpener({recentBrowser:async()=>({executable:'C:/Program Files/Mozilla Firefox/firefox.exe',name:'Firefox'}),exists:()=>true,openExternal:async()=>{throw Error('Unexpected default browser');},spawnProcess:(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
 const url='https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=178594066';
 assert.deepEqual(await open(url),{opened:true,target:'last-browser',browser:'Firefox'});assert.equal(calls[0].file,'C:/Program Files/Mozilla Firefox/firefox.exe');assert.deepEqual(calls[0].args,[url]);assert.equal(calls[0].options.shell,false);assert.doesNotMatch(calls[0].args.join(' '),/user-data-dir|remote-debugging|new-window|incognito|guest/i);
});

test('unavailable recent browser falls back to the normal system browser and validates before discovery',async()=>{
 const {createLastBrowserTabOpener}=require('../desktop/google-tab.cjs'),opened=[];let discoveries=0;
 const open=createLastBrowserTabOpener({recentBrowser:async()=>{discoveries++;throw Error('private-system-info');},openExternal:async url=>opened.push(url)}),url='https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=1';
 await assert.rejects(open('https://evil.example/'),{code:'GOOGLE_TAB_URL_INVALID'});assert.equal(discoveries,0);
 assert.deepEqual(await open(url),{opened:true,target:'default-browser'});assert.deepEqual(opened,[url]);
});
test('Google sheet opens in ordinary Chrome without an isolated profile or debugging connection',async()=>{
 const {createChromeTabOpener}=require('../desktop/google-tab.cjs'),calls=[];
 const open=createChromeTabOpener({env:{PROGRAMFILES:'C:/Program Files'},exists:file=>file.replaceAll('\\','/').endsWith('Google/Chrome/Application/chrome.exe'),spawnProcess:(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();child.unref=()=>calls.push('unref');queueMicrotask(()=>child.emit('spawn'));return child;}});
 const url='https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=178594066';assert.deepEqual(await open(url),{opened:true});
 assert.deepEqual(calls[0].args,[url]);assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.stdio,'ignore');assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[1],'unref');
 assert.doesNotMatch(calls[0].args.join(' '),/user-data-dir|remote-debugging|new-window|incognito|guest/i);
});
test('Chrome opener accepts only supported Google pages and never sends an invalid URL to a process',async()=>{
 const {createChromeTabOpener}=require('../desktop/google-tab.cjs');let launched=0;
 const open=createChromeTabOpener({env:{PROGRAMFILES:'C:/Program Files'},exists:()=>true,spawnProcess:()=>{launched++;throw Error('Must not launch');}});
 for(const url of ['https://evil.example/','https://docs.google.com.evil.example/spreadsheets/d/s/edit','http://docs.google.com/spreadsheets/d/s/edit','https://user:pass@docs.google.com/spreadsheets/d/s/edit','https://docs.google.com:443/spreadsheets/d/s/edit','https://docs.google.com/document/d/s/edit','--user-data-dir=stolen','https://accounts.google.com/v3/signin/identifier','https://docs.google.com/spreadsheets/d/s/edit\n','https://console.cloud.google.com/iam-admin/iam','https://console.cloud.google.com/auth/clients?redirect=https://evil.example/'])await assert.rejects(open(url),{code:'GOOGLE_TAB_URL_INVALID'});
 assert.equal(launched,0);
});

test('one-time setup can open only the documented Google Cloud setup pages',()=>{
 const {validateGoogleTabURL}=require('../desktop/google-tab.cjs');
 for(const suffix of ['projectcreate','auth/branding','auth/clients','apis/library/sheets.googleapis.com','apis/library/drive.googleapis.com']){const url='https://console.cloud.google.com/'+suffix;assert.equal(validateGoogleTabURL(url),url);}
});
test('missing Chrome and process launch errors have safe actionable errors',async()=>{
 const {createChromeTabOpener}=require('../desktop/google-tab.cjs');
 const url='https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=state';
 await assert.rejects(createChromeTabOpener({env:{},exists:()=>false})(url),{code:'GOOGLE_CHROME_NOT_FOUND'});
 const open=createChromeTabOpener({env:{PROGRAMFILES:'C:/Program Files'},exists:()=>true,spawnProcess:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('private filesystem detail')));return child;}});
 await assert.rejects(open(url),error=>error.code==='GOOGLE_CHROME_OPEN_FAILED'&&!error.message.includes('private filesystem'));
});
