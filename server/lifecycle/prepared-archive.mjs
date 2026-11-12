import {crc32} from 'node:zlib';

const MAX_BYTES=20*1024*1024;
export const MAX_PREPARED_PAGES=100;

export function createPreparedArchive(pages){
 const local=[],directory=[],report=[];
 let offset=0,directorySize=0;
 function append(filename,body){
  const name=Buffer.from(filename),bytes=Buffer.from(body),crc=crc32(bytes);
  if(offset+directorySize+bytes.length+2*name.length+98>MAX_BYTES)
   throw Object.assign(Error('ZIP перевищує 20 МБ. Експортуйте менше сторінок.'),{code:'EXPORT_LIMIT'});
  // Store exact UTF-8 bytes. The ZIP reader can reopen even very repetitive HTML.
  const header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20,4);
  header.writeUInt16LE(0x800,6);
  header.writeUInt16LE(33,12);
  header.writeUInt32LE(crc,14);
  header.writeUInt32LE(bytes.length,18);
  header.writeUInt32LE(bytes.length,22);
  header.writeUInt16LE(name.length,26);
  const entry=Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50);
  entry.writeUInt16LE(20,4);
  header.copy(entry,6,4,28);
  entry.writeUInt32LE(offset,42);
  local.push(header,name,bytes);
  directory.push(entry,name);
  offset+=header.length+name.length+bytes.length;
  directorySize+=entry.length+name.length;
 }
 for(const {key,language,geo,prepared} of pages){
  const file=String(report.length+1).padStart(3,'0')+'.html';
  append(file,prepared.html);
  report.push({file,key,title:prepared.title,language,geo,audit:prepared.audit,warnings:prepared.warnings.map(warning=>warning.code)});
 }
 append('audit.json',JSON.stringify({version:1,pages:report},null,2)+'\n');
 const end=Buffer.alloc(22),count=report.length+1;
 end.writeUInt32LE(0x06054b50);
 end.writeUInt16LE(count,8);
 end.writeUInt16LE(count,10);
 end.writeUInt32LE(directorySize,12);
 end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,...directory,end]);
}
