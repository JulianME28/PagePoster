import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
function valid(value){return typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32;}
function protect(value,operation){return new Promise((resolve,reject)=>{
 const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$r=[Security.Cryptography.ProtectedData]::"+operation+"($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))";
 const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let out='',settled=false;const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(Error('Не вдалося відкрити захищений ключ Windows.')):resolve(value);};
 const timer=setTimeout(()=>{child.kill();finish(true);},15000);child.on('error',()=>finish(true));child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8192){child.kill();finish(true);}});child.stderr.resume();child.on('close',code=>finish(code!==0,out.trim()));child.stdin.on('error',()=>finish(true));child.stdin.end(value);
});}
export async function loadMasterKey({provided,directory}={}){
 if(provided!==undefined&&provided!==''){if(!valid(provided))throw Error('PAGEPOSTER_MASTER_KEY повинен містити 32 байти у base64.');return provided;}
 if(process.platform!=='win32'||!directory)return null;
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'master.dpapi');
 try{const encrypted=await readFile(file,'utf8');const key=await protect(encrypted,'Unprotect');if(!valid(key))throw Error('Пошкоджений ключ.');return key;}catch(error){if(error.code!=='ENOENT')throw error;}
 const key=randomBytes(32).toString('base64'),encrypted=await protect(key,'Protect');
 try{await writeFile(file,encrypted,{flag:'wx',mode:0o600});return key;}catch(error){if(error.code==='EEXIST')return loadMasterKey({directory});throw error;}
}
