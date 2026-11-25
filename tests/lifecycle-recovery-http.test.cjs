const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {createLocalServer}=require('../server/local.cjs');
test('full recovery HTTP exports encrypted state and refuses restoring over existing work',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-recovery-http-')),s=await createLocalServer({env:{},lifecycle:{dataDir:dir,masterKey:Buffer.alloc(32,8).toString('base64')}});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>s.close(r));await s.closeResources();fs.rmSync(dir,{recursive:true,force:true});});const origin='http://127.0.0.1:'+s.address().port,q=async(route,body,headers={})=>{const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-PagePoster-Request':'1',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};const passphrase='a long backup password';await q('/api/lifecycle/projects',{name:'Private project'});assert.equal((await q('/api/recovery/export',{passphrase},{Origin:'https://other.test'})).status,403);const exported=await q('/api/recovery/export',{passphrase});assert.equal(exported.status,200,JSON.stringify(exported));assert.doesNotMatch(JSON.stringify(exported.body),/Private project/);const inspect=await q('/api/recovery/inspect',{passphrase,backup:exported.body});assert.equal(inspect.body.summary.projects,1);assert.equal(inspect.body.canRestore,false);const restored=await q('/api/recovery/restore',{passphrase,backup:exported.body,confirmed:true});assert.equal(restored.status,409);assert.equal((await fetch(origin+'/api/lifecycle/projects')).status,200);});
test('recovery rejects an oversized declared request before buffering its body and explains both limits',async t=>{
 const http=require('node:http'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-recovery-size-')),server=await createLocalServer({env:{},lifecycle:{dataDir:dir,masterKey:Buffer.alloc(32,8).toString('base64')}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeResources();fs.rmSync(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 const result=await new Promise(resolve=>{const request=http.request(origin+'/api/recovery/inspect',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-PagePoster-Request':'1','Content-Length':151*1024*1024+1}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>{clearTimeout(timer);resolve({status:response.statusCode,body:JSON.parse(body)});request.destroy();});});request.on('error',()=>{});const timer=setTimeout(()=>{request.destroy();resolve(null);},1500);request.write('{}');});
 assert.equal(result?.status,400);assert.equal(result.body.code,'BACKUP_TOO_LARGE');assert.match(result.body.error,/512.*150/);assert.doesNotMatch(result.body.error,/Зменш.*скриншот/);
});

for (const failure of ['closing resources', 'swapping the restored directory']) {
 test(`recovery requires a restart when ${failure} fails`, async t => {
  const temporary = path.resolve(os.tmpdir());
  const parent = fs.mkdtempSync(path.join(temporary, 'pp-recovery-fault-'));
  const shutdowns = [];
  t.after(async () => {
   for (const shutdown of shutdowns) await shutdown();
   assert.equal(path.dirname(parent), temporary);
   assert.match(path.basename(parent), /^pp-recovery-fault-/);
   fs.rmSync(parent, { recursive: true, force: true });
  });
  async function runtime(name) {
   const dataDir = path.join(parent, name);
   fs.mkdirSync(dataDir);
   const server = await createLocalServer({ env: {}, lifecycle: { dataDir, masterKey: Buffer.alloc(32, 8).toString('base64') } });
   await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
   const closeResources = server.closeResources.bind(server);
   shutdowns.push(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await closeResources();
   });
   const origin = 'http://127.0.0.1:' + server.address().port;
   const post = (action, body) => fetch(origin + '/api/recovery/' + action, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-PagePoster-Request': '1' },
    body: JSON.stringify(body)
   });
   return { dataDir, server, origin, post };
  }

  const donor = await runtime('donor');
  donor.server.lifecycle.store.createProject({ name: 'Проєкт у копії' });
  const passphrase = 'backup fixture password';
  const exported = await donor.post('export', { passphrase });
  assert.equal(exported.status, 200);
  const backup = await exported.json();
  const target = await runtime('target');
  const original = path.join(target.dataDir, 'before-restore.txt');
  fs.writeFileSync(original, 'existing target data');
  const inspect = await target.post('inspect', { backup, passphrase });
  assert.equal((await inspect.json()).canRestore, true);

  const fail = () => Object.assign(Error('Synthetic restore fault'), { code: 'EIO' });
  let faultTriggered = false;
  let undoFault;
  if (failure === 'closing resources') {
   const closeResources = target.server.closeResources.bind(target.server);
   const mock = t.mock.method(target.server, 'closeResources', async () => {
    await closeResources();
    faultTriggered = true;
    throw fail();
   });
   undoFault = () => mock.mock.restore();
  } else {
   const fsPromises = require('node:fs/promises');
   const { syncBuiltinESMExports } = require('node:module');
   const rename = fsPromises.rename;
   const mock = t.mock.method(fsPromises, 'rename', async (source, destination) => {
    if (destination === target.dataDir && path.basename(source).startsWith('.pageposter-restore-')) {
     faultTriggered = true;
     throw fail();
    }
    return rename(source, destination);
   });
   syncBuiltinESMExports();
   undoFault = () => { mock.mock.restore(); syncBuiltinESMExports(); };
  }

  let response;
  try {
   response = await target.post('restore', { backup, passphrase, confirmed: true });
  } finally {
   undoFault();
  }
  assert.ok(faultTriggered);
  assert.equal(fs.readFileSync(original, 'utf8'), 'existing target data');
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.restored, false);
  assert.equal(result.restartRequired, true);
  assert.equal(result.code, 'RECOVERY_RESTART_REQUIRED');
  assert.match(result.error, /перезапустіть PagePoster/i);
  for (const blocked of [await target.post('inspect', { backup, passphrase }), await fetch(target.origin + '/api/lifecycle/projects')]) {
   assert.equal(blocked.status, 503);
   const body = await blocked.json();
   assert.equal(body.restartRequired, true);
   assert.doesNotMatch(body.error, /відновлення завершено/i);
  }
 });
}
