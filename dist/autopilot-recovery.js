(function(){
'use strict';
const $=id=>document.getElementById(id),limit=150*1024*1024;
let session=0,revision=0,operation=0,busy=false,inspection=null,restored=false,restorePending=false,returnSettings=false;
function note(text,error=false){const n=$('ap-backup-notice');n.textContent=text;n.classList.toggle('error',error);n.hidden=!text;}
function clearReview(){revision++;inspection=null;$('ap-backup-review').hidden=true;$('ap-backup-ack').checked=false;update();}
function update(){
 $('ap-backup-export').disabled=busy||restored||restorePending;$('ap-backup-inspect').disabled=busy||restored||restorePending;
 $('ap-backup-export-password').disabled=busy||restored||restorePending;$('ap-backup-file').disabled=restored||restorePending;$('ap-backup-import-password').disabled=restored||restorePending;
 $('ap-backup-confirm').disabled=busy||restored||restorePending||!inspection?.canRestore||!$('ap-backup-ack').checked;
 $('ap-backup').setAttribute('aria-busy',String(busy||restorePending));
}
function reset(){session++;operation++;revision++;busy=false;inspection=null;$('ap-backup-export-form').reset();$('ap-backup-inspect-form').reset();$('ap-backup-review').hidden=true;$('ap-backup-ack').checked=false;note(restored?'Копію відновлено. Перезапустіть сервер PagePoster, потім оновіть сторінку.':restorePending?'Відновлюємо вибрану копію…':'');update();}
async function request(action,body){
 const response=await fetch('/api/recovery/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PagePoster-Request':'1'},body:JSON.stringify(body)});
 let value;try{value=await response.json();}catch{throw Error('Сервер не підтвердив результат. Перевірте зв’язок із PagePoster.');}
 if(!response.ok)throw Error(value.error||'Не вдалося обробити резервну копію.');return value;
}
function password(id){const value=$(id).value;if(value.length<12||value.length>256)throw Error('Пароль має містити від 12 до 256 символів.');return value;}
function download(archive){const url=URL.createObjectURL(new Blob([JSON.stringify(archive,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='PagePoster-backup-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportBackup(event){
 event.preventDefault();if(busy||restored||restorePending)return;const ownSession=session,ownOperation=++operation;busy=true;update();note('Стискаємо та шифруємо копію… Для великої бази це може зайняти кілька хвилин.');
 try{const passphrase=password('ap-backup-export-password'),archive=await request('export',{passphrase});if(ownSession!==session)return;if(archive?.kind!=='pageposter-full-encrypted-backup'||![1,2].includes(archive.version)||typeof archive.ciphertext!=='string')throw Error('Сервер не повернув захищену копію. Повторіть створення.');download(archive);note('Зашифровану копію передано браузеру для завантаження. Збережіть пароль окремо. Ліміти: 512 МіБ даних і 150 МіБ файлу копії.');}
 catch(error){if(ownSession===session)note(error.message||'Не вдалося створити копію.',true);}
 finally{if(ownSession===session)$('ap-backup-export-password').value='';if(ownOperation===operation){busy=false;update();}}
}
function showInspection(result,backup,passphrase,file,ownRevision){
 const summary=result.summary;if(!summary||['projects','pages','sites','runs','jobs','files'].some(key=>!Number.isSafeInteger(summary[key])||summary[key]<0)||typeof result.canRestore!=='boolean')throw Error('Сервер не підтвердив вміст копії. Повторіть перевірку.');
 inspection={backup,passphrase,file,revision:ownRevision,canRestore:result.canRestore};
 const root=$('ap-backup-counts');root.replaceChildren();for(const [key,label] of [['projects','Проєктів'],['pages','Сторінок'],['sites','Сайтів'],['runs','Запусків'],['jobs','Завдань'],['files','Файлів']]){const p=document.createElement('p');p.textContent=label+': '+summary[key];root.appendChild(p);}
 const date=new Date(summary.createdAt);$('ap-backup-date').textContent=Number.isNaN(date.valueOf())?'':'Створено: '+date.toLocaleString('uk-UA');
 $('ap-backup-restore-state').textContent=result.canRestore?'Ця копія готова до відновлення. Після підтвердження потрібен перезапуск сервера.':'У поточній базі вже є дані. Відновлення доступне в порожню базу; наявні проєкти зберігаються.';
 $('ap-backup-ack-label').hidden=!result.canRestore;$('ap-backup-review').hidden=false;note('Перевірку копії завершено.');
}
async function inspectBackup(event){
 event.preventDefault();if(busy||restored||restorePending)return;clearReview();const ownRevision=revision,ownSession=session,ownOperation=++operation;busy=true;update();note('Перевіряємо файл і пароль…');
 try{const file=$('ap-backup-file').files[0],passphrase=password('ap-backup-import-password');if(!file)throw Error('Виберіть файл захищеної копії.');if(file.size>limit)throw Error('Файл копії має бути не більшим за 150 МіБ.');let backup;try{backup=JSON.parse(await file.text());}catch{throw Error('Не вдалося прочитати файл JSON. Виберіть захищену копію PagePoster.');}
  if(ownSession!==session||ownRevision!==revision)return;if(!backup||backup.kind!=='pageposter-full-encrypted-backup'||![1,2].includes(backup.version))throw Error('Цей файл не є захищеною копією PagePoster.');
  const result=await request('inspect',{backup,passphrase});if(ownSession!==session||ownRevision!==revision)return;showInspection(result,backup,passphrase,file,ownRevision);
 }catch(error){if(ownSession===session&&ownRevision===revision)note(error.message||'Не вдалося перевірити копію.',true);}
 finally{if(ownOperation===operation){busy=false;update();}}
}
async function restoreBackup(){
 const approved=inspection;if(busy||restored||restorePending||!approved?.canRestore||!$('ap-backup-ack').checked)return;
 if(approved.revision!==revision||approved.file!==$('ap-backup-file').files[0]||approved.passphrase!==$('ap-backup-import-password').value){clearReview();note('Файл або пароль змінилися. Перевірте копію ще раз.',true);return;}
 const ownOperation=++operation;inspection=null;restorePending=true;busy=true;update();note('Відновлюємо вибрану копію…');
 try{const result=await request('restore',{backup:approved.backup,passphrase:approved.passphrase,confirmed:true});if(result.restored!==true)throw Error('Сервер не підтвердив відновлення. Перевірте його стан перед новою спробою.');restored=true;restorePending=false;returnSettings=false;reset();window.dispatchEvent(new Event('pageposter:recovery-restored'));note('Копію відновлено. Перезапустіть сервер PagePoster, потім оновіть сторінку. Завдання залишаться призупиненими до ручного продовження.');}
 catch(error){$('ap-backup-review').hidden=true;note((error.message||'Результат відновлення не підтверджений.')+' Перед новою спробою перевірте стан сервера й повторно перевірте файл.',true);}
 finally{restorePending=false;$('ap-backup-import-password').value='';$('ap-backup-ack').checked=false;if(ownOperation===operation)busy=false;update();}
}
function init(){
 if(!$('ap-backup'))return;
 $('ap-backup-open').addEventListener('click',()=>{reset();returnSettings=$('ap-settings').open;if(returnSettings)$('ap-settings').close();$('ap-backup').showModal();$('ap-backup-export-password').focus();});
 $('ap-backup-close').addEventListener('click',()=>$('ap-backup').close());
 $('ap-backup').addEventListener('close',()=>{if($('ap-backup').open)return;reset();if(returnSettings&&!restored){$('ap-settings').showModal();$('ap-backup-open').focus();}else $('ap-main').focus({preventScroll:true});});
 $('ap-backup-export-form').addEventListener('submit',exportBackup);$('ap-backup-inspect-form').addEventListener('submit',inspectBackup);$('ap-backup-confirm').addEventListener('click',restoreBackup);$('ap-backup-ack').addEventListener('change',update);
 $('ap-backup-file').addEventListener('change',()=>{clearReview();note('');});$('ap-backup-import-password').addEventListener('input',()=>{clearReview();note('');});update();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
