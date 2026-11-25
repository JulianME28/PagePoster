const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,INPUT,packages}=require('./wordpress-bootstrap-fixture.cjs');
test('only pinned Bridge 0.2.0 upgrades through native overwrite confirmation and reuses saved credentials',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture({installed:true});f.plugins.get('pageposter-bridge').version='0.2.0';
 const result=await createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady({...INPUT,savedCredential:{username:'editor',applicationPassword:'application fixture password'},checkpointState:{stage:'ready'}});
 assert.equal(result.state,'ready');assert.equal(f.created,0);assert.equal(f.calls.filter(c=>c.url.includes('update.php')).length,2);
 assert.deepEqual(f.checkpoints.map(c=>c.stage),['installing_plugins','ready']);assert.equal(f.plugins.get('pageposter-bridge').version,'0.2.1');
});
test('unrecognized Bridge versions cannot reach an upload or overwrite',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');for(const version of ['0.1.0','0.3.0']){const f=fixture({installed:true});f.plugins.get('pageposter-bridge').version=version;
 await assert.rejects(createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT),{code:'bootstrap_plugin_version'});assert.ok(!f.calls.some(c=>c.url.includes('update.php')));}
});
test('foreign or unsafe email reminder links stop before any privileged request',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 for(const link of ['https://evil.example/wp-login.php?remind_me_later=nonce12345','/blog/wp-login.php?remind_me_later=1','/blog/wp-login.php?remind_me_later=nonce12345&redirect_to=https://evil.example/','/blog/wp-login.php?remind_me_later=nonce12345&action=logout']){
  const f=fixture({installed:true}),transport=async(url,init)=>new URL(url).pathname.endsWith('wp-login.php')&&init.method==='POST'?{url,status:200,headers:{},text:'<form class="admin-email-confirm-form"><a href="'+link.replaceAll('&','&amp;')+'">Remind</a></form>'}:f.transport(url,init);
  await assert.rejects(createWordPressBootstrap({transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT),{code:'bootstrap_auth_failed'});assert.equal(f.calls.length,1);assert.equal(f.created,0);
 }
});
test('admin email reminder follows only the same-origin nonce link',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture({installed:true}),calls=[];
 const transport=async(url,init)=>{const u=new URL(url);calls.push({url,init});
  if(u.pathname.endsWith('wp-login.php')&&init.method==='POST')return{url,status:302,headers:{location:'/blog/wp-login.php?action=confirm_admin_email&redirect_to='+encodeURIComponent(INPUT.baseUrl+'wp-admin/')},text:''};
  if(u.searchParams.has('remind_me_later'))return{url,status:302,headers:{location:'/blog/wp-admin/','set-cookie':['wordpress_logged_in_fixture=session-fixture; Path=/blog/; Secure; HttpOnly']},text:''};
  if(u.searchParams.get('action')==='confirm_admin_email')return{url,status:200,headers:{},text:'<form class="admin-email-confirm-form"><a href="/blog/wp-login.php?remind_me_later=remindnonce&amp;redirect_to='+encodeURIComponent(INPUT.baseUrl+'wp-admin/')+'">Remind me later</a></form>'};
  return f.transport(url,init);
 };
 assert.equal((await createWordPressBootstrap({transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT)).state,'ready');
 assert.equal(calls.filter(c=>new URL(c.url).searchParams.has('remind_me_later')).length,1);
});
test('bootstrap logs in, uploads exact pinned ZIPs, activates, checkpoints one-time password and verifies Bridge',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture();
 const result=await createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT);
 assert.equal(result.state,'ready');assert.equal(result.applicationPassword,'application fixture password');assert.equal(result.username,'editor');assert.equal(result.plugins.length,2);assert.equal(f.created,1);
 assert.deepEqual(f.checkpoints.map(x=>x.stage),['installing_plugins','credential_pending','credential_created','ready']);assert.equal(f.checkpoints[2].credential.applicationPassword,result.applicationPassword);
 assert.equal(f.calls.filter(c=>c.url.includes('update.php')).length,2);assert.equal(f.calls.filter(c=>new URL(c.url).searchParams.get('action')==='activate').length,2);
});
test('restart with saved credential verifies readiness without new login, plugin upload, or password creation',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture({installed:true});
 const result=await createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady({...INPUT,savedCredential:{username:'editor',applicationPassword:'application fixture password'}});
 assert.equal(result.state,'ready');assert.equal(f.created,0);assert.ok(f.calls.every(c=>c.init.method==='GET'));assert.ok(!f.calls.some(c=>c.url.includes('wp-login')));
});
test('2FA, foreign login action, and filesystem credentials stop bootstrap without creating a credential',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 for(const [options,code] of [[{challenge:true},'bootstrap_2fa_required'],[{foreign:true},'bootstrap_origin_blocked'],[{filesystem:true},'bootstrap_filesystem_credentials']]){
  const f=fixture(options);await assert.rejects(createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT),e=>e.code===code&&e.state==='needs_attention'&&!e.message.includes(INPUT.password));assert.equal(f.created,0);
 }
});
test('tampered package is rejected before upload and installed incompatible versions are not overwritten',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture();
 await assert.rejects(createWordPressBootstrap({transport:f.transport,packages:[{...packages[0],bytes:Buffer.from('tampered')},packages[1]],checkpoint:f.checkpoint}).ensureReady(INPUT),{code:'bootstrap_package_invalid'});assert.equal(f.calls.length,0);
 for(const version of ['0.0.1','99.0.0']){const g=fixture({installed:true});g.plugins.get(packages[0].slug).version=version;await assert.rejects(createWordPressBootstrap({transport:g.transport,packages,checkpoint:g.checkpoint}).ensureReady(INPUT),{code:'bootstrap_plugin_version'});assert.equal(g.created,0);assert.ok(!g.calls.some(c=>c.url.includes('update.php')||new URL(c.url).searchParams.get('action')==='activate'));}
});
test('unknown password creation and failed durable checkpoint remain uncertain and do not issue another password',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 for(const options of [{lostCredential:true},{checkpointFail:true}]){const f=fixture({...options,installed:true});await assert.rejects(createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady(INPUT),e=>e.code==='bootstrap_credential_uncertain'&&e.state==='uncertain'&&!e.message.includes(INPUT.password));assert.equal(f.created,1);}
 const f=fixture({installed:true});await assert.rejects(createWordPressBootstrap({transport:f.transport,packages,checkpoint:f.checkpoint}).ensureReady({...INPUT,checkpointState:{stage:'credential_pending'}}),{code:'bootstrap_credential_uncertain'});assert.equal(f.created,0);
 const g=fixture({installed:true,existingPassword:true});await assert.rejects(createWordPressBootstrap({transport:g.transport,packages,checkpoint:g.checkpoint}).ensureReady(INPUT),{code:'bootstrap_credential_uncertain'});assert.equal(g.created,0);
});

