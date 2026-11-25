'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const build=require('./build-desktop.cjs');
const {resolveDesktopPaths}=require('../desktop/runtime.cjs');

const sourceRoot=path.resolve(__dirname,'..');
const buildRoot=path.join(sourceRoot,'.desktop-build');
const outputRoot=path.join(sourceRoot,'..','PagePoster Desktop');

function fingerprint(){
  return build.hashEntries([
    ['app',build.currentSourceIdentity(sourceRoot)],
    ...Object.entries(build.lockInputs(sourceRoot)),
    ['desktop/runtime-cache.json',build.hashFile(path.join(sourceRoot,'desktop/runtime-cache.json'))],
    ...['scripts','tests'].flatMap(area=>build.treeEntries(path.join(sourceRoot,area),undefined,name=>area+'/'+name))
  ]);
}

function tapSummary(output){
  const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>{
    const matches=[...output.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];
    if(matches.length!==1) throw Error('Missing or ambiguous TAP count: '+key);
    return [key,Number(matches[0][1])];
  }));
  if(!counts.tests||counts.tests!==counts.pass||counts.fail||counts.cancelled||counts.skipped||counts.todo) throw Error('Release verification requires all tests to pass');
  return counts;
}

function check(releaseDir,label,args,{tap=false,timeout=25*60_000}={}){
  const filename=path.join(releaseDir,label+'.log');
  const env={...process.env};
  for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','OPENAI_API_KEY','PAGEPOSTER_ACCESS_TOKEN','PAGEPOSTER_DESKTOP_CONFIG']) delete env[key];
  console.log('Running '+label+' · '+filename);
  const log=fs.openSync(filename,'wx');
  let result;
  try{result=spawnSync(process.execPath,args,{cwd:sourceRoot,env,stdio:['ignore',log,log],windowsHide:true,timeout});}
  finally{fs.closeSync(log);}
  if(result.error||result.status!==0) throw Error(label+' failed · '+filename+' · '+(result.error?.message||'exit '+result.status));
  return {sha256:build.hashFile(filename),...(tap?tapSummary(fs.readFileSync(filename,'utf8')):{passed:true})};
}

function assertIdle(){
  if(build.isOutputRunning(outputRoot)) throw Error('Close PagePoster before installing the verified desktop build.');
  const command=String.raw`$ErrorActionPreference='Stop'
    $pattern='desktop[\x5c/]backend\.cjs|(?:^|[\x5c/\s\x22\x27])serve\.cjs(?:$|[\s\x22\x27])'
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match $pattern } | Select-Object -First 1 -ExpandProperty ProcessId`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.error||result.status!==0) throw Error('Could not verify that the PagePoster backend is stopped.');
  if(result.stdout.trim()) throw Error('Stop the PagePoster backend before installing the desktop build.');
}

function workspaceIdentity(paths){
  return build.hashEntries([['data',paths.dataDir],['keys',paths.keyDir]].flatMap(([label,root])=>
    fs.existsSync(root)?build.treeEntries(root,undefined,name=>label+'/'+name):[]));
}

function checkQueue(paths,releaseDir){
  const original=path.join(paths.dataDir,'pageposter.sqlite');
  if(!fs.existsSync(original)) return;
  const scratch=path.join(releaseDir,'queue-read');
  fs.mkdirSync(scratch);
  try{
    const copy=path.join(scratch,'pageposter.sqlite');
    fs.copyFileSync(original,copy);
    if(fs.existsSync(original+'-wal')) fs.copyFileSync(original+'-wal',copy+'-wal');
    const db=new DatabaseSync(copy,{readOnly:true});
    try{
      const running=db.prepare("SELECT 1 FROM jobs WHERE state='running' LIMIT 1").get();
      const records=db.prepare("SELECT data FROM workspace_records WHERE kind='autopilot'").iterate();
      const active=Array.from(records,record=>JSON.parse(record.data)).some(run=>!run.deletedAt&&
        (['running','publishing','checking'].includes(run.state)||run.browserPreparing||run.leaseToken&&Date.parse(run.leaseUntil)>Date.now()));
      if(running||active) throw Error('PagePoster still has an active publication or preparation. Finish or pause it before installing.');
    }finally{db.close();}
  }finally{build.removeBuildPath(scratch,buildRoot);}
}

