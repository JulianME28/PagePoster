'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {loadGoogleClient}=require('../server/lifecycle/google-client.cjs');

const ELECTRON_VERSION = '45.0.0';
const APP_VERSION = require('../desktop/package.json').version;
const PRODUCTION_DEPENDENCIES = Object.freeze(require('../desktop/production-package.json').dependencies);
const REQUIRED_APP_FILES = Object.freeze(['desktop/main.cjs','desktop/preload.cjs','desktop/backend.cjs','desktop/runtime.cjs','desktop/policy.cjs','desktop/google-tab.cjs','desktop/icon.ico','desktop/startup.html','desktop/startup.js','server/local.cjs','server/lifecycle/google-client.cjs','dist/index.html','assets/pageposter-clean-links-1.1.1.zip','assets/pageposter-clean-links-1.1.2.zip','assets/pageposter-clean-links-1.1.3.zip','wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip']);
const MANIFEST = 'build-manifest.json';
const METADATA = 'build-metadata.json';
const AREAS = ['server','dist','assets','wordpress','desktop'];
const AMP_APP_FILES=['assets/pageposter-clean-links-1.2.1.zip','assets/pageposter-amp-package.json','assets/amp/validator_wasm.js','assets/amp/README.txt','assets/amp/LICENSE.txt'];
const LOCK_INPUTS = ['runtime-package.json','runtime-pnpm-lock.yaml','production-package.json','production-pnpm-lock.yaml'];

function inside(candidate, boundary) {
  const target = path.resolve(candidate), root = path.resolve(boundary), relative = path.relative(root,target);
  if (!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw Error('Build path is outside its allowed boundary: '+target);
  // Never traverse a junction or symlink while mutating a build directory.
  let current = target;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Build path contains a symbolic link or junction: '+current);
    if (current===root) break;
    current = path.dirname(current);
  }
  return target;
}

function removeBuildPath(target, buildRoot) {
  fs.rmSync(inside(target,buildRoot),{recursive:true,force:true});
}

function copyTree(source, destination, include=()=>true, relative='') {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw Error('Cannot package a symbolic link or junction: '+source+'. Install production modules with node-linker=hoisted.');
  if (!include(relative,stat.isDirectory())) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination,{recursive:true});
    for (const name of fs.readdirSync(source).sort()) copyTree(path.join(source,name),path.join(destination,name),include,relative?relative+'/'+name:name);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(source,destination);
  } else throw Error('Unsupported package file: '+source);
}

function sourceFilter(area, relative, directory) {
  if (area==='desktop' && (relative==='google-reader' || relative.startsWith('google-reader/') || relative==='google-reader-id.cjs')) return false;
  if (area==='server' && relative==='lifecycle/google-reader.mjs') return false;
  const parts = relative.split('/');
  if (parts.some(part=>part.startsWith('.') || ['node_modules','tests','docs','keys','data'].includes(part.toLowerCase()))) return false;
  if (directory) return true;
  const ext = path.extname(relative).toLowerCase();
  if (area==='server') return ['.cjs','.mjs','.js','.json'].includes(ext);
  if (area==='dist') return ['.html','.js','.css','.svg','.png','.jpg','.jpeg','.webp','.ico','.woff','.woff2','.ttf','.json'].includes(ext);
  if (area==='assets') return /^pageposter-clean-links-1\.1\.[123]\.zip$/.test(relative)||AMP_APP_FILES.includes('assets/'+relative);
  if (area==='wordpress') return relative.startsWith('pageposter-bridge/') && (['.php','.cjs'].includes(ext) || relative==='pageposter-bridge/readme.txt' || relative==='pageposter-bridge/pageposter-bridge-0.2.1.zip');

  if (area==='desktop') return ![...LOCK_INPUTS,'runtime-cache.json','bootstrap.json','google-client.json'].includes(relative) && ['.cjs','.js','.html','.ico','.json'].includes(ext);
  return false;
}

