import {JSDOM,VirtualConsole} from './dom-runtime.mjs';

const MAX_BYTES=2*1024*1024,MAX_ELEMENTS=50000,MAX_PLACEHOLDERS=50;
const messages={
 WORDPRESS_CSS_REQUIRED:'WordPress має зберегти CSS цього варіанта. Права редактора або тема можуть вилучати стилі чи скрипти; перевірте оформлення у попередньому перегляді.',
 PLACEHOLDERS_FOUND:'У посиланнях залишилися адреси-заглушки. Перевірте й замініть їх перед публікацією.',
 UNSAFE_NAVIGATION:'Виявлено непідтримувані або небезпечні адреси. У спрощеному варіанті такі переходи вимкнено.',
 UNRESOLVED_CONTROLS:'Деякі кнопки залежать від довільного JavaScript і не мають підтвердженої адреси. У спрощеному варіанті вони вимкнені; перевірте їх вручну.',
 SCRIPT_DEPENDENT_CONTROLS:'Частина переходів використовує JavaScript. WordPress може його вилучити; перевірте кнопки або явно виберіть спрощений варіант.',
 ACTIVE_CONTENT_REMOVED:'Зі спрощеного варіанта вилучено скрипти, обробники подій та активні вбудовані елементи.',
 FORM_CONTROLS_DISABLED:'У спрощеному варіанті надсилання форм і поля введення вимкнено. Якщо вони потрібні, налаштуйте їх окремо у WordPress.',
 AMBIGUOUS_NAVIGATION:'Елемент має різні адреси переходу. У спрощеному варіанті збережено наявне безпечне href; додатковий перехід вимкнено.',
 SIMPLIFIED_SELECTED:'Спрощений варіант вибрано явно: дозволені переходи стали звичайними посиланнями, скрипти вилучено. Збережені CSS, класи та текст потребують перевірки оформлення у WordPress.'
};
const fail=(code='VALIDATION')=>{throw Object.assign(Error(code==='MANUAL_ORIGINAL_UNAVAILABLE'?'Початковий HTML для цієї сторінки недоступний.':'Перевірте варіант і дані ручного експорту.'),{code});};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function htmlValue(value){
 if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value,'utf8')>MAX_BYTES||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail();
 return value;
}
function identity(value){if(value!==null&&(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,200}$/.test(value)))fail();return value;}
function filename(title,variant){
 let stem=title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'-').replace(/\s+/g,' ').replace(/^[ .-]+|[ .-]+$/g,'').slice(0,100).replace(/[ .-]+$/g,'');
 if(!stem||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem))stem='pageposter-page';
 return stem+'-'+variant+'.html';
}
// This parser has neither scripts nor resource loading enabled. Template
// contents are inspected too, so a later DOM insertion cannot restore handlers.
function elements(root){
 const result=[],roots=[root];
 while(roots.length){for(const node of roots.pop().querySelectorAll('*')){result.push(node);if(result.length>MAX_ELEMENTS)fail();if(node.localName==='template')roots.push(node.content);}}
 return result;
}
function safeNavigation(value){
 if(typeof value!=='string'||!value||value.length>8192||/[\u0000-\u0020\u007f\\]/.test(value))return false;
 if(value.startsWith('#'))return true;
 if(!/^[a-z][a-z\d+.-]*:/i.test(value)&&!value.startsWith('//'))return true;
 try{const url=new URL(value.startsWith('//')?'https:'+value:value);return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}
}
function placeholder(value){
 let decoded=value;try{decoded=decodeURIComponent(value);}catch{}
 if(/\{\{[^{}]+\}\}|\$\{[^{}]+\}/.test(decoded))return true;
 try{const url=new URL(value.startsWith('//')?'https:'+value:value),host=url.hostname.toLowerCase().replace(/\.$/,'');return /(?:^|\.)(?:invalid|test|example)$/.test(host)||/(?:^|\.)example\.(?:com|net|org)$/.test(host);}catch{return false;}
}
function diagnosticUrl(value){
 try{const url=new URL(value.startsWith('//')?'https:'+value:value);if(url.username||url.password)return '[адреса з даними входу]';}catch{}
 if(/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^https?:/i.test(value))return '[непідтримувана адреса]';
 return value.slice(0,1000);
}
const label=node=>(node.getAttribute('aria-label')||node.textContent||node.getAttribute('alt')||node.getAttribute('title')||'').replace(/\s+/g,' ').trim().slice(0,160);
function auditNodes(nodes,flags){
 const seen=new Set(),placeholders=[];let placeholderCount=0;
 for(const node of nodes){
  const attributes=[...((node.localName==='a'||node.localName==='area')&&node.hasAttribute('href')?['href']:[]),...(node.hasAttribute('data-pp-url')?['data-pp-url']:[])];
  for(const attribute of attributes){const value=node.getAttribute(attribute);if(!safeNavigation(value))flags.add('UNSAFE_NAVIGATION');if(!placeholder(value))continue;
   placeholderCount++;const url=diagnosticUrl(value),key=attribute+'\u0000'+url;if(!seen.has(key)){seen.add(key);if(placeholders.length<MAX_PLACEHOLDERS)placeholders.push({url,attribute,label:label(node)});}
  }
  if(node.hasAttribute('href')&&node.hasAttribute('data-pp-url')&&node.getAttribute('href')!==node.getAttribute('data-pp-url'))flags.add('AMBIGUOUS_NAVIGATION');
  const url=node.getAttribute('data-pp-url'),handler=[...node.attributes].some(a=>/^on/i.test(a.name)),control=['button','input','select','textarea'].includes(node.localName)||['button','link'].includes(node.getAttribute('role'));
  if(url&&safeNavigation(url)&&node.localName!=='a')flags.add('SCRIPT_DEPENDENT_CONTROLS');
  if((handler||control)&&!url&&!(node.localName==='a'&&safeNavigation(node.getAttribute('href'))))flags.add('UNRESOLVED_CONTROLS');
 }
 if(placeholderCount)flags.add('PLACEHOLDERS_FOUND');
 return {placeholderCount,placeholders};
}
function replaceTag(node,name){
 const replacement=node.ownerDocument.createElementNS(node.namespaceURI,name);for(const attr of [...node.attributes])replacement.setAttribute(attr.name,attr.value);
 while(node.firstChild)replacement.append(node.firstChild);node.replaceWith(replacement);return replacement;
}
function disable(node){node.setAttribute('aria-disabled','true');node.removeAttribute('tabindex');if(['button','input','select','textarea','fieldset','optgroup','option'].includes(node.localName))node.setAttribute('disabled','');}
function simplify(document,flags){
 const active='script,iframe,frame,frameset,object,embed,applet,base,meta[http-equiv],animate,animateMotion,animateTransform,set,link[rel="import"],link[rel="modulepreload"],link[as="script"]';
 for(const node of elements(document)){
  if(node.matches(active)){node.remove();flags.add('ACTIVE_CONTENT_REMOVED');continue;}
  for(const attr of [...node.attributes]){
   const name=attr.name.toLowerCase();
   if(/^on/.test(name)||['srcdoc','ping','autofocus','formaction'].includes(name)){node.removeAttribute(attr.name);flags.add('ACTIVE_CONTENT_REMOVED');continue;}
   if(['href','xlink:href','src','data-pp-url','poster'].includes(name)){
    const media=name==='src'||name==='poster',safeMedia=media&&/^data:(?:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml)|audio\/|video\/)/i.test(attr.value);
    if(!safeMedia&&!safeNavigation(attr.value)){node.removeAttribute(attr.name);flags.add('UNSAFE_NAVIGATION');}
   }
   if(name==='srcset'&&/(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)/i.test(attr.value)){node.removeAttribute(attr.name);flags.add('UNSAFE_NAVIGATION');}
  }
 }
 for(let node of elements(document)){
  if(node.localName==='form'){node=replaceTag(node,'div');node.removeAttribute('action');node.removeAttribute('method');flags.add('FORM_CONTROLS_DISABLED');}
  const destination=node.getAttribute('data-pp-url');
  const inputNavigation=node.localName==='input'&&['button','submit','reset','image'].includes((node.getAttribute('type')||'').toLowerCase())&&destination;
  if(['input','select','textarea'].includes(node.localName)&&!inputNavigation){disable(node);flags.add('FORM_CONTROLS_DISABLED');}
  if(destination){
   const existing=node.getAttribute('href');
   if(existing!==null&&existing!==destination){node.removeAttribute('data-pp-url');flags.add('AMBIGUOUS_NAVIGATION');continue;}
   if(node.hasAttribute('disabled')||node.getAttribute('aria-disabled')==='true'||node.querySelector('a[href],button,input,select,textarea')||['html','head','body','style','template','link','meta'].includes(node.localName)){
    node.removeAttribute('data-pp-url');disable(node);flags.add('UNRESOLVED_CONTROLS');continue;
   }
   if(node.localName==='img'){
    const anchor=document.createElement('a');anchor.setAttribute('href',destination);node.replaceWith(anchor);anchor.append(node);node=anchor;
   }else if(inputNavigation){
    const type=(node.getAttribute('type')||'').toLowerCase(),text=node.getAttribute('value')||node.getAttribute('aria-label')||node.getAttribute('alt')||'',src=node.getAttribute('src');
    node=replaceTag(node,'a');
    if(type==='image'&&src){const image=document.createElement('img');image.setAttribute('src',src);image.setAttribute('alt',text);node.append(image);}else node.textContent=text;
   }else if(!['a','area'].includes(node.localName))node=replaceTag(node,'a');
   node.setAttribute('href',destination);node.removeAttribute('role');node.removeAttribute('disabled');node.removeAttribute('aria-disabled');
   const target=node.getAttribute('data-pp-target');if(['_blank','_self'].includes(target))node.setAttribute('target',target);
  }else if(node.localName==='button'||['button','link'].includes(node.getAttribute('role'))&&!safeNavigation(node.getAttribute('href'))){disable(node);flags.add('UNRESOLVED_CONTROLS');}
  if(node.getAttribute('target')==='_blank'){const rel=new Set((node.getAttribute('rel')||'').split(/\s+/).filter(Boolean));rel.add('noopener');rel.add('noreferrer');node.setAttribute('rel',[...rel].join(' '));}
 }
 flags.delete('SCRIPT_DEPENDENT_CONTROLS');
}

