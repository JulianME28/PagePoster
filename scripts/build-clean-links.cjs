'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),source=path.join(root,'wordpress/pageposter-clean-links');
let main=fs.readFileSync(path.join(source,'pageposter-clean-links.php'),'utf8'),version=/\* Version: ([0-9.]+)/.exec(main)?.[1];
if(version!=='1.1.3')throw Error('Unexpected cleaner version');
const experimental=process.argv.includes('--amp');
if(experimental){version='1.2.1';main=main.replaceAll("1.1.3",version)+"\nrequire_once __DIR__ . '/amp-mode.php';\n";}
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return(value^0xffffffff)>>>0;}
const entries=[];
function visit(directory,relative=''){
 for(const name of fs.readdirSync(directory).sort()){
  const file=path.join(directory,name),stat=fs.lstatSync(file),next=relative?relative+'/'+name:name;
  if(stat.isSymbolicLink())throw Error('Linked plugin source');
  if(stat.isDirectory())visit(file,next);else if(stat.isFile())entries.push({name:Buffer.from('pageposter-clean-links/'+next),data:next==='pageposter-clean-links.php'&&experimental?Buffer.from(main):fs.readFileSync(file)});
 }
}
visit(source);
if(experimental)entries.push({name:Buffer.from('pageposter-clean-links/amp-mode.php'),data:fs.readFileSync(path.join(root,'wordpress/pageposter-clean-links-amp/amp-mode.php'))});
const local=[],central=[];let offset=0;
for(const entry of entries){
 const compressed=zlib.deflateRawSync(entry.data,{level:9}),checksum=crc(entry.data),header=Buffer.alloc(30),directory=Buffer.alloc(46);
 header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(entry.data.length,22);header.writeUInt16LE(entry.name.length,26);
 directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(33,14);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(entry.data.length,24);directory.writeUInt16LE(entry.name.length,28);directory.writeUInt32LE(offset,42);
 local.push(header,entry.name,compressed);central.push(directory,entry.name);offset+=header.length+entry.name.length+compressed.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const archive=Buffer.concat([...local,directory,end]);
const files=require('../server/lifecycle/plugin-integrity.cjs').archiveRuntimeHashes(archive,'pageposter-clean-links');
if(!files['templates/canvas.php'])throw Error('Canvas template missing from release');
const output=path.join(root,'assets','pageposter-clean-links-'+version+'.zip');fs.writeFileSync(output,archive);
if(experimental)fs.writeFileSync(path.join(root,'assets/pageposter-amp-package.json'),JSON.stringify({version,filename:path.basename(output),sha256:createHash('sha256').update(archive).digest('hex')},null,2)+'\n');
console.log(JSON.stringify({file:output,version,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),runtimeFiles:Object.keys(files)}));
