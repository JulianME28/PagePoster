import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSecretBox} from './secrets.mjs';
export function createAPIKeyVault({filename,masterKey}){
 const box=createSecretBox(masterKey),identity='pageposter:openai:v1';
 return {
 async read(){try{return box.decrypt(identity,JSON.parse(await readFile(filename,'utf8'))).applicationPassword;}catch(error){if(error.code==='ENOENT')return '';throw Object.assign(Error('Cannot decrypt saved API key'),{code:'SECRET_DECRYPT_FAILED'});}},
 async write(key){if(typeof key!=='string'||key.length>1024)throw Error('Invalid API key');if(!key){try{await unlink(filename);}catch(error){if(error.code!=='ENOENT')throw error;}return;}
 await mkdir(dirname(filename),{recursive:true});const temporary=filename+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(box.encrypt(identity,{username:'openai',applicationPassword:key})),{mode:0o600,flag:'wx'});await rename(temporary,filename);}finally{try{await unlink(temporary);}catch{}}}
 };
}