export function createManualExport(input){
 if(!plain(input)||Object.keys(input).some(key=>!['title','originalHtml','preparedHtml','variant','runId','pageId','pageRevision'].includes(key)))fail();
 const {title,originalHtml=null,preparedHtml,variant='prepared',runId=null,pageId=null,pageRevision=null}=input;
 if(typeof title!=='string'||title.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)||!['original','prepared','simplified'].includes(variant))fail();
 htmlValue(preparedHtml);if(originalHtml!==null)htmlValue(originalHtml);identity(runId);identity(pageId);if(pageRevision!==null&&(!Number.isSafeInteger(pageRevision)||pageRevision<1))fail();
 if(variant==='original'&&originalHtml===null)fail('MANUAL_ORIGINAL_UNAVAILABLE');
 const selected=variant==='original'?originalHtml:preparedHtml,flags=new Set(['WORDPRESS_CSS_REQUIRED']),dom=new JSDOM(selected,{virtualConsole:new VirtualConsole()});
 try{
  const audit=auditNodes(elements(dom.window.document),flags);let html=selected;
  if(variant==='simplified'){flags.add('SIMPLIFIED_SELECTED');simplify(dom.window.document,flags);html=dom.serialize();}
  const needsReview=['PLACEHOLDERS_FOUND','UNSAFE_NAVIGATION','UNRESOLVED_CONTROLS','SCRIPT_DEPENDENT_CONTROLS','FORM_CONTROLS_DISABLED','AMBIGUOUS_NAVIGATION'].some(code=>flags.has(code));
  return {version:1,runId,pageId,pageRevision,title,variant,html,filename:filename(title,variant),available:{original:originalHtml!==null,prepared:true,simplified:true},warnings:[...flags].map(code=>({code,message:messages[code]})),audit:{state:needsReview?'needs_review':'ready',...audit},steps:[
   'У WordPress створіть нову сторінку та скопіюйте її назву.',
   'Додайте блок «Власний HTML» або відкрийте режим «Текст» класичного редактора й вставте HTML обраного варіанта.',
   'Забезпечте збереження CSS дозволеним на цьому сайті способом. Якщо WordPress вилучає стилі чи скрипти, перевірте права та можливості теми; універсального перенесення оформлення немає.',
   'У попередньому перегляді ПК перевірте оформлення, кнопки, точні адреси та заглушки. Публікуйте лише після власного підтвердження.'
  ]};
 }finally{dom.window.close();}
}
