'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pageposter-package-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const sourceRoot = path.join(root, 'source');
  const buildRoot = path.join(sourceRoot, '.desktop-build');
  const stageRoot = path.join(buildRoot, 'stage-fixture');
  const electronDist = path.join(root, 'electron');
  const productionModules = path.join(root, 'production', 'node_modules');
  const nodeExecutable = path.join(root, 'node.exe');
  const write = (name, bytes='fixture') => { fs.mkdirSync(path.dirname(name), {recursive:true}); fs.writeFileSync(name, bytes); };
  for (const name of ['desktop/main.cjs','desktop/preload.cjs','desktop/backend.cjs','desktop/runtime.cjs','desktop/policy.cjs','desktop/google-tab.cjs','desktop/google-reader-id.cjs','desktop/google-reader/manifest.json','desktop/google-reader/connect.html','desktop/google-reader/connect.js','desktop/google-reader/connect.css','desktop/google-reader/reader.js','server/lifecycle/google-reader.mjs','desktop/icon.ico','desktop/startup.html','desktop/startup.js','server/local.cjs','server/lifecycle/google-client.cjs','server/lifecycle/plugin-integrity.cjs','dist/index.html','assets/pageposter-clean-links-1.1.1.zip','assets/pageposter-clean-links-1.1.2.zip','assets/pageposter-clean-links-1.1.3.zip','wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip']) write(path.join(sourceRoot,name));
  for(const name of ['assets/pageposter-clean-links-1.2.1.zip','assets/pageposter-amp-package.json','assets/amp/validator_wasm.js','assets/amp/README.txt','assets/amp/LICENSE.txt'])write(path.join(sourceRoot,name));
  write(path.join(sourceRoot, 'desktop/runtime-package.json'), '{"dependencies":{"electron":"45.0.0"}}');
  write(path.join(sourceRoot, 'THIRD-PARTY-NOTICES.txt'));
  write(path.join(electronDist, 'electron.exe'), 'electron binary');
  write(path.join(electronDist, 'resources/default_app.asar'));
  write(path.join(electronDist, 'locales/en-US.pak'));
  write(path.join(electronDist, 'LICENSE'));
  write(path.join(productionModules, 'dompurify/index.js'));
  write(nodeExecutable, 'node binary');
  return {root, sourceRoot, buildRoot, stageRoot, electronDist, productionModules, nodeExecutable, write};
}

test('desktop staging bundles its runtimes and allowlisted app without workspace secrets', t => {
  const f = fixture(t);
  for (const name of ['.env','.pageposter/data/projects.sqlite','.pageposter/keys/key.dat','node_modules/dev-only/index.js','docs/private.txt','server/.env','server/private.key','desktop/bootstrap.json']) f.write(path.join(f.sourceRoot,name), 'DO NOT DISTRIBUTE');
  const {createDesktopStage, verifyManifest} = require('../scripts/build-desktop.cjs');
  const result = createDesktopStage(f);
  assert.equal(fs.readFileSync(path.join(f.stageRoot,'PagePoster.exe'),'utf8'), 'electron binary');
  assert.equal(fs.readFileSync(path.join(f.stageRoot,'resources/node/node.exe'),'utf8'), 'node binary');
  assert.equal(fs.existsSync(path.join(f.stageRoot,'electron.exe')), false);
  assert.equal(fs.existsSync(path.join(f.stageRoot,'resources/default_app.asar')), false);
  const app = path.join(f.stageRoot,'resources/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
  assert.equal(manifest.main, 'desktop/main.cjs');
  assert.equal(manifest.name, 'pageposter-desktop');
  assert.equal(manifest.dependencies['playwright-core'], '1.64.1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app,'desktop/bootstrap.json'),'utf8')), {workspaceRoot:f.sourceRoot});
  for (const name of ['.env','.pageposter','docs','server/.env','server/private.key','desktop/runtime-package.json','node_modules/dev-only']) assert.equal(fs.existsSync(path.join(app,name)),false,name);
  assert.equal(fs.existsSync(path.join(app,'assets/pageposter-clean-links-1.1.2.zip')),true);
  assert.equal(fs.existsSync(path.join(app,'assets/pageposter-clean-links-1.1.3.zip')),true);
  for(const name of ['assets/pageposter-clean-links-1.2.1.zip','assets/pageposter-amp-package.json','assets/amp/validator_wasm.js','assets/amp/README.txt','assets/amp/LICENSE.txt'])assert.equal(fs.existsSync(path.join(app,name)),true,name);
  assert.equal(fs.existsSync(path.join(app,'wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip')),true);
  assert.equal(fs.existsSync(path.join(app,'desktop/startup.js')),true);
  assert.equal(fs.existsSync(path.join(app,'desktop/policy.cjs')),true);
  assert.equal(fs.existsSync(path.join(app,'desktop/google-tab.cjs')),true);
  assert.equal(verifyManifest(f.stageRoot).files.length, result.files.length);
});

test('clean desktop staging omits the maintainer registration and workspace binding',t=>{
 const f=fixture(t);f.write(path.join(f.sourceRoot,'desktop/google-client.json'),'{invalid private local registration}');
 const {createDesktopStage,verifyManifest}=require('../scripts/build-desktop.cjs');createDesktopStage({...f,clean:true});
 const app=path.join(f.stageRoot,'resources/app');assert.equal(fs.existsSync(path.join(app,'desktop/google-client.json')),false);assert.equal(fs.existsSync(path.join(app,'desktop/bootstrap.json')),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(app,'package.json'))).version,require('../desktop/package.json').version);assert.ok(verifyManifest(f.stageRoot).files.length>0);
});

