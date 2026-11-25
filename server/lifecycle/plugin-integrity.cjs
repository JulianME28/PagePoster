// Installed PHP checksums are compared to the exact ZIPs shipped with this server.
// This is authenticated package-drift evidence, not attestation of a compromised host.
'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),{createHash}=require('node:crypto');

const BUNDLED_PLUGIN_PACKAGES=Object.freeze([
 Object.freeze({key:'cleanLinks',slug:'pageposter-clean-links',version:'1.1.1',plugin:'pageposter-clean-links/pageposter-clean-links.php',filename:'pageposter-clean-links-1.1.1.zip',relativePath:'assets/pageposter-clean-links-1.1.1.zip',sha256:'0d60dcad17b3db6f142b7c5a5745b00006425d4acc14ec3407c6ef34b05a0715'}),
 Object.freeze({key:'bridge',slug:'pageposter-bridge',version:'0.2.1',plugin:'pageposter-bridge/pageposter-bridge.php',filename:'pageposter-bridge-0.2.1.zip',relativePath:'wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip',sha256:'a914558cb4a1943414a611c4eedb47f4ae6b261432656bbcb32a94cd8c5eeff0'})
]);
function getBundledPluginPackages(){
 const root=path.resolve(__dirname,'../..');
 return BUNDLED_PLUGIN_PACKAGES.map(item=>{const bytes=fs.readFileSync(path.join(root,item.relativePath));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Plugin archive checksum mismatch');return {...item,bytes};});
}
function archiveRuntimeHashes(bytes,folder){
 if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>4*1024*1024)throw Error('Invalid plugin archive');
 const end=bytes.length-22;if(bytes.readUInt32LE(end)!==0x06054b50||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||bytes.readUInt16LE(end+20)!==0)throw Error('Unsupported plugin archive');
 const count=bytes.readUInt16LE(end+10),directory=bytes.readUInt32LE(end+16),directorySize=bytes.readUInt32LE(end+12);
 if(count<1||count>100||bytes.readUInt16LE(end+8)!==count||directory+directorySize!==end)throw Error('Invalid plugin directory');
 const files={},seen=new Set();let at=directory,total=0;
 for(let i=0;i<count;i++){
  if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw Error('Invalid plugin entry');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),compressed=bytes.readUInt32LE(at+20),plain=bytes.readUInt32LE(at+24),length=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
  const name=bytes.subarray(at+46,at+46+length).toString('utf8');at+=46+length+extra+comment;
  if(at>end||flags&1||![0,8].includes(method)||!name.startsWith(folder+'/')||name.includes('\\')||name.split('/').includes('..')||seen.has(name)||offset+30>directory||plain>2*1024*1024)throw Error('Unsafe plugin entry');
  seen.add(name);total+=plain;if(total>4*1024*1024||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid plugin contents');
  const localLength=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),start=offset+30+localLength+localExtra;
  if(bytes.subarray(offset+30,offset+30+localLength).toString('utf8')!==name||start+compressed>directory)throw Error('Invalid plugin contents');
  if(!name.endsWith('.php'))continue;
  const packed=bytes.subarray(start,start+compressed),content=method===8?zlib.inflateRawSync(packed,{maxOutputLength:2*1024*1024}):packed;
  if(content.length!==plain)throw Error('Invalid plugin size');
  files[name.slice(folder.length+1)]=createHash('sha256').update(content).digest('hex');
 }
 if(at!==end||!Object.keys(files).length)throw Error('Missing plugin runtime');
 return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
function expectedPackageIntegrity(){
 const expected={algorithm:'sha256'};for(const pkg of getBundledPluginPackages())expected[pkg.key]=archiveRuntimeHashes(pkg.bytes,pkg.slug);return expected;
}
function matchFiles(actual,expected){return !!actual&&typeof actual==='object'&&!Array.isArray(actual)&&Object.keys(actual).length===Object.keys(expected).length&&Object.keys(expected).every(name=>Object.hasOwn(actual,name)&&actual[name]===expected[name]);}
function verifyPackageIntegrity(actual){
 try{const expected=expectedPackageIntegrity(),valid=actual?.algorithm==='sha256'&&Object.keys(actual).length===3;
  const bridge=!!valid&&matchFiles(actual.bridge,expected.bridge),cleanLinks=!!valid&&matchFiles(actual.cleanLinks,expected.cleanLinks);return {verified:bridge&&cleanLinks,bridge,cleanLinks,expectedAvailable:true};
 }catch{return {verified:false,bridge:false,cleanLinks:false,expectedAvailable:false};}
}
module.exports={BUNDLED_PLUGIN_PACKAGES,getBundledPluginPackages,archiveRuntimeHashes,expectedPackageIntegrity,verifyPackageIntegrity};
