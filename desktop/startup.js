'use strict';
const title=document.getElementById('title'),message=document.getElementById('message'),restart=document.getElementById('restart');
window.pageposterDesktop?.onStatus(value=>{title.textContent=value.state==='error'?'Не вдалося відкрити PagePoster':value.state==='stopping'?'Завершуємо поточні дії':'Відкриваємо робоче місце';message.textContent=value.message;restart.hidden=value.state!=='error';});
restart.addEventListener('click',()=>window.pageposterDesktop.restart());