test('staging refuses missing desktop startup files before creating a partial package', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.sourceRoot,'desktop/startup.js'));
  const {createDesktopStage} = require('../scripts/build-desktop.cjs');
  assert.throws(() => createDesktopStage(f), /missing desktop source.*startup\.js/i);
  assert.equal(fs.existsSync(f.stageRoot),false);
});

test('release staging refuses a missing Google registration before writing a package',t=>{
 const f=fixture(t),{createDesktopStage}=require('../scripts/build-desktop.cjs');
 assert.throws(()=>createDesktopStage({...f,requireGoogleClient:true}),error=>error.code==='GOOGLE_CLIENT_REQUIRED');assert.equal(fs.existsSync(f.stageRoot),false);
});

test('release bundles only normalized app registration and never a user grant',t=>{
 const f=fixture(t),{createDesktopStage}=require('../scripts/build-desktop.cjs');
 f.write(path.join(f.sourceRoot,'desktop/google-client.json'),JSON.stringify({installed:{client_id:'123-pageposter.apps.googleusercontent.com',client_secret:'public-desktop-registration',project_id:'owner-project'},access_token:'owner-private-token',refresh_token:'owner-private-refresh',email:'owner@example.com'}));
 createDesktopStage({...f,requireGoogleClient:true});const bundled=fs.readFileSync(path.join(f.stageRoot,'resources/app/desktop/google-client.json'),'utf8');
 assert.deepEqual(JSON.parse(bundled),{installed:{client_id:'123-pageposter.apps.googleusercontent.com',client_secret:'public-desktop-registration'}});assert.doesNotMatch(bundled,/owner-private|owner@example|owner-project/);
});

test('manifest detects a changed executable before distribution', t => {
  const f = fixture(t);
  const {createDesktopStage, verifyManifest, publishStage} = require('../scripts/build-desktop.cjs');
  createDesktopStage(f);
  fs.appendFileSync(path.join(f.stageRoot,'PagePoster.exe'), 'corrupt');
  assert.throws(() => verifyManifest(f.stageRoot), /checksum.*PagePoster\.exe/i);
  const outputRoot = path.join(f.root,'PagePoster Desktop');
  f.write(path.join(outputRoot,'PagePoster.exe'),'preserve');
  assert.throws(() => publishStage({...f,outputRoot,isRunning:()=>false}),/checksum/i);
  assert.equal(fs.readFileSync(path.join(outputRoot,'PagePoster.exe'),'utf8'),'preserve');
});

