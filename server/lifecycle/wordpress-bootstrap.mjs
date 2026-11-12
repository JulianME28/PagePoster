// Server-only bootstrap for an explicitly selected WordPress site. Uses normal
// wp-admin cookies/nonces; never executes remote scripts or accepts arbitrary ZIPs.
import pluginIntegrity from './plugin-integrity.cjs';
import {createHash,randomUUID} from 'node:crypto';
import {JSDOM} from './dom-runtime.mjs';
import {createSafeTransport,validatePublicUrl} from './network.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BUNDLES=pluginIntegrity.BUNDLED_PLUGIN_PACKAGES;
const messages={bootstrap_validation:'Перевір адресу й реквізити WordPress.',bootstrap_origin_blocked:'WordPress запропонував неочікувану адресу для адміністративної дії.',bootstrap_auth_failed:'WordPress не підтвердив адміністративний вхід.',bootstrap_2fa_required:'Потрібне ручне підтвердження двофакторного входу WordPress.',bootstrap_captcha_required:'WordPress вимагає CAPTCHA або перевірку браузера.',bootstrap_filesystem_credentials:'Хостинг вимагає окремі доступи до файлової системи для встановлення плагінів.',bootstrap_permission_denied:'Обліковий запис не має потрібних прав WordPress.',bootstrap_package_invalid:'Пакет PagePoster не відповідає перевіреній версії та SHA-256.',bootstrap_plugin_version:'На сайті інша версія плагіна PagePoster; потрібна перевірка сумісності.',bootstrap_plugin_missing:'Не вдалося підтвердити встановлення й активацію плагіна PagePoster.',bootstrap_protocol_unavailable:'WordPress не надав потрібні адміністративні форми або REST API.',bootstrap_application_password_unavailable:'WordPress не дозволив створити пароль застосунку.',bootstrap_credential_uncertain:'Одноразовий пароль застосунку міг бути створений; потрібна звірка збереженого доступу.',bootstrap_checkpoint_required:'Потрібне захищене збереження одноразового пароля до продовження.',bootstrap_bridge_not_ready:'PagePoster Bridge не підтвердив готовність і атомарні записи.',bootstrap_network_failed:'WordPress не відповів під час підключення.',bootstrap_timeout:'Вичерпано час підключення WordPress.',bootstrap_busy:'Для цього сайту вже виконується підключення.'};
export class BootstrapError extends Error{constructor(code,{uncertain=false}={}){super(messages[code]||messages.bootstrap_protocol_unavailable);this.name='BootstrapError';this.code=code;this.state=uncertain?'uncertain':'needs_attention';this.uncertain=uncertain;}}
const fail=(code,uncertain=false)=>{throw new BootstrapError(code,{uncertain});};
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const header=(reply,name)=>Object.entries(reply.headers||{}).find(([key])=>key.toLowerCase()===name)?.[1];
function parse(reply){try{return JSON.parse(reply.text);}catch{fail('bootstrap_protocol_unavailable');}}
function document(html,callback){const dom=new JSDOM(html);try{return callback(dom.window.document);}finally{dom.window.close();}}
function guard(html,{filesystem=false}={}){
 if(typeof html!=='string'||!html.includes('<'))return;
 document(html,d=>{
  if(d.querySelector('input[name*="two_factor" i],input[name*="twofactor" i],input[name*="totp" i],input[name="authcode" i],input[name*="otp" i],input[name="verification_code" i]'))fail('bootstrap_2fa_required');
  if(d.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name*="captcha" i],textarea[name*="captcha" i],#challenge-running,#challenge-form'))fail('bootstrap_captcha_required');
  if(filesystem&&d.querySelector('input[name="hostname"],input[name="connection_type"]'))fail('bootstrap_filesystem_credentials');
 });
}
function credentials(value){return object(value)&&typeof value.username==='string'&&value.username.length>0&&value.username.length<=256&&!/[:\r\n\0]/.test(value.username)&&typeof value.applicationPassword==='string'&&value.applicationPassword.length>0&&value.applicationPassword.length<=1024&&!/[\r\n\0]/.test(value.applicationPassword);}
async function packagesFor(injected){
 let items;try{items=injected||pluginIntegrity.getBundledPluginPackages();}catch{fail('bootstrap_package_invalid');}
 if(!Array.isArray(items)||items.length!==BUNDLES.length)fail('bootstrap_package_invalid');
 return BUNDLES.map(allowed=>{
  const item=items.find(p=>p.slug===allowed.slug);
  if(!item||item.version!==allowed.version||item.plugin!==allowed.plugin||!Buffer.isBuffer(item.bytes)||item.bytes.length<4||item.bytes.length>1500000||item.bytes.readUInt32LE(0)!==0x04034b50||! /^[a-f0-9]{64}$/.test(item.sha256)||createHash('sha256').update(item.bytes).digest('hex')!==item.sha256||! /^[a-z0-9.-]+\.zip$/.test(item.filename))fail('bootstrap_package_invalid');
  // The override is a trusted dependency for fixtures only; no request field selects bytes or hashes.
  return {...item};
 });
}
function multipart(pkg,nonce){
 const boundary='PagePoster'+randomUUID().replaceAll('-','');
 const field=(name,value)=>Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+value+'\r\n');
 const body=Buffer.concat([field('_wpnonce',nonce),field('install-plugin-submit','Install Now'),Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="pluginzip"; filename="'+pkg.filename+'"\r\nContent-Type: application/zip\r\n\r\n'),pkg.bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 return {body,type:'multipart/form-data; boundary='+boundary};
}
function apiUrl(root,route,params={}){const url=new URL(root);if(url.searchParams.has('rest_route'))url.searchParams.set('rest_route',route);else url.pathname=url.pathname.replace(/\/?$/,'/')+route.replace(/^\//,'');for(const[key,value]of Object.entries(params))url.searchParams.set(key,value);return url.href;}
/** checkpoint receives {operationId,stage,credential?}; it must durably encrypt
 * credential before resolving. Never expose checkpoint payloads in UI/events. */
export function createWordPressBootstrap({transport=createSafeTransport({allowWrites:true,maxBytes:2*1024*1024}),packages,checkpoint,timeoutMs=120000}={}){
 const active=new Set();
 async function execute(input,base){
  const bundles=await packagesFor(packages),cookieJar=new Map();let requestCount=0;
  const deadline=Date.now()+Math.min(Math.max(timeoutMs,1000),180000);
  const same=value=>{let url;try{url=validatePublicUrl(String(value));}catch{fail('bootstrap_origin_blocked');}if(url.origin!==base.origin)fail('bootstrap_origin_blocked');return url;};
  const address=relative=>new URL(relative,base).href;
  const stage=async(stage,credential)=>{if(typeof checkpoint!=='function')fail('bootstrap_checkpoint_required');try{await checkpoint({operationId:input.operationId,stage,...(credential?{credential}:{})});}catch(error){if(stage==='credential_created')fail('bootstrap_credential_uncertain',true);if(error instanceof BootstrapError)throw error;fail('bootstrap_checkpoint_required');}};
  function acceptCookies(reply,url){
   let values=header(reply,'set-cookie');if(!values)return;if(!Array.isArray(values))values=[values];if(values.length>50)fail('bootstrap_protocol_unavailable');
   for(const entry of values){if(typeof entry!=='string'||entry.length>8192||/[\r\n]/.test(entry))fail('bootstrap_protocol_unavailable');const parts=entry.split(';'),pair=parts.shift(),equals=pair.indexOf('=');if(equals<1)continue;const name=pair.slice(0,equals).trim(),value=pair.slice(equals+1).trim();if(! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))continue;
    const attrs=new Map(parts.map(part=>{const i=part.indexOf('=');return i<0?[part.trim().toLowerCase(),'']:[part.slice(0,i).trim().toLowerCase(),part.slice(i+1).trim()];}));const domain=(attrs.get('domain')||url.hostname).toLowerCase().replace(/^\./,'');if(domain!==url.hostname&&!url.hostname.endsWith('.'+domain))continue;
    const path=attrs.get('path')?.startsWith('/')?attrs.get('path'):url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)||'/';const key=name+'\0'+path;
    const expired=attrs.has('max-age')?Number(attrs.get('max-age'))<=0:attrs.has('expires')&&Date.parse(attrs.get('expires'))<=Date.now();if(expired){cookieJar.delete(key);continue;}cookieJar.set(key,{name,value,path});if(cookieJar.size>50)fail('bootstrap_protocol_unavailable');
   }
  }
  async function request(value,options={}){
   const url=same(value);if(++requestCount>80||Date.now()>=deadline)fail('bootstrap_timeout');
   const headers={accept:'text/html,application/json',...(options.headers||{})};
   if(!headers.authorization){const cookie=[...cookieJar.values()].filter(c=>url.pathname===c.path||url.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/')).sort((a,b)=>b.path.length-a.path.length).map(c=>c.name+'='+c.value).join('; ');if(cookie)headers.cookie=cookie;}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));let reply;
   try{reply=await transport(url.href,{...options,method:options.method||'GET',headers,followRedirects:false,signal:controller.signal});}catch(error){if(error instanceof BootstrapError||/^BROWSER_[A-Z_]+$/.test(error?.code||''))throw error;fail(controller.signal.aborted?'bootstrap_timeout':'bootstrap_network_failed');}finally{clearTimeout(timer);}
   if(!reply||!Number.isInteger(reply.status)||typeof reply.text!=='string'||Buffer.byteLength(reply.text)>2*1024*1024)fail('bootstrap_protocol_unavailable');same(reply.url||url.href);if(reply.url&&new URL(reply.url).href!==url.href)fail('bootstrap_origin_blocked');
   acceptCookies(reply,url);return{...reply,url:url.href};
  }
  async function visit(value,options={}){
   let reply=await request(value,options);
   for(let count=0;[301,302,303,307,308].includes(reply.status);count++){
    if(count>=5)fail('bootstrap_protocol_unavailable');if((options.method||'GET')!=='GET'&&[307,308].includes(reply.status))fail('bootstrap_protocol_unavailable');
    const location=header(reply,'location');if(typeof location!=='string')fail('bootstrap_protocol_unavailable');const next=same(new URL(location,reply.url));
    // Redirects may reach only normal read-only admin pages, never a new action.
    const readPaths=['wp-admin/','wp-admin/index.php','wp-admin/plugins.php','wp-admin/plugin-install.php','wp-login.php'].map(path=>new URL(address(path)).pathname);
    const emailConfirmation=next.pathname===new URL(address('wp-login.php')).pathname&&next.searchParams.get('action')==='confirm_admin_email'&&[...next.searchParams.keys()].every(key=>['action','redirect_to','wp_lang'].includes(key));
    if(emailConfirmation&&next.searchParams.has('redirect_to')){const redirect=same(next.searchParams.get('redirect_to'));if(!['wp-admin/','wp-admin/index.php'].map(path=>new URL(address(path)).pathname).includes(redirect.pathname)||redirect.search||redirect.hash)fail('bootstrap_origin_blocked');}
    if(!readPaths.includes(next.pathname)||(next.searchParams.has('action')&&!emailConfirmation)||next.searchParams.has('action2'))fail('bootstrap_origin_blocked');
    reply=await request(next.href);options={};
   }
   guard(reply.text);return reply;
  }
  async function discover(headers={},html=''){
   const advertised=document(html,d=>[...d.querySelectorAll('link[rel][href]')].filter(n=>n.getAttribute('rel').split(/\s+/).includes('https://api.w.org/')).map(n=>n.getAttribute('href')));
   for(const candidate of [...advertised,address('wp-json/'),address('?rest_route=/')].slice(0,10)){
    let url;try{url=same(new URL(candidate,base));}catch{continue;}
    const reply=await request(url.href,{headers});if(reply.status!==200)continue;let data;try{data=JSON.parse(reply.text);}catch{continue;}
    if(object(data)&&Array.isArray(data.namespaces)&&data.namespaces.includes('wp/v2'))return url.href;
   }
   fail('bootstrap_protocol_unavailable');
  }
  async function jsonRequest(root,route,{method='GET',body,headers={},params={}}={}){
   const reply=await request(apiUrl(root,route,params),{method,headers:{...headers,accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(reply.status===401||reply.status===403)fail('bootstrap_permission_denied');if(reply.status<200||reply.status>=300){guard(reply.text);fail('bootstrap_protocol_unavailable');}return parse(reply);
  }
  function inspectPlugins(list,{requireActive=false}={}){
   if(!Array.isArray(list))fail('bootstrap_protocol_unavailable');return bundles.map(pkg=>{
    const entry=list.find(item=>item?.plugin?.replace(/\.php$/,'')===pkg.plugin.replace(/\.php$/,''));
    const upgrade=entry&&pkg.slug==='pageposter-bridge'&&entry.version==='0.2.0'&&pkg.version==='0.2.1';
    if(entry&&entry.version!==pkg.version&&(!upgrade||requireActive))fail('bootstrap_plugin_version');
    if(requireActive&&entry?.status!=='active')fail('bootstrap_plugin_missing');return{pkg,entry};
   });
  }
  async function verifyCredential(credential,knownRoot){
   if(!credentials(credential))fail('bootstrap_validation');const headers={authorization:'Basic '+Buffer.from(credential.username+':'+credential.applicationPassword).toString('base64')};const root=knownRoot||await discover(headers);
   const user=await jsonRequest(root,'/wp/v2/users/me',{headers,params:{context:'edit'}});if(!Number.isSafeInteger(user?.id)||user.id<1)fail('bootstrap_auth_failed');
   const installed=inspectPlugins(await jsonRequest(root,'/wp/v2/plugins',{headers,params:{context:'edit'}}),{requireActive:true});
   const ready=await jsonRequest(root,'/pageposter/v1/status',{headers});
   if(ready?.ready!==true||ready.schemaVersion!==1||ready.version!==bundles.find(p=>p.slug==='pageposter-bridge').version||ready.cleanLinksActive!==true||ready.cleanLinksVersion!==bundles.find(p=>p.slug==='pageposter-clean-links').version||!['contact-schemes','exact-wrapper-boundary'].every(feature=>ready.cleanLinksFeatures?.includes(feature))||!pluginIntegrity.verifyPackageIntegrity(ready.packageIntegrity).verified||!['create','update','atomicCas','idempotentCreate'].every(k=>ready.capabilities?.[k]===true))fail('bootstrap_bridge_not_ready');
   return{state:'ready',...credential,apiRoot:root,wpUserId:user.id,capabilities:user.capabilities||{},plugins:installed.map(({pkg})=>({plugin:pkg.plugin,version:pkg.version,status:'active',packageSha256:pkg.sha256}))};
  }
  if(input.savedCredential){try{const result=await verifyCredential(input.savedCredential);if(checkpoint)await stage('ready');return result;}catch(error){if(error.code!=='bootstrap_plugin_version')throw error;}}
  if(!input.savedCredential&&['credential_pending','credential_created','ready'].includes(input.checkpointState?.stage))fail('bootstrap_credential_uncertain',true);
  if(typeof checkpoint!=='function')fail('bootstrap_checkpoint_required');
  const login=await visit(address('wp-login.php'));
  if(login.status!==200)fail('bootstrap_auth_failed');
  const action=document(login.text,d=>{const form=d.querySelector('form#loginform')||[...d.forms].find(f=>f.querySelector('input[name="log"]')&&f.querySelector('input[name="pwd"]'));if(!form)fail('bootstrap_protocol_unavailable');return form.getAttribute('action')||login.url;});
  const loginUrl=same(new URL(action,login.url));if(loginUrl.pathname!==new URL(address('wp-login.php')).pathname)fail('bootstrap_origin_blocked');
  let signedIn=await visit(loginUrl.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({log:input.username,pwd:input.password,'wp-submit':'Log In',redirect_to:address('wp-admin/'),testcookie:'1'}).toString()});
  if(document(signedIn.text,d=>!!d.querySelector('form.admin-email-confirm-form,#admin-email-confirm-form'))){
   const href=document(signedIn.text,d=>[...d.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).find(value=>{try{const link=same(new URL(value,signedIn.url));if(link.pathname!==loginUrl.pathname||! /^[A-Za-z0-9_-]{5,100}$/.test(link.searchParams.get('remind_me_later')||'')||[...link.searchParams.keys()].some(key=>!['action','remind_me_later','redirect_to','wp_lang'].includes(key))||(link.searchParams.has('action')&&link.searchParams.get('action')!=='confirm_admin_email'))return false;if(link.searchParams.has('redirect_to')){const target=same(link.searchParams.get('redirect_to'));if(!['wp-admin/','wp-admin/index.php'].map(path=>new URL(address(path)).pathname).includes(target.pathname)||target.search||target.hash)return false;}return !link.hash;}catch{return false;}}));
   if(!href)fail('bootstrap_auth_failed');signedIn=await visit(same(new URL(href,signedIn.url)).href);
   if(document(signedIn.text,d=>!!d.querySelector('form.admin-email-confirm-form,#admin-email-confirm-form')))fail('bootstrap_auth_failed');
  }
  if(signedIn.status!==200||document(signedIn.text,d=>!!d.querySelector('#login_error,form#loginform'))){
   // A login form alone also appears on challenges or expired sessions. Only an
   // explicit credential rejection can authorize switching to the second pair.
   const rejected=signedIn.status===200&&document(signedIn.text,d=>{const form=d.querySelector('form#loginform'),message=d.querySelector('#login_error')?.textContent||'';return !!form?.querySelector('[name="log"]')&&!!form.querySelector('[name="pwd"]')&&/(?:the password you entered for (?:the )?(?:username|email address)[\s\S]{1,400} is incorrect|unknown (?:username|email address)|invalid username|incorrect password)/i.test(message);});
   const error=new BootstrapError('bootstrap_auth_failed');if(rejected&&!input.checkpointState?.stage)error.loginRejectedBeforeWrites=true;throw error;
  }
  const nonceReply=await request(address('wp-admin/admin-ajax.php?action=rest-nonce'));guard(nonceReply.text);const nonce=nonceReply.text.trim();if(nonceReply.status!==200||! /^[A-Za-z0-9_-]{10,100}$/.test(nonce))fail('bootstrap_auth_failed');
  const root=await discover({},signedIn.text),headers={'x-wp-nonce':nonce};
  const user=await jsonRequest(root,'/wp/v2/users/me',{headers,params:{context:'edit'}});
  if(!Number.isSafeInteger(user?.id)||user.id<1)fail('bootstrap_auth_failed');
  if(user.capabilities?.unfiltered_html!==true||!(user.capabilities.edit_pages||user.capabilities.edit_posts))fail('bootstrap_permission_denied');
  let listing=await jsonRequest(root,'/wp/v2/plugins',{headers,params:{context:'edit'}}),mutationCheckpoint=false;
  const beforePluginWrite=async()=>{if(!mutationCheckpoint){await stage('installing_plugins');mutationCheckpoint=true;}};
  for(const {pkg,entry}of inspectPlugins(listing)){
   let current=entry;
   const upgrading=current?.version==='0.2.0'&&pkg.slug==='pageposter-bridge';
   if(!current||upgrading){
    // upload_plugins is a meta capability; WP's upload form applies its dynamic checks.
    if(user.capabilities.install_plugins!==true||(upgrading&&user.capabilities.update_plugins!==true))fail('bootstrap_permission_denied');
    const formReply=await visit(address('wp-admin/plugin-install.php?tab=upload'));if(formReply.status!==200)fail('bootstrap_permission_denied');
    const upload=document(formReply.text,d=>{const file=d.querySelector('input[type="file"][name="pluginzip"]'),form=file?.closest('form'),nonce=form?.querySelector('input[name="_wpnonce"]')?.getAttribute('value');if(!form||!nonce||! /^[A-Za-z0-9_-]{5,100}$/.test(nonce))fail('bootstrap_protocol_unavailable');return{action:form.getAttribute('action'),nonce};});
    const destination=same(new URL(upload.action,formReply.url));if(destination.pathname!==new URL(address('wp-admin/update.php')).pathname||destination.searchParams.get('action')!=='upload-plugin')fail('bootstrap_origin_blocked');
    await beforePluginWrite();const payload=multipart(pkg,upload.nonce);const installed=await visit(destination.href,{method:'POST',headers:{'content-type':payload.type},body:payload.body});guard(installed.text,{filesystem:true});if(installed.status!==200)fail('bootstrap_plugin_missing');
    if(upgrading){
     const href=document(installed.text,d=>d.querySelector('a.update-from-upload-overwrite[href]')?.getAttribute('href'));if(!href)fail('bootstrap_plugin_missing');
     const replace=same(new URL(href,installed.url));
     if(replace.pathname!==destination.pathname||replace.searchParams.get('action')!=='upload-plugin'||replace.searchParams.get('overwrite')!=='update-plugin'||! /^[A-Za-z0-9_-]{5,100}$/.test(replace.searchParams.get('_wpnonce')||'')||! /^[1-9][0-9]*$/.test(replace.searchParams.get('package')||'')||replace.hash||[...replace.searchParams.keys()].some(key=>!['action','overwrite','_wpnonce','package'].includes(key)))fail('bootstrap_origin_blocked');
     const replaced=await visit(replace.href);guard(replaced.text,{filesystem:true});if(replaced.status!==200)fail('bootstrap_plugin_missing');
    }
    listing=await jsonRequest(root,'/wp/v2/plugins',{headers,params:{context:'edit'}});current=inspectPlugins(listing).find(x=>x.pkg.slug===pkg.slug).entry;if(!current)fail('bootstrap_plugin_missing');
    if(current.version!==pkg.version)fail('bootstrap_plugin_version');
   }
   if(current.status!=='active'){
    if(user.capabilities.activate_plugins!==true)fail('bootstrap_permission_denied');const page=await visit(address('wp-admin/plugins.php'));
    const href=document(page.text,d=>[...d.querySelectorAll('a[href]')].map(n=>n.getAttribute('href')).find(value=>{try{const link=new URL(value,page.url);return link.pathname===new URL(address('wp-admin/plugins.php')).pathname&&link.searchParams.get('action')==='activate'&&link.searchParams.get('plugin')===pkg.plugin&&/^[A-Za-z0-9_-]{5,100}$/.test(link.searchParams.get('_wpnonce')||'');}catch{return false;}}));
    if(!href)fail('bootstrap_permission_denied');await beforePluginWrite();await visit(same(new URL(href,page.url)).href);
    listing=await jsonRequest(root,'/wp/v2/plugins',{headers,params:{context:'edit'}});const active=inspectPlugins(listing).find(x=>x.pkg.slug===pkg.slug).entry;if(active?.status!=='active')fail('bootstrap_plugin_missing');
   }
  }
  if(input.savedCredential){const result=await verifyCredential(input.savedCredential,root);await stage('ready');return result;}
  const passwordRoute='/wp/v2/users/'+user.id+'/application-passwords';
  const previous=await jsonRequest(root,passwordRoute,{headers});if(!Array.isArray(previous))fail('bootstrap_application_password_unavailable');
  const name='PagePoster '+input.operationId;
  if(previous.some(p=>p?.app_id===input.operationId||p?.name===name))fail('bootstrap_credential_uncertain',true);
  await stage('credential_pending');let created;
  try{created=await jsonRequest(root,passwordRoute,{method:'POST',headers,body:{name,app_id:input.operationId}});}catch{fail('bootstrap_credential_uncertain',true);}
  const credential={username:input.username,applicationPassword:created?.password};
  if(!credentials(credential)||!UUID.test(created?.uuid||''))fail('bootstrap_credential_uncertain',true);
  await stage('credential_created',credential);
  const result=await verifyCredential(credential,root);await stage('ready');return result;
 }
 async function ensureReady(input){
  if(!object(input)||!UUID.test(input.operationId||'')||typeof input.username!=='string'||!input.username||input.username.length>256||/[:\r\n\0]/.test(input.username)||typeof input.password!=='string'||!input.password||input.password.length>4096||/[\r\n\0]/.test(input.password))fail('bootstrap_validation');
  let base;try{base=validatePublicUrl(input.baseUrl);if(base.search||base.hash)throw Error();if(!base.pathname.endsWith('/'))base.pathname+='/';}catch{fail('bootstrap_validation');}
  if(active.has(base.origin))fail('bootstrap_busy');active.add(base.origin);
  try{return await execute(input,base);}catch(error){if(error instanceof BootstrapError||/^BROWSER_[A-Z_]+$/.test(error?.code||''))throw error;fail('bootstrap_protocol_unavailable');}finally{active.delete(base.origin);}
 }
 return{ensureReady};
}
