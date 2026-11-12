'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pageposterDesktop',Object.freeze({
 info:()=>ipcRenderer.invoke('pageposter:info'),
 restart:()=>ipcRenderer.invoke('pageposter:restart'),
 showAppMenu:()=>ipcRenderer.invoke('pageposter:app-menu'),
 openGooglePage:url=>ipcRenderer.invoke('pageposter:open-google-page',url),
 readProjectRar:bytes=>ipcRenderer.invoke('pageposter:read-project-rar',bytes),
 onStatus:callback=>{if(typeof callback!=='function')return()=>{};const listener=(_event,value)=>callback({state:String(value.state||''),message:String(value.message||'')});ipcRenderer.on('pageposter:status',listener);return()=>ipcRenderer.removeListener('pageposter:status',listener);}
}));
