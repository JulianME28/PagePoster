// Optional, deterministic static AMP representation. Never fetches resources or
// runs customer JavaScript. The ordinary HTML is retained byte-for-byte.
import {createRequire} from 'node:module';
import {JSDOM} from './dom-runtime.mjs';
import {validateAmpDocument} from './amp-validator.mjs';
const require=createRequire(import.meta.url),cssTree=require('css-tree');
export const AMP_PARAMETER='pageposter_amp';
export function ampErrorMessage(code){return {
 AMP_VALIDATION_FAILED:'AMP-копія не пройшла офіційну перевірку. Можна вимкнути AMP для проєкту й використати збережений HTML.',
 AMP_UNSUPPORTED_CONTENT:'Матеріал містить елементи, які AMP-режим ще не підтримує. Використайте звичайний режим або підготуйте статичну версію.',
 AMP_UNSUPPORTED_INTERACTION:'Частина кнопок працює лише через JavaScript. Для AMP потрібні звичайні посилання.',
 AMP_UNSUPPORTED_CSS:'Ці стилі поки не можна безпечно підготувати для AMP. Звичайний HTML не змінено.',
 AMP_EXTERNAL_STYLES_REQUIRED:'Для AMP потрібні стилі всередині HTML. Зовнішні CSS-файли автоматично не завантажуються.',
 AMP_IMAGE_DIMENSIONS_REQUIRED:'Додайте ширину й висоту зображень або вимкніть AMP для цього проєкту.',
 AMP_UNSUPPORTED_URL:'Для AMP потрібні повні HTTPS-посилання. Перевірте адреси ресурсів і кнопок.',
 AMP_PAYLOAD_LIMIT:'Сторінка завелика для цього AMP-режиму. Використайте звичайну публікацію.',
 AMP_VALIDATOR_UNAVAILABLE:'Ресурси AMP-валідатора недоступні або пошкоджені. Вимкніть AMP чи відновіть збірку PagePoster.',
 AMP_PLUGIN_REQUIRED:'Для AMP потрібен браузерний режим WordPress і підтримка Clean Links 1.2.1 на сайті.',
 AMP_INVALID_SOURCE:'Матеріал не вдалося підготувати як AMP. Початковий HTML збережено.',
 AMP_ALREADY_PRESENT:'HTML уже містить AMP-копію. Повторне додавання не виконується.',
 AMP_INVALID_SCHEMA:'Перевірте структуровані дані JSON-LD у вихідному HTML.',
 AMP_EMPTY_CONTENT:'У матеріалі немає текстового вмісту для AMP.'
}[code]||'';}
export const AMP_BOILERPLATE='body{-webkit-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-moz-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-ms-animation:-amp-start 8s steps(1,end) 0s 1 normal both;animation:-amp-start 8s steps(1,end) 0s 1 normal both}@-webkit-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-moz-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-ms-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-o-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}';
const tags=new Set('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var amp-img'.split(' '));
const attrs=new Set('id class title lang dir role aria-label aria-hidden aria-expanded aria-controls href target rel width height src alt layout colspan rowspan scope span start reversed open datetime'.split(' '));
const compactStyles=`
html,body{margin:0;padding:0;background:#fff;color:#18243a;font:16px/1.65 system-ui,sans-serif}
*{box-sizing:border-box}body{overflow-wrap:anywhere}
main,article,.pp-shell{max-width:70rem;margin-inline:auto;padding:1rem}
header,footer{padding:1rem;background:#edf2f7}
nav{display:flex;flex-wrap:wrap;gap:.75rem}
h1,h2,h3{line-height:1.18;margin:1.5em 0 .5em}h1{font-size:clamp(1.9rem,4vw,3rem)}
section{margin-block:2rem}a{color:#164795;text-underline-offset:.14em}
a[class*="button"],a[class*="btn"],a[class*="cta"]{display:inline-block;padding:.6rem .9rem;background:#164795;color:#fff;border-radius:.4rem}
table{display:block;overflow-x:auto;width:100%;border-collapse:collapse}
th,td{padding:.65rem;border:1px solid #dce4ee;text-align:left}
th,aside,details{background:#f3f6fa}aside,details{padding:.8rem;margin:.65rem 0}
summary{cursor:pointer;font-weight:650}amp-img{max-width:100%}pre{overflow:auto}
`;
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const fail=code=>{throw Object.assign(Error(code),{code});};
const safeUrl=(value,{fragment=false}={})=>{
 if(fragment&&/^#[^\s<>]*$/.test(value))return value;
 let url;try{url=new URL(value);}catch{fail('AMP_UNSUPPORTED_URL');}
 if(url.protocol!=='https:'||url.username||url.password)fail('AMP_UNSUPPORTED_URL');return url.href;
};

export function buildAmpPayload({html,title,language='en'}){
 if(typeof html!=='string'||!html.trim()||Buffer.byteLength(html)>1000000||typeof title!=='string'||!title.trim())fail('AMP_INVALID_SOURCE');
 const dom=new JSDOM(html),doc=dom.window.document;
 try{
  if(doc.querySelector('iframe,form,input,select,textarea,video,audio,object,embed,canvas,svg,math'))fail('AMP_UNSUPPORTED_CONTENT');
  if(doc.querySelector('link[rel~="stylesheet"]'))fail('AMP_EXTERNAL_STYLES_REQUIRED');
  const schema=[];for(const node of doc.querySelectorAll('script[type="application/ld+json"]')){try{const value=JSON.parse(node.textContent);if(value&&typeof value==='object')schema.push(value);}catch{fail('AMP_INVALID_SCHEMA');}}
  if(schema.length>20)fail('AMP_INVALID_SCHEMA');
  let css=Array.from(doc.querySelectorAll('style'),node=>node.textContent).join('\n');
  if(/<|@import\b|expression\s*\(|javascript\s*:/i.test(css))fail('AMP_UNSUPPORTED_CSS');
  let tree;try{tree=cssTree.parse(css,{onParseError:()=>fail('AMP_UNSUPPORTED_CSS')});}catch{fail('AMP_UNSUPPORTED_CSS');}
  cssTree.walk(tree,{visit:'Atrule',enter(node,item,list){if(node.name==='layer'&&list){if(node.block)list.replace(item,node.block.children);else list.remove(item);}}});
  // Bundled fonts consume most of the AMP CSS allowance. Let the existing
  // font-family fallback apply in the lighter document.
  cssTree.walk(tree,{visit:'Atrule',enter(node,item,list){
   if(node.name!=='font-face'||!list)return;
   let embedded=false;cssTree.walk(node,{visit:'Url',enter(url){if(/^data:/i.test(url.value))embedded=true;}});
   if(embedded)list.remove(item);
  }});
  cssTree.walk(tree,{visit:'Url',enter(node){safeUrl(node.value);}});
  cssTree.walk(tree,{visit:'Declaration',enter(node){node.important=false;if(['position','inset','z-index'].includes(node.property)&&node.property==='position'&&cssTree.generate(node.value)==='fixed')node.value=cssTree.parse('static',{context:'value'});}});
  css=cssTree.generate(tree)+'html,body{margin:0;padding:0}#pp-landing#pp-landing#pp-landing{position:static;inset:auto;overflow:visible;min-height:100vh}amp-img{max-width:100%}';
  let inline=0;
  for(const node of doc.querySelectorAll('script,style,link,meta,base,template,noscript'))node.remove();
  for(const original of Array.from(doc.body.querySelectorAll('*'))){
   if(!original.isConnected)continue;let node=original;
   if(node.localName==='button'){
    const destination=node.getAttribute('data-pp-url');if(!destination)fail('AMP_UNSUPPORTED_INTERACTION');
    const link=doc.createElement('a');for(const attribute of Array.from(node.attributes))link.setAttribute(attribute.name,attribute.value);link.setAttribute('href',safeUrl(destination));link.innerHTML=node.innerHTML;node.replaceWith(link);node=link;
   }
   if(node.localName==='img'){
    const width=Number(node.getAttribute('width')),height=Number(node.getAttribute('height'));
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)fail('AMP_IMAGE_DIMENSIONS_REQUIRED');
    const image=doc.createElement('amp-img');for(const attribute of Array.from(node.attributes))image.setAttribute(attribute.name,attribute.value);image.setAttribute('layout','responsive');node.replaceWith(image);node=image;
   }
   if(!tags.has(node.localName))fail('AMP_UNSUPPORTED_CONTENT');
   const controlled=node.getAttribute('data-pp-url');if(controlled){if(node.localName!=='a')fail('AMP_UNSUPPORTED_INTERACTION');node.setAttribute('href',safeUrl(controlled));}
   const target=node.getAttribute('data-pp-target')||node.getAttribute('target');if(node.localName==='a'&&target)node.setAttribute('target',target==='_blank'?'_blank':'_top');
   const style=node.getAttribute('style');if(style){
    if(/<|expression\s*\(|javascript\s*:|url\s*\(/i.test(style))fail('AMP_UNSUPPORTED_CSS');
    let declarations;try{declarations=cssTree.parse(style,{context:'declarationList',onParseError:()=>fail('AMP_UNSUPPORTED_CSS')});}catch{fail('AMP_UNSUPPORTED_CSS');}
    cssTree.walk(declarations,{visit:'Declaration',enter(value){value.important=false;if(value.property==='position'&&cssTree.generate(value.value)==='fixed')value.value=cssTree.parse('static',{context:'value'});}});
    const name='pp-amp-inline-'+(++inline);node.classList.add(name);css+='.'+name+'{'+cssTree.generate(declarations)+'}';
   }
   for(const attribute of Array.from(node.attributes))if(!attrs.has(attribute.name))node.removeAttribute(attribute.name);
   for(const name of ['href','src'])if(node.hasAttribute(name))node.setAttribute(name,safeUrl(node.getAttribute(name),{fragment:name==='href'}));
   if(node.getAttribute('target')==='_blank')node.setAttribute('rel','noopener noreferrer');
  }
  const compact=Buffer.byteLength(css)>75000;
  if(compact)css=compactStyles;
  if(css.includes('\\'))fail('AMP_UNSUPPORTED_CSS');
  const body=doc.body.innerHTML;if(!doc.body.textContent.trim())fail('AMP_EMPTY_CONTENT');
  const payload={version:1,title:title.slice(0,500),language:/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)?language:'en',css,body,schema,...(compact?{styleMode:'compact'}:{})};
  if(Buffer.byteLength(JSON.stringify(payload))>650000)fail('AMP_PAYLOAD_LIMIT');return payload;
 }finally{dom.window.close();}
}

export function appendAmpPayload(html,payload){
 if(/\bdata-pp-amp\s*=/i.test(html))fail('AMP_ALREADY_PRESENT');
 const marker='<div hidden data-pp-amp="'+Buffer.from(JSON.stringify(payload),'utf8').toString('base64')+'"></div>';
 if(Buffer.byteLength(html+marker)>1000000)fail('AMP_PAYLOAD_LIMIT');return html+marker;
}

export function refreshAmpPayload(html){
 if(!/\bdata-pp-amp\s*=/i.test(html))return html;
 const matches=[...html.matchAll(/<div\s+hidden(?:="")?\s+data-pp-amp="([A-Za-z0-9+/=]+)"\s*>\s*<\/div>/gi)];
 if(matches.length!==1)fail('AMP_INVALID_SOURCE');
 const match=matches[0];let previous;try{previous=JSON.parse(Buffer.from(match[1],'base64').toString('utf8'));}catch{fail('AMP_INVALID_SOURCE');}
 const source=html.slice(0,match.index)+html.slice(match.index+match[0].length);
 const payload=buildAmpPayload({html:source,title:previous.title,language:previous.language});
 validateAmpDocument(renderAmpDocument(payload,'https://pageposter.invalid/amp-validation/'));
 const marker=appendAmpPayload('',payload);
 return html.slice(0,match.index)+marker+html.slice(match.index+match[0].length);
}

export function renderAmpDocument(payload,canonical){
 canonical=safeUrl(canonical);
 return '<!doctype html><html amp lang="'+escape(payload.language)+'"><head><meta charset="utf-8"><script async src="https://cdn.ampproject.org/v0.js"></script><title>'+escape(payload.title)+'</title><link rel="canonical" href="'+escape(canonical)+'"><meta name="viewport" content="width=device-width,minimum-scale=1,initial-scale=1"><style amp-boilerplate>'+AMP_BOILERPLATE+'</style><noscript><style amp-boilerplate>body{-webkit-animation:none;-moz-animation:none;-ms-animation:none;animation:none}</style></noscript><style amp-custom>'+payload.css+'</style>'+payload.schema.map(value=>'<script type="application/ld+json">'+JSON.stringify(value).replaceAll('<','\\u003c')+'</script>').join('')+'</head><body>'+payload.body+'</body></html>';
}
