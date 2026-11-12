(function(){
'use strict';
const $=id=>document.getElementById(id);let serial=0,saved=null;
const controls=()=>[$('ap-proxy-enabled'),$('ap-proxy-list'),$('ap-proxy-save'),$('ap-proxy-clear')];
function busy(value){controls().forEach(control=>control.disabled=value);}
function note(text,bad=false){const target=$('ap-proxy-note');target.textContent=text;target.hidden=!text;target.classList.toggle('error',bad);}
async function request(body){
 const response=await fetch('/api/lifecycle/proxy/settings',{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json();}catch{throw Error('Не вдалося отримати відповідь PagePoster.');}
 if(!response.ok)throw Error(data.error||'Не вдалося зберегти проксі.');if(!data.proxy||!Number.isSafeInteger(data.proxy.revision))throw Error('Сервер не підтвердив налаштування проксі.');return data.proxy;
}
function render(value){saved=value;$('ap-proxy-enabled').checked=value.enabled;$('ap-proxy-status').textContent=(value.enabled?'Проксі увімкнено.':'Проксі вимкнено.')+' Збережено: '+value.count+'. Активних сесій: '+value.activeSessions+'.';}
async function load(){const current=++serial;busy(true);note('');$('ap-proxy-list').value='';try{const value=await request();if(current!==serial)return;render(value);if(!value.storageAvailable)note('Не налаштовано захищене зберігання доступів.',true);}catch(error){if(current===serial){saved=null;note(error.message,true);}}finally{if(current===serial){busy(!saved?.storageAvailable);window.dispatchEvent(new CustomEvent('pageposter:proxy-settings-loaded',{detail:{available:!!saved?.storageAvailable}}));}}}
async function save(clear=false){if(!saved)return;const current=++serial;busy(true);note('');try{
 const body={enabled:clear?false:$('ap-proxy-enabled').checked,expectedRevision:saved.revision,...(clear?{clear:true}:{list:$('ap-proxy-list').value})};
 const value=await request(body);if(current!==serial)return;render(value);$('ap-proxy-list').value='';window.dispatchEvent(new CustomEvent('pageposter:proxy-saved'));note(clear?'Список видалено. Поточні сесії завершать роботу з раніше вибраними проксі.':'Проксі збережено. Нові сесії використовуватимуть ці налаштування.');
 }catch(error){if(current===serial)note(error.message,true);}finally{if(current===serial)busy(false);}}
function init(){if(!$('ap-proxy-form'))return;$('ap-proxy-form').addEventListener('submit',event=>{event.preventDefault();void save();});$('ap-proxy-clear').addEventListener('click',()=>void save(true));window.addEventListener('pageposter:settings-opened',()=>void load());$('ap-settings').addEventListener('close',()=>{serial++;$('ap-proxy-list').value='';});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
