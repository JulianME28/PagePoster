/* Ordinary Google OAuth: registration belongs to the app, never to its user. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),dialog=$('ap-settings'),mode=$('ga-mode'),user=$('ga-user'),service=$('ga-service'),status=$('ga-status'),note=$('ga-note'),connect=$('ga-connect'),cancel=$('ga-cancel'),disconnect=$('ga-disconnect'),openLink=$('ga-open-link');
 if(![dialog,mode,user,service,status,note,connect,cancel,disconnect,openLink].every(Boolean))return;
 const errors={KEY_REQUIRED:'Перезапустіть PagePoster, щоб відкрити захищене сховище.',GOOGLE_CLIENT_REQUIRED:'Вхід Google не налаштований у цій збірці PagePoster. Потрібне оновлення застосунку.',GOOGLE_AUTH_REQUIRED:'Увійдіть через Google, щоб продовжити читання таблиці.',GOOGLE_AUTH_FAILED:'Google не завершив вхід. Перевірте повідомлення на сторінці Google.',GOOGLE_AUTH_CANCELLED:'Вхід скасовано. Можна вибрати акаунт ще раз.',GOOGLE_AUTH_TIMEOUT:'Час очікування входу минув. Натисніть «Увійти через Google» ще раз.',source_access_denied:'Акаунт підключено, але Google відмовив у читанні вибраної таблиці. Перевірте, чи на сторінці входу вибрано потрібний акаунт.',SOURCE_NOT_CONFIGURED:'Збережіть посилання на потрібну вкладку таблиці.'};
 let account={clientConfigured:false,connected:false,phase:'idle',email:''},known=false,busy=false,epoch=0,timer=null,reading=null,prepared=null,verification=null,verified='';
 const visible=()=>dialog.open&&mode.value==='user';
 function message(text,error=false){note.textContent=String(text||'').slice(0,500);note.hidden=!text;note.classList.toggle('error',error);}
 function stop(){clearTimeout(timer);timer=null;}
 function clearLink(){openLink.hidden=true;openLink.removeAttribute('href');}
 function changed(){window.dispatchEvent(new CustomEvent('pageposter:google-account-changed'));}
 function render(){
  user.hidden=mode.value!=='user';service.hidden=mode.value!=='service';const input=service.querySelector('[name="serviceAccount"]');if(input)input.disabled=mode.value!=='service';
  mode.disabled=busy;connect.disabled=busy||!known||account.phase==='waiting';connect.textContent=account.connected?'Вибрати інший акаунт':'Увійти через Google';cancel.hidden=account.phase!=='waiting';cancel.disabled=busy;disconnect.hidden=!account.connected;disconnect.disabled=busy;
  status.textContent=!known?'Перевіряємо підключення…':account.phase==='waiting'?'Завершіть вхід у Chrome. PagePoster отримає підключення автоматично.':account.connected?'Підключений акаунт: '+(account.email||'Google'):'Натисніть «Увійти через Google» і виберіть акаунт, якому доступна таблиця.';
 }
 async function request(path,body){
  const response=await fetch('/api/lifecycle/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'X-PagePoster-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});let result;try{result=await response.json();}catch{throw Error('PagePoster не підтвердив відповідь. Відкрийте налаштування ще раз.');}
  if(!response.ok)throw Object.assign(Error(errors[result.code]||result.message||'Не вдалося завершити підключення Google.'),{code:result.code});return result;
 }
 async function verifySource(current){
  if(verification||!visible()||!account.connected||account.phase!=='connected')return;
  verification=(async()=>{try{
   const state=await request('autopilot/status'),source=state.source;if(current!==epoch||!visible()||source?.authMode!=='user'||!source.spreadsheetId)return;
   const fingerprint=JSON.stringify([source.spreadsheetUrl,source.range,source.columns,prepared?.projectId,account.email]);if(verified===fingerprint)return;
   message('Акаунт підключено. Читаємо вибрану вкладку й перевіряємо підбір…');
   const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Не вдалося завершити перевірку таблиці. Повторіть «Перевірити підбір».')),60000);window.dispatchEvent(new CustomEvent('pageposter:google-source-verify',{detail:{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}}}));});if(current!==epoch||!visible())return;
   if(!Number.isSafeInteger(result.candidateCount)||result.candidateCount<0||!Number.isSafeInteger(result.issueCount)||result.issueCount<0)throw Error('Сервер не підтвердив читання таблиці.');
   verified=fingerprint;message('Таблицю прочитано. Придатних сайтів: '+result.candidateCount+'. Зауважень до даних: '+result.issueCount+'.');changed();
  }catch(error){if(current===epoch&&visible())message(error.message,true);}finally{if(current===epoch)verification=null;}})();await verification;
 }
 function accept(value,notify=false){
  if(!value||typeof value.connected!=='boolean'||typeof value.clientConfigured!=='boolean')throw Error('Не вдалося перевірити підключення Google.');
  const previous=account;account={clientConfigured:value.clientConfigured,connected:value.connected,phase:['idle','waiting','connected','error'].includes(value.phase)?value.phase:'idle',email:typeof value.email==='string'?value.email:''};known=true;
  if(account.phase!=='waiting')clearLink();if(value.error?.code)message(errors[value.error.code]||errors.GOOGLE_AUTH_FAILED,true);render();
  if(notify||previous.connected!==account.connected||previous.email!==account.email)changed();
 }
 function poll(){stop();if(visible()&&!busy&&account.phase==='waiting')timer=setTimeout(refresh,1200);}
 function refresh(){
  if(!visible()||busy)return Promise.resolve();if(reading)return reading;const current=epoch;
  reading=(async()=>{try{const result=await request('google/account');if(current!==epoch||!visible())return;accept(result.account);if(account.connected&&account.phase==='connected')void verifySource(current);}catch(error){if(current===epoch&&visible()){known=false;render();message(error.message,true);}}finally{if(current===epoch){reading=null;poll();}}})();return reading;
 }
 function authorization(value){let url;try{url=new URL(value);}catch{throw Error('Google повернув неприпустиму адресу входу.');}if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth'||url.username||url.password||url.port||url.hash)throw Error('Google повернув неприпустиму адресу входу.');return url.href;}
 async function openAuthorization(value){const url=authorization(value);if(typeof window.pageposterDesktop?.openGooglePage==='function')await window.pageposterDesktop.openGooglePage(url);else window.open(url,'_blank','noopener,noreferrer');}
 async function action(run){if(busy||!visible())return;const current=++epoch;reading=null;verification=null;busy=true;stop();message('');render();try{await run(()=>current===epoch&&visible());}catch(error){if(current===epoch&&visible())message(error.message,true);}finally{if(current===epoch){busy=false;render();poll();}}}
 connect.addEventListener('click',()=>action(async active=>{
  if(!account.clientConfigured)throw Error(errors.GOOGLE_CLIENT_REQUIRED);
  prepared=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Не вдалося зберегти посилання на таблицю.')),15000);window.dispatchEvent(new CustomEvent('pageposter:google-account-prepare',{detail:{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}}}));});if(!active())return;
  verified='';clearLink();const result=await request('google/connect',{});if(!active())return;const url=authorization(result.authorizationUrl);accept(result.status,true);openLink.href=url;openLink.hidden=false;
  try{await openAuthorization(url);if(active())message('Виберіть акаунт на сторінці Google й підтвердьте читання. Потім поверніться в PagePoster — таблиця перевіриться автоматично.');}catch{if(active())message('Відкрийте сторінку входу за посиланням нижче.',true);}
 }));
 openLink.addEventListener('click',event=>{if(typeof window.pageposterDesktop?.openGooglePage!=='function')return;event.preventDefault();void openAuthorization(openLink.href).catch(()=>message('Не вдалося відкрити Chrome. Повторіть вхід.',true));});
 cancel.addEventListener('click',()=>action(async active=>{const result=await request('google/cancel',{});if(active()){accept(result.account,true);message('Вхід скасовано.');}}));
 disconnect.addEventListener('click',()=>action(async active=>{const result=await request('google/disconnect',{});if(active()){verified='';accept(result.account,true);message('Акаунт відключено від PagePoster.');}}));
 function reset(){epoch++;reading=null;known=false;busy=false;verification=null;verified='';prepared=null;account={clientConfigured:false,connected:false,phase:'idle',email:''};stop();clearLink();message('');render();if(visible())refresh();}
 mode.addEventListener('change',reset);window.addEventListener('pageposter:settings-opened',event=>{if(!dialog.open||busy)return;mode.value=event.detail?.source?.authMode==='service'?'service':'user';reset();});
 const closed=()=>{if(dialog.open)return;epoch++;reading=null;busy=false;stop();clearLink();render();};dialog.addEventListener('close',closed);new MutationObserver(closed).observe(dialog,{attributes:true,attributeFilter:['open']});render();
})();
