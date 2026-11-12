'use strict';
function isWorkspaceURL(value,origin){try{const url=new URL(value);return !!origin&&url.origin===origin&&!url.username&&!url.password&&url.protocol==='http:';}catch{return false;}}
function isExternalURL(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
function authorizeHeaders(value,headers,origin,authorization){const result={...headers};for(const key of Object.keys(result))if(key.toLowerCase()==='authorization'&&result[key]===authorization)delete result[key];if(isWorkspaceURL(value,origin))result.Authorization=authorization;return result;}
function windowPreferences(preload){return {preload,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false,spellcheck:false};}
module.exports={isWorkspaceURL,isExternalURL,authorizeHeaders,windowPreferences};