test('release identity distinguishes dirty source, runtime, dependency and lockfile bytes at the same version', t => {
  const f = fixture(t);
  const {createDesktopStage, verifyReleaseParity} = require('../scripts/build-desktop.cjs');
  const lock = path.join(f.sourceRoot,'desktop/runtime-pnpm-lock.yaml');
  f.write(lock,'runtime lock');
  f.write(path.join(f.sourceRoot,'desktop/production-pnpm-lock.yaml'),'production lock');
  f.write(path.join(f.sourceRoot,'desktop/production-package.json'),'{}');
  const stage = suffix => ({...f,stageRoot:path.join(f.buildRoot,'stage-'+suffix),nodeVersion:'24.15.0'});
  const first = stage('first');
  const read = options => {
    createDesktopStage(options);
    return JSON.parse(fs.readFileSync(path.join(options.stageRoot,'build-metadata.json'),'utf8'));
  };
  const original = read(first);
  assert.equal(read(stage('repeat')).buildId,original.buildId);
  assert.equal(verifyReleaseParity(first).buildId,original.buildId);
  for (const [index, file] of [path.join(f.sourceRoot,'dist/index.html'),f.nodeExecutable,path.join(f.productionModules,'dompurify/index.js'),lock].entries()) {
    const bytes=fs.readFileSync(file);
    fs.appendFileSync(file,' drift');
    assert.throws(()=>verifyReleaseParity(first),/parity/i);
    const changed=read(stage(index));
    assert.equal(changed.version,original.version);
    assert.notEqual(changed.buildId,original.buildId);
    fs.writeFileSync(file,bytes);
  }
});

test('manifest rejects an unlisted data file', t => {
  const f = fixture(t);
  const {createDesktopStage, verifyManifest} = require('../scripts/build-desktop.cjs');
  createDesktopStage(f);
  f.write(path.join(f.stageRoot,'resources/app/.pageposter/keys/key.dat'), 'secret');
  assert.throws(() => verifyManifest(f.stageRoot), /unexpected|unlisted|sensitive/i);
});

test('staging rejects linked dependencies rather than following paths outside the package', t => {
  const f = fixture(t);
  const linked = path.join(f.productionModules, 'linked');
  fs.mkdirSync(path.join(f.root,'outside'));
  fs.symlinkSync(path.join(f.root,'outside'),linked, process.platform==='win32'?'junction':'dir');
  const {createDesktopStage} = require('../scripts/build-desktop.cjs');
  assert.throws(() => createDesktopStage(f), /symbolic link|junction/i);
  assert.equal(fs.existsSync(path.join(f.root,'outside')),true);
});

test('cleanup refuses the build root itself and paths outside its boundary', t => {
  const f = fixture(t);
  fs.mkdirSync(f.buildRoot,{recursive:true});
  const {removeBuildPath} = require('../scripts/build-desktop.cjs');
  assert.throws(() => removeBuildPath(f.buildRoot,f.buildRoot),/outside|boundary/i);
  assert.throws(() => removeBuildPath(f.root,f.buildRoot),/outside|boundary/i);
  f.write(path.join(f.stageRoot,'temporary'));
  removeBuildPath(f.stageRoot,f.buildRoot);
  assert.equal(fs.existsSync(f.stageRoot),false);
  assert.equal(fs.existsSync(f.root),true);
});

test('publishing preserves previous output and refuses unverified or running replacement', t => {
  const f = fixture(t);
  const {createDesktopStage, publishStage} = require('../scripts/build-desktop.cjs');
  createDesktopStage(f);
  const outputRoot = path.join(f.root,'PagePoster Desktop');
  f.write(path.join(outputRoot,'PagePoster.exe'),'previous');
  assert.throws(() => publishStage({...f,outputRoot,isRunning:()=>true}),/close|stop/i);
  assert.equal(fs.readFileSync(path.join(outputRoot,'PagePoster.exe'),'utf8'),'previous');
  const backup = publishStage({...f,outputRoot,isRunning:()=>false});
  assert.equal(fs.readFileSync(path.join(outputRoot,'PagePoster.exe'),'utf8'),'electron binary');
  assert.equal(fs.readFileSync(path.join(backup,'PagePoster.exe'),'utf8'),'previous');
  assert.equal(fs.existsSync(f.stageRoot),false);
});

test('publishing refuses moving an output outside the workspace distribution folder', t => {
  const f = fixture(t);
  const {createDesktopStage, publishStage} = require('../scripts/build-desktop.cjs');
  createDesktopStage(f);
  const outputRoot = path.join(f.root,'outside','PagePoster Desktop');
  f.write(path.join(outputRoot,'PagePoster.exe'),'preserve');
  assert.throws(() => publishStage({...f,outputRoot,isRunning:()=>false}),/outside|workspace/i);
  assert.equal(fs.readFileSync(path.join(outputRoot,'PagePoster.exe'),'utf8'),'preserve');
});
