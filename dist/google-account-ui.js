/* Ordinary Google OAuth: registration belongs to the app, never to its user. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),dialog=$('ap-settings'),mode=$('ga-mode'),user=$('ga-user'),service=$('ga-service'),status=$('ga-status'),note=$('ga-note'),connect=$('ga-connect'),cancel=$('ga-cancel'),disconnect=$('ga-disconnect'),openLink=$('ga-open-link');
 if(![dialog,mode,user,service,status,note,connect,cancel,disconnect,openLink].every(Boolean))return;
 const errors={KEY_REQUIRED:'Перезапустите PagePoster, чтобы открыть защищённое хранилище.',GOOGLE_CLIENT_REQUIRED:'Вход Google не настроен в этой сборке PagePoster. Требуется обновление приложения.',GOOGLE_AUTH_REQUIRED:'Войдите через Google, чтобы продолжить чтение таблицы.',GOOGLE_AUTH_FAILED:'Google не завершил вход. Проверьте сообщение на странице Google.',GOOGLE_AUTH_CANCELLED:'Вход отменён. Можно выбрать аккаунт ещё раз.',GOOGLE_AUTH_TIMEOUT:'Время ожидания входа истекло. Нажмите «Войти через Google» ещё раз.',source_access_denied:'Аккаунт подключён, но Google отказал в чтении выбранной таблицы. Проверьте, что на странице входа выбран нужный аккаунт.',SOURCE_NOT_CONFIGURED:'Сохраните ссылку на нужную вкладку таблицы.'};
 let account={clientConfigured:false,connected:false,phase:'idle',email:''},known=false,busy=false,epoch=0,timer=null,reading=null,prepared=null,verification=null,verified='';
 const visible=()=>dialog.open&&mode.value==='user';
 function message(text,error=false){note.textContent=String(text||'').slice(0,500);note.hidden=!text;note.classList.toggle('error',error);}
 function stop(){clearTimeout(timer);timer=null;}
 function clearLink(){openLink.hidden=true;openLink.removeAttribute('href');}
 function changed(){window.dispatchEvent(new CustomEvent('pageposter:google-account-changed'));}
 function render(){
  user.hidden=mode.value!=='user';service.hidden=mode.value!=='service';const input=service.querySelector('[name="serviceAccount"]');if(input)input.disabled=mode.value!=='service';
  mode.disabled=busy;connect.disabled=busy||!known||account.phase==='waiting';connect.textContent=account.connected?'Выбрать другой аккаунт':'Войти через Google';cancel.hidden=account.phase!=='waiting';cancel.disabled=busy;disconnect.hidden=!account.connected;disconnect.disabled=busy;
  status.textContent=!known?'Проверяем подключение…':account.phase==='waiting'?'Завершите вход в Chrome. PagePoster получит подключение автоматически.':account.connected?'Подключён аккаунт: '+(account.email||'Google'):'Нажмите «Войти через Google» и выберите аккаунт, которому доступна таблица.';
 }
 async function request(path,body){
  const response=await fetch('/api/lifecycle/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'X-PagePoster-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});let result;try{result=await response.json();}catch{throw Error('PagePoster не подтвердил ответ. Откройте подключения ещё раз.');}
  if(!response.ok)throw Object.assign(Error(errors[result.code]||result.message||'Не удалось завершить подключение Google.'),{code:result.code});return result;
 }
 async function verifySource(current){
  if(verification||!visible()||!account.connected||account.phase!=='connected')return;
  verification=(async()=>{try{
   const state=await request('autopilot/status'),source=state.source;if(current!==epoch||!visible()||source?.authMode!=='user'||!source.spreadsheetId)return;
   const fingerprint=JSON.stringify([source.spreadsheetUrl,source.range,source.columns,prepared?.projectId,account.email]);if(verified===fingerprint)return;
   message('Аккаунт подключён. Читаем выбранную вкладку и проверяем подбор…');
   const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Не удалось завершить проверку таблицы. Повторите «Проверить подбор».')),60000);window.dispatchEvent(new CustomEvent('pageposter:google-source-verify',{detail:{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}}}));});if(current!==epoch||!visible())return;
   if(!Number.isSafeInteger(result.candidateCount)||result.candidateCount<0||!Number.isSafeInteger(result.issueCount)||result.issueCount<0)throw Error('Сервер не подтвердил чтение таблицы.');
   verified=fingerprint;message('Таблица прочитана. Подходящих сайтов: '+result.candidateCount+'. Замечаний к данным: '+result.issueCount+'.');changed();
  }catch(error){if(current===epoch&&visible())message(error.message,true);}finally{if(current===epoch)verification=null;}})();await verification;
 }
 function accept(value,notify=false){
  if(!value||typeof value.connected!=='boolean'||typeof value.clientConfigured!=='boolean')throw Error('Не удалось проверить подключение Google.');
  const previous=account;account={clientConfigured:value.clientConfigured,connected:value.connected,phase:['idle','waiting','connected','error'].includes(value.phase)?value.phase:'idle',email:typeof value.email==='string'?value.email:''};known=true;
  if(account.phase!=='waiting')clearLink();if(value.error?.code)message(errors[value.error.code]||errors.GOOGLE_AUTH_FAILED,true);render();
  if(notify||previous.connected!==account.connected||previous.email!==account.email)changed();
 }
 function poll(){stop();if(visible()&&!busy&&account.phase==='waiting')timer=setTimeout(refresh,1200);}
 function refresh(){
  if(!visible()||busy)return Promise.resolve();if(reading)return reading;const current=epoch;
  reading=(async()=>{try{const result=await request('google/account');if(current!==epoch||!visible())return;accept(result.account);if(account.connected&&account.phase==='connected')void verifySource(current);}catch(error){if(current===epoch&&visible()){known=false;render();message(error.message,true);}}finally{if(current===epoch){reading=null;poll();}}})();return reading;
 }
 function authorization(value){let url;try{url=new URL(value);}catch{throw Error('Google вернул недопустимый адрес входа.');}if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth'||url.username||url.password||url.port||url.hash)throw Error('Google вернул недопустимый адрес входа.');return url.href;}
 async function openAuthorization(value){const url=authorization(value);if(typeof window.pageposterDesktop?.openGooglePage==='function')await window.pageposterDesktop.openGooglePage(url);else window.open(url,'_blank','noopener,noreferrer');}
 async function action(run){if(busy||!visible())return;const current=++epoch;reading=null;verification=null;busy=true;stop();message('');render();try{await run(()=>current===epoch&&visible());}catch(error){if(current===epoch&&visible())message(error.message,true);}finally{if(current===epoch){busy=false;render();poll();}}}
 connect.addEventListener('click',()=>action(async active=>{
  if(!account.clientConfigured)throw Error(errors.GOOGLE_CLIENT_REQUIRED);
  prepared=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Не удалось сохранить ссылку на таблицу.')),15000);window.dispatchEvent(new CustomEvent('pageposter:google-account-prepare',{detail:{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}}}));});if(!active())return;
  verified='';clearLink();const result=await request('google/connect',{});if(!active())return;const url=authorization(result.authorizationUrl);accept(result.status,true);openLink.href=url;openLink.hidden=false;
  try{await openAuthorization(url);if(active())message('Выберите аккаунт на странице Google и подтвердите чтение. Затем вернитесь в PagePoster — таблица проверится автоматически.');}catch{if(active())message('Откройте страницу входа ссылкой ниже.',true);}
 }));
 openLink.addEventListener('click',event=>{if(typeof window.pageposterDesktop?.openGooglePage!=='function')return;event.preventDefault();void openAuthorization(openLink.href).catch(()=>message('Не удалось открыть Chrome. Повторите вход.',true));});
 cancel.addEventListener('click',()=>action(async active=>{const result=await request('google/cancel',{});if(active()){accept(result.account,true);message('Вход отменён.');}}));
 disconnect.addEventListener('click',()=>action(async active=>{const result=await request('google/disconnect',{});if(active()){verified='';accept(result.account,true);message('Аккаунт отключён от PagePoster.');}}));
 function reset(){epoch++;reading=null;known=false;busy=false;verification=null;verified='';prepared=null;account={clientConfigured:false,connected:false,phase:'idle',email:''};stop();clearLink();message('');render();if(visible())refresh();}
 mode.addEventListener('change',reset);window.addEventListener('pageposter:settings-opened',event=>{if(!dialog.open||busy)return;mode.value=event.detail?.source?.authMode==='service'?'service':'user';reset();});
 const closed=()=>{if(dialog.open)return;epoch++;reading=null;busy=false;stop();clearLink();render();};dialog.addEventListener('close',closed);new MutationObserver(closed).observe(dialog,{attributes:true,attributeFilter:['open']});render();
})();
