'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),{createHash}=require('node:crypto');
const FILES=['pageposter-bridge.php','includes/class-contract.php','includes/class-database.php','includes/class-engine.php','includes/class-rest.php','includes/class-native-editor.php','readme.txt'];
const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function buildArchive(){
 const local=[],central=[];let offset=0;
 for(const file of FILES){
  const name=Buffer.from('pageposter-bridge/'+file),plain=fs.readFileSync(path.join(__dirname,file)),data=zlib.deflateRawSync(plain,{level:9}),crc=crc32(plain);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(33,12);
  h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(plain.length,22);h.writeUInt16LE(name.length,26);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(33,14);
  c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(plain.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
  local.push(h,name,data);central.push(c,name);offset+=h.length+name.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(FILES.length,8);end.writeUInt16LE(FILES.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
module.exports={buildArchive};
if(require.main===module){
 const output=path.join(__dirname,'pageposter-bridge-0.2.1.zip'),archive=buildArchive();fs.writeFileSync(output,archive);
 process.stdout.write(JSON.stringify({path:output,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')})+'\n');
}
