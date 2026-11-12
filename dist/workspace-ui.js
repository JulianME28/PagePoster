(function(){
'use strict';
const $=id=>document.getElementById(id);
function button(text,action){const control=document.createElement('button');control.type='button';control.className='ap-button ap-secondary';control.textContent=text;control.addEventListener('click',action);return control;}
let settingsReady=false;
function actionMenu(id,label,ids){
 const controls=ids.map($).filter(Boolean);if(!controls.length||$(id))return;
 const menu=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
 menu.id=id;menu.className='ap-action-menu';summary.textContent=label;body.className='ap-action-menu-body';menu.append(summary,body);controls[0].before(menu);body.append(...controls);
 menu.addEventListener('click',event=>{const control=event.target.closest('button');if(control&&!control.disabled&&body.contains(control)){menu.open=false;summary.focus({preventScroll:true});}},true);
 menu.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.open){event.preventDefault();event.stopPropagation();menu.open=false;summary.focus({preventScroll:true});}});
 summary.addEventListener('click',()=>{if(!menu.open)for(const other of document.querySelectorAll('.ap-action-menu[open]'))if(other!==menu)other.open=false;});
}
function simplifyDesktop(){
 if(!window.pageposterDesktop)return;
 // Both import controls opened exactly the same form. Keep the persistent sidebar entry.
 $('pq-import-more')?.remove();$('ap-runtime').hidden=true;
 actionMenu('ap-stage-export-menu','HTML та експорт',['ap-stage-copy','ap-stage-manual-export']);
 actionMenu('ap-preview-export-menu','HTML та експорт',['ap-copy-html','ap-download-html','ap-preview-manual-export']);
 actionMenu('pq-review-export-menu','HTML та експорт',['pq-review-copy','pq-review-download','pq-review-manual']);
 actionMenu('ap-stage-view-menu','Вигляд',['ap-stage-desktop','ap-stage-mobile']);
 actionMenu('ap-preview-view-menu','Вигляд',['ap-preview-desktop','ap-preview-mobile']);
 actionMenu('pq-review-view-menu','Вигляд',['pq-review-desktop','pq-review-mobile']);
 document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.ap-action-menu[open]'))if(!menu.contains(event.target))menu.open=false;});
}
function settings(){
 if(settingsReady||!window.pageposterDesktop)return;settingsReady=true;
 const sections=[...$('ap-settings').querySelectorAll(':scope > .ap-setting-section')],tabs=document.createElement('nav');tabs.className='ap-settings-tabs';tabs.setAttribute('aria-label','Розділи налаштувань');const panes=new Map();
 for(const [name,label,indices] of [['google','Google і таблиця',[1]],['ai','OpenAI',[0]],['proxy','Проксі',[4]],['advanced','Додатково',[2,3]]]){const pane=document.createElement('div');pane.className='ap-settings-pane';pane.dataset.settingsPane=name;for(const index of indices)if(sections[index])pane.appendChild(sections[index]);$('ap-settings').appendChild(pane);panes.set(name,pane);const tab=button(label,()=>show(name));tab.dataset.settingsTab=name;tabs.appendChild(tab);}
 $('ap-settings-note').after(tabs);
 function show(name){for(const [key,pane] of panes)pane.hidden=key!==name;for(const tab of tabs.querySelectorAll('button'))tab.setAttribute('aria-pressed',String(tab.dataset.settingsTab===name));$('ap-settings').scrollTop=0;}
 window.PagePosterSettings=Object.freeze({show});show('google');
 const editor=document.createElement('details');editor.id='ap-key-editor';const summary=document.createElement('summary');summary.textContent='Додати або змінити ключ OpenAI';editor.appendChild(summary);$('ap-key-form').before(editor);editor.appendChild($('ap-key-form'));
 const state=$('ap-ai-state');state.classList.add('ap-settings-status');
}
function init(){
 document.documentElement.lang='uk';
 const labels={'pq-dashboard-open':'Сторінки й черги','pq-import-open':'Імпорт проєкту','ap-all':'Усі сторінки','ap-settings-open':'Налаштування','ap-site-selection-open':'Типові вимоги','ap-site-selection-title':'Вимоги для нових сторінок','ap-settings-title':'Налаштування','ap-check-pages':'Перевірити опубліковані'};
 for(const [id,label] of Object.entries(labels))if($(id))$(id).textContent=label;
 const manage=$('ap-projects-manage');manage.textContent='⋯';manage.title='Закриті проєкти й кошик';manage.setAttribute('aria-label','Керувати проєктами');manage.className='ap-icon';document.querySelector('.ap-project-label').appendChild(manage);
 const caption=document.querySelector('.ap-project-label > span');if(caption)caption.textContent='ПРОЄКТИ';
 const sideLabel=document.querySelector('.ap-side-label');if(sideLabel)sideLabel.textContent='РОБОЧЕ МІСЦЕ';
 const brandSmall=document.querySelector('.ap-brand small');if(brandSmall)brandSmall.textContent='';
 const bottom=document.querySelector('.ap-sidebar-bottom > p');if(bottom)bottom.remove();
 const bar=document.createElement('div');bar.className='ap-composer-bar';bar.id='ap-composer-bar';const back=button('← До списку сторінок',()=>$('pq-dashboard-open').click());bar.appendChild(back);const copy=document.createElement('span');copy.textContent='Додавання однієї сторінки';bar.appendChild(copy);$('ap-heading').before(bar);
 $('ap-app-menu')?.remove();
 settings();simplifyDesktop();window.addEventListener('pageposter:settings-opened',settings);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