function install(stageRoot,releaseDir,expected){
  assertIdle();
  const paths=resolveDesktopPaths({appRoot:path.join(outputRoot,'resources/app'),resourcesPath:path.join(outputRoot,'resources'),
    userDataPath:path.join(process.env.APPDATA,'PagePoster'),isPackaged:true,bootstrap:{workspaceRoot:sourceRoot}});
  const before=workspaceIdentity(paths);
  checkQueue(paths,releaseDir);
  assert.equal(workspaceIdentity(paths),before,'Workspace changed during the idle check');
  assertIdle();
  const backup=build.publishStage({stageRoot,outputRoot,buildRoot});
  try{
    const installed=build.verifyRuntime(outputRoot);
    assert.equal(installed.buildId,expected.buildId);
    assert.equal(build.hashFile(path.join(outputRoot,'build-manifest.json')),expected.manifestSha256);
    assert.equal(workspaceIdentity(paths),before,'Workspace data changed during installation');
    return {buildId:installed.buildId,manifestSha256:expected.manifestSha256,backup:backup||null,dataPreserved:true};
  }catch(error){
    assertIdle();
    fs.renameSync(outputRoot,build.inside(path.join(releaseDir,'failed-install'),buildRoot));
    if(backup) fs.renameSync(backup,outputRoot);
    throw error;
  }
}

function main(args){
  if(args.length===1&&args[0]==='--fingerprint'){console.log(fingerprint());return;}
  const [flag,reviewed,option]=args;
  if(flag!=='--reviewed'||!/^[a-f0-9]{64}$/.test(reviewed||'')||args.length>3||option&&option!=='--install')
    throw Error('Usage: node scripts/verify-release.cjs --fingerprint | --reviewed <reviewed fingerprint> [--install]');
  if(process.platform!=='win32'||process.versions.node.split('.')[0]!=='24') throw Error('Desktop releases require Windows and Node.js 24.');
  assert.equal(fingerprint(),reviewed,'The reviewed source or release checks changed');
  const releaseDir=path.join(buildRoot,'release-'+randomUUID());
  fs.mkdirSync(build.inside(releaseDir,buildRoot),{recursive:true});
  const dependencies=build.ensureDependencies(sourceRoot,buildRoot);
  const stageRoot=path.join(releaseDir,'stage'),nodeExecutable=process.execPath;
  const focused=check(releaseDir,'focused',['--test','--test-reporter=tap','tests/desktop-package.test.cjs','tests/desktop-support-metadata.test.cjs','tests/support-diagnostics.test.cjs','tests/desktop-release.test.cjs'],{tap:true});
  const full=check(releaseDir,'full',['scripts/test-full.cjs'],{tap:true});
  assert.equal(fingerprint(),reviewed,'Source changed while tests were running');
  const options={sourceRoot,buildRoot,stageRoot,nodeExecutable,nodeVersion:process.versions.node,requireGoogleClient:true,...dependencies};
  build.createDesktopStage({...options,testEvidence:{reviewed,focused,full}});
  const runtime=build.verifyRuntime(stageRoot);
  const desktop=check(releaseDir,'desktop',['scripts/verify-desktop.cjs',path.join(stageRoot,'PagePoster.exe')],{timeout:5*60_000});
  const features=check(releaseDir,'features',['--test','--test-reporter=tap','tests/publication20-composed-browser.test.cjs','tests/native-replacements-composed-browser.test.cjs'],{tap:true,timeout:10*60_000});
  assert.equal(fingerprint(),reviewed,'Source changed while verifying the staged executable');
  const identity=build.verifyReleaseParity(options);
  assert.equal(identity.buildId,runtime.buildId);
  const receipt={format:1,verifiedAt:new Date().toISOString(),buildId:identity.buildId,manifestSha256:identity.manifestSha256,
    reviewed,checks:{focused,full,desktop,features},installed:null};
  const receiptFile=path.join(releaseDir,'release-receipt.json');
  fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  if(option==='--install'){
    receipt.installed=install(stageRoot,releaseDir,identity);
    fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n');
  }
  console.log(JSON.stringify({receipt:receiptFile,...receipt,...(!receipt.installed?{stage:stageRoot}:{})}));
}

module.exports={tapSummary};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
