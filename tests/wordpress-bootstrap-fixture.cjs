const test=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const INPUT={baseUrl:'https://wp.example/blog/',username:'editor',password:'admin-fixture-secret',operationId:'12345678-1234-4234-8234-123456789abc'};
const packageDefs=[['pageposter-clean-links','1.1.1'],['pageposter-bridge','0.2.1']];
const packages=packageDefs.map(([slug,version])=>{const bytes=require('node:fs').readFileSync(require('node:path').join(__dirname,'..',slug==='pageposter-bridge'?'wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip':'assets/pageposter-clean-links-1.1.1.zip'));return{slug,version,plugin:slug+'/'+slug+'.php',filename:slug+'.zip',bytes,sha256:createHash('sha256').update(bytes).digest('hex')};});
function fixture(options={}){
 const calls=[],checkpoints=[],plugins=new Map(options.installed?packages.map(p=>[p.slug,{version:p.version,status:'active'}]):[]);let created=0;
 const json=(url,value,status=200)=>({url,status,headers:{'content-type':'application/json'},text:JSON.stringify(value)});
 const html=(url,text,status=200,headers={})=>({url,status,headers:{'content-type':'text/html',...headers},text});
 const transport=async(url,init={})=>{
  const u=new URL(url),method=init.method||'GET';calls.push({url,init});assert.equal(u.origin,'https://wp.example');assert.equal(init.followRedirects,false);
  if(u.pathname==='/blog/wp-login.php'){
   if(method==='GET')return html(url,'<form id="loginform" method="post" action="'+(options.foreign?'https://evil.example/wp-login.php':'/blog/wp-login.php')+'"><input name="log"><input name="pwd" type="password"></form>',200,{'set-cookie':['wordpress_test_cookie=WP+Cookie+check; Path=/blog/; Secure']});
   const form=new URLSearchParams(init.body);assert.equal(form.get('log'),'editor');assert.equal(form.get('pwd'),INPUT.password);assert.match(init.headers.cookie,/wordpress_test_cookie=/);
   if(options.challenge)return html(url,'<form><input name="two_factor_code"></form>');
   if(options.captcha)return html(url,'<div class="g-recaptcha"></div>');
   return html(url,'',302,{location:options.redirect||'/blog/wp-admin/','set-cookie':['wordpress_logged_in_fixture=session-fixture; Path=/blog/; Secure; HttpOnly']});
  }
  if(u.pathname==='/blog/wp-admin/')return html(url,'<html><body class="wp-admin">Admin</body></html>');
  const basic=init.headers?.authorization?.startsWith('Basic ');
  if(!basic)assert.match(init.headers?.cookie||'',/wordpress_logged_in_fixture=/);
  else{assert.equal(init.headers.cookie,undefined);assert.ok(!init.headers.authorization.includes(INPUT.password));}
  if(u.pathname==='/blog/wp-admin/admin-ajax.php'){assert.equal(u.searchParams.get('action'),'rest-nonce');return html(url,'nonce12345');}
  if(u.pathname==='/blog/wp-json/')return json(url,{namespaces:['wp/v2','pageposter/v1']});
  if(u.pathname==='/blog/wp-json/wp/v2/users/me'){if(!basic)assert.equal(init.headers['x-wp-nonce'],'nonce12345');return json(url,{id:7,slug:'editor',capabilities:{read:true,edit_pages:true,publish_pages:true,unfiltered_html:true,install_plugins:true,update_plugins:true,activate_plugins:true}});}
  if(u.pathname==='/blog/wp-json/wp/v2/plugins')return json(url,[...plugins].map(([slug,state])=>({plugin:slug+'/'+slug,version:state.version,status:state.status})));
  if(u.pathname==='/blog/wp-admin/plugin-install.php')return html(url,'<form method="post" enctype="multipart/form-data" action="update.php?action=upload-plugin"><input name="_wpnonce" value="uploadnonce"><input type="file" name="pluginzip"></form>');
  if(u.pathname==='/blog/wp-admin/update.php'){
   if(method==='GET'&&u.searchParams.get('overwrite')==='update-plugin'){assert.equal(u.searchParams.get('package'),'42');assert.equal(u.searchParams.get('_wpnonce'),'overwritenonce');plugins.set('pageposter-bridge',{version:'0.2.1',status:'active'});return html(url,'<h2>Updated</h2>');}
   assert.equal(method,'POST');assert.ok(Buffer.isBuffer(init.body));assert.match(init.headers['content-type'],/^multipart\/form-data; boundary=/);assert.ok(init.body.includes(Buffer.from('uploadnonce')));
   const pkg=packages.find(p=>init.body.includes(p.bytes));assert.ok(pkg,'exact ZIP bytes are uploaded');
   if(options.filesystem)return html(url,'<form><input name="hostname"><input name="connection_type"></form>');
   if(plugins.get(pkg.slug)?.version==='0.2.0')return html(url,'<a class="update-from-upload-overwrite" href="update.php?action=upload-plugin&amp;package=42&amp;overwrite=update-plugin&amp;_wpnonce=overwritenonce">Replace current with uploaded</a>');
   plugins.set(pkg.slug,{version:pkg.version,status:'inactive'});return html(url,'<h2>Installed</h2>');
  }
  if(u.pathname==='/blog/wp-admin/plugins.php'){
   if(u.searchParams.get('action')==='activate'){const p=packages.find(p=>p.plugin===u.searchParams.get('plugin'));assert.ok(p);assert.equal(u.searchParams.get('_wpnonce'),'activationnonce');plugins.get(p.slug).status='active';return html(url,'',302,{location:'/blog/wp-admin/plugins.php?activate=true'});}
   return html(url,packages.filter(p=>plugins.has(p.slug)).map(p=>'<tr data-plugin="'+p.plugin+'"><td><a href="plugins.php?action=activate&amp;plugin='+encodeURIComponent(p.plugin)+'&amp;_wpnonce=activationnonce">Activate</a></td></tr>').join(''));
  }
  if(u.pathname==='/blog/wp-json/wp/v2/users/7/application-passwords'){
   if(method==='GET')return json(url,options.existingPassword?[{app_id:INPUT.operationId,name:'PagePoster '+INPUT.operationId}]:[]);
   created++;const body=JSON.parse(init.body);assert.equal(body.app_id,INPUT.operationId);assert.equal(body.name,'PagePoster '+INPUT.operationId);assert.equal(checkpoints.at(-1).stage,'credential_pending');
   if(options.lostCredential)throw Error('response lost admin-fixture-secret');
   return json(url,{uuid:'87654321-1234-4234-8234-123456789abc',password:'application fixture password'},201);
  }
  if(u.pathname==='/blog/wp-json/pageposter/v1/status'){assert.equal(basic,true);return json(url,{version:'0.2.1',schemaVersion:1,ready:true,cleanLinksActive:true,cleanLinksVersion:'1.1.1',cleanLinksFeatures:['contact-schemes','exact-wrapper-boundary'],packageIntegrity:options.badIntegrity?{algorithm:'sha256',bridge:{},cleanLinks:{}}:require('../server/lifecycle/plugin-integrity.cjs').expectedPackageIntegrity(),capabilities:{create:true,update:true,atomicCas:true,idempotentCreate:true}});}
  throw Error('Unexpected fixture route '+u.pathname);
 };
 return{transport,calls,checkpoints,plugins,get created(){return created;},checkpoint:async value=>{checkpoints.push(value);if(options.checkpointFail&&value.stage==='credential_created')throw Error('disk failure secret');}};
}

module.exports={fixture,INPUT,packages};
