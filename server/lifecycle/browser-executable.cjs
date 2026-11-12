'use strict';
const path=require('node:path'),{existsSync}=require('node:fs');

// Discover executables only. This never reads or attaches to a personal browser
// profile; callers retain their own private/ordinary-window launch policies.
function findBrowserExecutable({chromium,executablePath,env=process.env,exists=existsSync,browsers=['chrome','edge'],preferBundled=true}={}){
 const valid=value=>typeof value==='string'&&value.length<=32768&&!/[\0\r\n]/.test(value)&&path.isAbsolute(value)&&exists(value);
 if(executablePath!==undefined)return valid(executablePath)?executablePath:null;
 if(valid(env.PAGEPOSTER_CHROME))return env.PAGEPOSTER_CHROME;
 const cache=()=>{try{const value=chromium?.executablePath?.();return valid(value)?value:null;}catch{return null;}};
 if(preferBundled){const bundled=cache();if(bundled)return bundled;}
 const roots=[env.PROGRAMFILES||env.ProgramFiles,env['PROGRAMFILES(X86)']||env['ProgramFiles(x86)'],env.LOCALAPPDATA||env.LocalAppData].filter(value=>typeof value==='string'&&path.isAbsolute(value)),seen=new Set();
 for(const browser of browsers){const suffix=browser==='chrome'?'Google/Chrome/Application/chrome.exe':browser==='edge'?'Microsoft/Edge/Application/msedge.exe':null;if(!suffix)continue;for(const root of roots){const value=path.join(root,suffix);if(seen.has(value))continue;seen.add(value);if(valid(value))return value;}}
 return preferBundled?null:cache();
}
module.exports={findBrowserExecutable};