test('default bootstrap uploads the actual approved Bridge 0.2.1 and Clean Links archives',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture();
 const result=await createWordPressBootstrap({transport:f.transport,checkpoint:f.checkpoint}).ensureReady(INPUT);
 assert.equal(result.plugins.find(p=>p.plugin==='pageposter-bridge/pageposter-bridge.php').version,'0.2.1');
 assert.equal(result.plugins.find(p=>p.plugin==='pageposter-bridge/pageposter-bridge.php').packageSha256,'a914558cb4a1943414a611c4eedb47f4ae6b261432656bbcb32a94cd8c5eeff0');
 assert.equal(result.plugins.find(p=>p.plugin==='pageposter-clean-links/pageposter-clean-links.php').packageSha256,'0d60dcad17b3db6f142b7c5a5745b00006425d4acc14ec3407c6ef34b05a0715');
});
test('CAPTCHA and unexpected redirect actions never issue another admin request',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 for(const [options,code]of [[{captcha:true},'bootstrap_captcha_required'],[{redirect:'https://foreign.example/admin'},'bootstrap_origin_blocked'],[{redirect:'/blog/wp-admin/plugins.php?action=delete&plugin=other%2Fother.php'},'bootstrap_origin_blocked']]){const f=fixture(options);await assert.rejects(createWordPressBootstrap({transport:f.transport,checkpoint:f.checkpoint}).ensureReady(INPUT),{code});assert.equal(f.calls.length,2);assert.equal(f.created,0);}
});
test('installed package drift fails readiness after saving the API credential; restart does not create another',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture({installed:true,badIntegrity:true});await assert.rejects(createWordPressBootstrap({transport:f.transport,checkpoint:f.checkpoint}).ensureReady(INPUT),{code:'bootstrap_bridge_not_ready'});assert.equal(f.checkpoints.at(-1).stage,'credential_created');const savedCredential=f.checkpoints.at(-1).credential;await assert.rejects(createWordPressBootstrap({transport:f.transport,checkpoint:f.checkpoint}).ensureReady({...INPUT,savedCredential}),{code:'bootstrap_bridge_not_ready'});assert.equal(f.created,1);
});
test('no durable checkpoint adapter means no login or remote mutation',async()=>{const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture();await assert.rejects(createWordPressBootstrap({transport:f.transport}).ensureReady(INPUT),{code:'bootstrap_checkpoint_required'});assert.equal(f.calls.length,0);});
test('only explicit rejected login before side effects permits alternate credentials',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');
 for(const [body,stage,eligible] of [['<div id="login_error">The password you entered for the username editor is incorrect.</div><form id="loginform"><input name="log"><input name="pwd"></form>','',true],['<div id="login_error">Too many attempts; try again later</div><form id="loginform"><input name="log"><input name="pwd"></form>','',false],['<form id="loginform"><input name="log"><input name="pwd"></form>','',false],['<div id="login_error">The password you entered for the username editor is incorrect.</div><form id="loginform"><input name="log"><input name="pwd"></form>','installing_plugins',false]]){
  const f=fixture(),transport=async(url,init)=>new URL(url).pathname.endsWith('/wp-login.php')&&init.method==='POST'?{url,status:200,headers:{},text:body}:f.transport(url,init);
  await assert.rejects(createWordPressBootstrap({transport,packages,checkpoint:f.checkpoint}).ensureReady({...INPUT,checkpointState:{stage}}),e=>e.code==='bootstrap_auth_failed'&&!!e.loginRejectedBeforeWrites===eligible);assert.equal(f.created,0);
 }
});
test('plugin mutation checkpoint is durable before first upload and failure prevents upload',async()=>{
 const {createWordPressBootstrap}=await import('../server/lifecycle/wordpress-bootstrap.mjs');const f=fixture();
 await assert.rejects(createWordPressBootstrap({transport:f.transport,packages,checkpoint:async value=>{if(value.stage==='installing_plugins')throw Error('unwritable');return f.checkpoint(value);}}).ensureReady(INPUT),{code:'bootstrap_checkpoint_required'});
 assert.ok(!f.calls.some(c=>c.url.includes('update.php')||new URL(c.url).searchParams.get('action')==='activate'));
});
