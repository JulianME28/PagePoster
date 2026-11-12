'use strict';
// Developer-only one-time setup; users of the desktop release never import JSON.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {loadGoogleClient}=require('../server/lifecycle/google-client.cjs');
function configureGoogleClient({file,sourceRoot=path.resolve(__dirname,'..')}={}){
 const client=loadGoogleClient(file);if(!client)throw Object.assign(Error('Google Desktop app registration file was not found.'),{code:'GOOGLE_CLIENT_REQUIRED'});
 const directory=path.join(sourceRoot,'desktop'),target=path.join(directory,'google-client.json'),temporary=path.join(directory,'.google-client-'+randomUUID()+'.tmp');
 fs.mkdirSync(directory,{recursive:true});try{fs.writeFileSync(temporary,JSON.stringify(client,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}
 return {configured:true};
}
module.exports={configureGoogleClient};
if(require.main===module){try{if(process.argv.length!==3)throw Error('Usage: node scripts/configure-google-client.cjs path/to/downloaded-desktop-client.json');console.log(JSON.stringify(configureGoogleClient({file:path.resolve(process.argv[2])})));}catch(error){console.error(error.code||error.message);process.exitCode=1;}}