function listFiles(root) {
  const files=[];
  function visit(dir, prefix='') {
    for (const name of fs.readdirSync(dir).sort()) {
      const filename=path.join(dir,name), relative=prefix?prefix+'/'+name:name, stat=fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw Error('Packaged symbolic link or junction: '+relative);
      if (stat.isDirectory()) visit(filename,relative);
      else if (stat.isFile()) files.push(relative);
      else throw Error('Unsupported packaged file: '+relative);
    }
  }
  visit(root);return files;
}

function sensitivePath(relative) {
  const parts=relative.toLowerCase().split('/');
  return parts.some(part=>part==='.pageposter' || part==='.git' || part==='.env' || part.startsWith('.env.') || part==='keys') || /\.(?:sqlite(?:3)?|db|pem|key|pfx|p12)(?:-|$)/i.test(relative);
}

function hashFile(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function hashEntries(entries) { return digest(JSON.stringify(entries.sort(([left],[right])=>left<right?-1:left>right?1:0))); }
function treeEntries(root, include=()=>true, map=name=>name) {
  return listFiles(root).filter(include).map(name=>[map(name),hashFile(path.join(root,name))]);
}
function includeModule(name) { return !name.split('/')[0].startsWith('.') && !name.split('/').includes('.bin'); }
function includeElectron(name) { return name!=='resources/default_app.asar'; }
function lockInputs(sourceRoot) {
  return Object.fromEntries(LOCK_INPUTS.map(name=>[name,hashFile(path.join(sourceRoot,'desktop',name))]));
}
function sourceIdentity(sourceRoot,googleClient) {
  const entries=AREAS.flatMap(area=>treeEntries(path.join(sourceRoot,area),name=>sourceFilter(area,name,false),name=>area+'/'+name));
  if(googleClient) entries.push(['desktop/google-client.json',digest(JSON.stringify(googleClient,null,2)+'\n')]);
  const notices=path.join(sourceRoot,'THIRD-PARTY-NOTICES.txt');
  if(fs.existsSync(notices)) entries.push(['THIRD-PARTY-NOTICES.txt',hashFile(notices)]);
  return hashEntries(entries);
}
function identityFromManifest(manifest, {sourceSha256,locks,nodeVersion}) {
  const select=(filter,map=name=>name)=>hashEntries(manifest.files.filter(entry=>filter(entry.path)).map(entry=>[map(entry.path),entry.sha256]));
  const dependenciesSha256=select(name=>name.startsWith('resources/app/node_modules/'),name=>name.slice('resources/app/node_modules/'.length));
  const electronSha256=select(name=>name!==METADATA && !name.startsWith('resources/app/') && name!=='resources/node/node.exe');
  const contentSha256=select(name=>name!==METADATA);
  const nodeSha256=manifest.files.find(entry=>entry.path==='resources/node/node.exe').sha256;
  return {format:1,version:manifest.version,sourceSha256,locks,node:{version:nodeVersion,sha256:nodeSha256},
    electron:{version:manifest.electronVersion,sha256:electronSha256},dependenciesSha256,contentSha256};
}
function readReleaseIdentity(stageRoot,manifest) {
  const metadata=JSON.parse(fs.readFileSync(path.join(stageRoot,METADATA),'utf8'));
  const actual=identityFromManifest(manifest,{sourceSha256:metadata.sourceSha256,locks:metadata.locks,nodeVersion:metadata.node?.version});
  const sources=manifest.files.filter(entry=>entry.path.startsWith('resources/app/') && !entry.path.startsWith('resources/app/node_modules/') && !['resources/app/package.json','resources/app/desktop/bootstrap.json'].includes(entry.path));
  const sourceSha256=hashEntries(sources.map(entry=>[entry.path.slice('resources/app/'.length),entry.sha256]));
  if(metadata.sourceSha256!==sourceSha256 || JSON.stringify(actual)!==JSON.stringify(Object.fromEntries(Object.keys(actual).map(key=>[key,metadata[key]]))) || digest(JSON.stringify(actual))!==metadata.buildId) throw Error('Desktop build identity mismatch');
  return metadata;
}

function writeManifest(stageRoot) {
  const files=listFiles(stageRoot).filter(name=>name!==MANIFEST).map(name=>{
    if (sensitivePath(name)) throw Error('Sensitive data is not allowed in a desktop package: '+name);
    return {path:name,size:fs.statSync(path.join(stageRoot,name)).size,sha256:hashFile(path.join(stageRoot,name))};
  });
  const manifest={format:1,application:'PagePoster',version:APP_VERSION,electronVersion:ELECTRON_VERSION,algorithm:'sha256',files};
  fs.writeFileSync(path.join(stageRoot,MANIFEST),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

function verifyManifest(stageRoot) {
  const manifest=JSON.parse(fs.readFileSync(path.join(stageRoot,MANIFEST),'utf8'));
  if (manifest.format!==1 || manifest.algorithm!=='sha256' || !Array.isArray(manifest.files)) throw Error('Unsupported desktop build manifest');
  const actual=listFiles(stageRoot).filter(name=>name!==MANIFEST), expected=new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path!=='string' || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some(part=>!part || part==='.' || part==='..') || expected.has(entry.path) || sensitivePath(entry.path)) throw Error('Unsafe or sensitive desktop manifest path');
    expected.add(entry.path);
    const filename=inside(path.join(stageRoot,entry.path),stageRoot);
    if (!fs.existsSync(filename) || fs.statSync(filename).size!==entry.size || hashFile(filename)!==entry.sha256) throw Error('Desktop checksum mismatch: '+entry.path);
  }
  if (actual.length!==expected.size || actual.some(name=>!expected.has(name))) throw Error('Unexpected or unlisted file in desktop package');
  return manifest;
}

function createDesktopStage({sourceRoot,stageRoot,buildRoot=path.join(sourceRoot,'.desktop-build'),electronDist,nodeExecutable,productionModules,workspaceRoot=sourceRoot,requireGoogleClient=false,clean=false,nodeVersion,testEvidence=null}) {
  inside(stageRoot,buildRoot);
  if (fs.existsSync(stageRoot)) throw Error('Desktop staging directory already exists: '+stageRoot);
  const googleClient=clean?null:loadGoogleClient(path.join(sourceRoot,'desktop/google-client.json'));
  if(requireGoogleClient&&!googleClient)throw Object.assign(Error('Register PagePoster Desktop in Google Cloud once and run scripts/configure-google-client.cjs before making a release.'),{code:'GOOGLE_CLIENT_REQUIRED'});
  const inputs=nodeVersion&&{sourceSha256:sourceIdentity(sourceRoot,googleClient),locks:lockInputs(sourceRoot),nodeVersion};
  for (const name of [...REQUIRED_APP_FILES,...AMP_APP_FILES]) if (!fs.statSync(path.join(sourceRoot,name),{throwIfNoEntry:false})?.isFile()) throw Error('Missing desktop source: '+name);
  for (const name of [path.join(electronDist,'electron.exe'),nodeExecutable]) if (!fs.statSync(name,{throwIfNoEntry:false})?.isFile()) throw Error('Missing desktop runtime: '+name);
  fs.mkdirSync(stageRoot,{recursive:true});
  copyTree(electronDist,stageRoot);
  fs.renameSync(path.join(stageRoot,'electron.exe'),path.join(stageRoot,'PagePoster.exe'));
  const defaultApp=path.join(stageRoot,'resources/default_app.asar');
  if (fs.existsSync(defaultApp)) fs.unlinkSync(inside(defaultApp,stageRoot));
  const appRoot=path.join(stageRoot,'resources/app');
  for (const area of AREAS) copyTree(path.join(sourceRoot,area),path.join(appRoot,area),(relative,directory)=>sourceFilter(area,relative,directory));
  if(googleClient)fs.writeFileSync(path.join(appRoot,'desktop/google-client.json'),JSON.stringify(googleClient,null,2)+'\n');
  if (fs.existsSync(path.join(sourceRoot,'THIRD-PARTY-NOTICES.txt'))) copyTree(path.join(sourceRoot,'THIRD-PARTY-NOTICES.txt'),path.join(appRoot,'THIRD-PARTY-NOTICES.txt'));
  copyTree(productionModules,path.join(appRoot,'node_modules'),relative=>!relative || includeModule(relative));
  copyTree(nodeExecutable,path.join(stageRoot,'resources/node/node.exe'));
  fs.writeFileSync(path.join(appRoot,'package.json'),JSON.stringify({name:'pageposter-desktop',productName:'PagePoster',version:APP_VERSION,private:true,main:'desktop/main.cjs',engines:{node:'>=24'},dependencies:PRODUCTION_DEPENDENCIES},null,2)+'\n');
  if(!clean)fs.writeFileSync(path.join(appRoot,'desktop/bootstrap.json'),JSON.stringify({workspaceRoot:path.resolve(workspaceRoot)},null,2)+'\n');
  const manifest=writeManifest(stageRoot);
  if(!inputs) return manifest;
  const identity=identityFromManifest(manifest,inputs);
  fs.writeFileSync(path.join(stageRoot,METADATA),JSON.stringify({...identity,buildId:digest(JSON.stringify(identity)),testEvidence},null,2)+'\n');
  return writeManifest(stageRoot);
}

function verifyRuntime(stageRoot,manifest=verifyManifest(stageRoot)) {
  const appRoot=path.join(stageRoot,'resources/app');
  for (const name of [...REQUIRED_APP_FILES,...AMP_APP_FILES]) if (!fs.statSync(path.join(appRoot,name),{throwIfNoEntry:false})?.isFile()) throw Error('Missing packaged application file: '+name);
  const env={...process.env};for (const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE']) delete env[key];
  const script=`const assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path'); assert.equal(process.versions.node.split('.')[0],'24'); for(const [name,version] of Object.entries(${JSON.stringify(PRODUCTION_DEPENDENCIES)})) assert.equal(JSON.parse(fs.readFileSync(path.join('node_modules',name,'package.json'),'utf8')).version,version); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE ready(value INTEGER)'); db.close(); const {JSDOM}=require('jsdom'); const window=new JSDOM('').window; assert.equal(typeof require('dompurify')(window).sanitize,'function'); window.close(); assert.equal(typeof require('css-tree').parse,'function'); assert.equal(typeof require('playwright-core').chromium.launch,'function'); assert.equal(typeof require('./server/local.cjs').createLocalServer,'function'); assert.equal(typeof require('./desktop/runtime.cjs').resolveDesktopPaths,'function'); require('./server/lifecycle/plugin-integrity.cjs').expectedPackageIntegrity(); console.log(JSON.stringify({node:process.versions.node,modules:'ready'}));`;
  const check=spawnSync(path.join(stageRoot,'resources/node/node.exe'),['--no-warnings','-e',script],{cwd:appRoot,env,encoding:'utf8',windowsHide:true,timeout:30000});
  if (check.error || check.status!==0) throw Error('Bundled Node/module verification failed: '+(check.error?.message || check.stderr || check.stdout));
  const result=JSON.parse(check.stdout.trim());
  if(manifest.files.some(entry=>entry.path===METADATA)) {
    const metadata=readReleaseIdentity(stageRoot,manifest);
    if(result.node!==metadata.node.version) throw Error('Bundled Node version differs from build identity');
    return {...result,buildId:metadata.buildId};
  }
  return result;
}

function verifyReleaseParity({sourceRoot,stageRoot,electronDist,nodeExecutable,productionModules,clean=false}) {
  const manifest=verifyManifest(stageRoot), metadata=readReleaseIdentity(stageRoot,manifest);
  const googleClient=clean?null:loadGoogleClient(path.join(sourceRoot,'desktop/google-client.json'));
  const checks=[
    ['source',metadata.sourceSha256,sourceIdentity(sourceRoot,googleClient)],
    ['lockfiles',JSON.stringify(metadata.locks),JSON.stringify(lockInputs(sourceRoot))],
    ['Node',metadata.node.sha256,hashFile(nodeExecutable)],
    ['Electron',metadata.electron.sha256,hashEntries(treeEntries(electronDist,includeElectron,name=>name==='electron.exe'?'PagePoster.exe':name))],
    ['dependencies',metadata.dependenciesSha256,hashEntries(treeEntries(productionModules,includeModule))]
  ];
  for(const [label,actual,expected] of checks) if(actual!==expected) throw Error('Desktop release parity mismatch: '+label);
  return {...metadata,manifestSha256:hashFile(path.join(stageRoot,MANIFEST))};
}

function currentSourceIdentity(sourceRoot) {
  return sourceIdentity(sourceRoot,loadGoogleClient(path.join(sourceRoot,'desktop/google-client.json')));
}

function isOutputRunning(outputRoot) {
  if (process.platform!=='win32') return false;
  const exe=path.join(path.resolve(outputRoot),'PagePoster.exe').replace(/'/g,"''");
  const command="$ErrorActionPreference='Stop'; $target='"+exe+"'; if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -First 1) { 'running' }";
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000});
  if (result.error || result.status!==0) throw Error('Could not check whether PagePoster is running. Close PagePoster before rebuilding. '+(result.error?.message || result.stderr || ''));
  return result.stdout.trim()==='running';
}

function publishStage({stageRoot,outputRoot,buildRoot,isRunning=isOutputRunning}) {
  inside(stageRoot,buildRoot);
  verifyManifest(stageRoot);
  const output=path.resolve(outputRoot);
  if (path.basename(output)!=='PagePoster Desktop' || path.parse(output).root===output) throw Error('Desktop output must be a folder named PagePoster Desktop');
  const workspaceRoot=path.resolve(buildRoot,'../..');
  if (path.dirname(output)!==workspaceRoot) throw Error('Desktop output is outside the workspace distribution folder: '+output);
  inside(output,workspaceRoot);
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw Error('Desktop output cannot be a symbolic link or junction');
  let backup;
  if (fs.existsSync(output)) {
    if (isRunning(output)) throw Error('Close the PagePoster window before updating the desktop application.');
    backup=inside(path.join(buildRoot,'previous-'+randomUUID()),buildRoot);
    try { fs.renameSync(output,backup); }
    catch(error) { throw Error('Close PagePoster and retry; the existing desktop folder could not be moved safely. '+error.message); }
  }
  try { fs.renameSync(stageRoot,output); }
  catch(error) { if (backup && !fs.existsSync(output)) fs.renameSync(backup,output);throw error; }
  return backup;
}

function runNode(filename,args,cwd) {
  const result=spawnSync(process.execPath,[filename,...args],{cwd,stdio:'inherit',windowsHide:true,env:{...process.env,PNPM_CONFIG_NODE_LINKER:'hoisted'}});
  if (result.error || result.status!==0) throw Error('Desktop dependency preparation failed: '+(result.error?.message || 'exit '+result.status));
}

function pnpmScript() {
  const configured=process.env.PAGEPOSTER_PNPM;
  const fallback=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs');
  if (!configured && fs.existsSync(fallback)) return fallback;
  if (configured && fs.existsSync(configured)) {
    if (/\.(?:cjs|mjs|js)$/i.test(configured)) return path.resolve(configured);
    const bundled=path.resolve(path.dirname(configured),'../../node/node_modules/pnpm/bin/pnpm.mjs');
    if (fs.existsSync(bundled)) return bundled;
  }
  try { return require.resolve('pnpm/bin/pnpm.cjs'); } catch {}
  throw Error('pnpm was not found. Set PAGEPOSTER_PNPM to pnpm.mjs (or the bundled fallback pnpm.cmd), then run node scripts/build-desktop.cjs again.');
}

function ensureDependencies(sourceRoot,buildRoot) {
  const runtimeRoot=path.join(buildRoot,'runtime'), productionRoot=path.join(buildRoot,'production');
  const inputs=path.join(sourceRoot,'desktop');
  const pins=JSON.parse(fs.readFileSync(path.join(inputs,'runtime-cache.json'),'utf8'));
  if(pins.format!==1 || JSON.stringify(pins.locks)!==JSON.stringify(lockInputs(sourceRoot))) throw Error('Desktop dependency inputs differ from the pinned cache');
  const installArgs=root=>['--dir',root,'install','--prod','--ignore-scripts','--frozen-lockfile','--offline','--config.verify-store-integrity=true','--config.node-linker=hoisted'];
  const runtimeManifest=JSON.parse(fs.readFileSync(path.join(inputs,'runtime-package.json'),'utf8'));
  if (runtimeManifest.dependencies?.electron!==ELECTRON_VERSION) throw Error('Desktop Electron version must be pinned to '+ELECTRON_VERSION);
  for(const [kind,root] of [['runtime',runtimeRoot],['production',productionRoot]]) {
    inside(root,buildRoot);
    if(fs.existsSync(path.join(root,'node_modules'))) continue;
    fs.mkdirSync(root,{recursive:true});
    fs.copyFileSync(path.join(inputs,kind+'-package.json'),path.join(root,'package.json'));
    fs.copyFileSync(path.join(inputs,kind+'-pnpm-lock.yaml'),path.join(root,'pnpm-lock.yaml'));
    runNode(pnpmScript(),installArgs(root),sourceRoot);
  }
  const electronRoot=path.join(runtimeRoot,'node_modules/electron'), electronDist=path.join(electronRoot,'dist');
  if (!fs.existsSync(path.join(electronDist,'electron.exe'))) throw Error('Verified Electron distribution is missing from the offline cache');
  if (hashEntries(treeEntries(electronDist,includeElectron))!==pins.electron) throw Error('Desktop Electron cache checksum mismatch');
  const productionModules=path.join(productionRoot,'node_modules');
  if (hashEntries(treeEntries(productionModules,includeModule))!==pins.production) throw Error('Desktop production cache checksum mismatch');
  return {electronDist,productionModules};
}

function main(args=process.argv.slice(2)) {
  if (args[0]==='--verify' && args.length===2) {console.log(JSON.stringify(verifyRuntime(path.resolve(args[1]))));return;}
  const clean=args.length===1&&args[0]==='--clean';
  if (args.length&&!clean) throw Error('Usage: node scripts/build-desktop.cjs [--clean | --verify "path/to/PagePoster Desktop"]');
  if (process.platform!=='win32') throw Error('Build the Windows desktop application on Windows with Node.js 24.');
  if (Number(process.versions.node.split('.')[0])!==24) throw Error('Use Node.js 24 to build the desktop application; that executable is included in the package.');
  const sourceRoot=path.resolve(__dirname,'..'),buildRoot=path.join(sourceRoot,'.desktop-build');
  const dependencies=ensureDependencies(sourceRoot,buildRoot),stageRoot=path.join(buildRoot,'stage-'+randomUUID());
  try {
    createDesktopStage({sourceRoot,buildRoot,stageRoot,nodeExecutable:process.execPath,nodeVersion:process.versions.node,requireGoogleClient:!clean,clean,...dependencies});
    const runtime=verifyRuntime(stageRoot);
    console.log(JSON.stringify({staged:stageRoot,...runtime}));
  } catch(error) {
    if (fs.existsSync(stageRoot)) removeBuildPath(stageRoot,buildRoot);
    throw error;
  }
}

module.exports={ELECTRON_VERSION,PRODUCTION_DEPENDENCIES,createDesktopStage,verifyManifest,verifyRuntime,verifyReleaseParity,currentSourceIdentity,removeBuildPath,publishStage,ensureDependencies,isOutputRunning,hashFile,hashEntries,treeEntries,lockInputs,includeModule,includeElectron,inside};
if (require.main===module) {try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
