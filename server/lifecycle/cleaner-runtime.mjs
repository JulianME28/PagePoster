import {createHash} from 'node:crypto';

// Frozen executable bytes from Clean Links 1.1.3's PHP heredoc. Only its JSON
// host argument varies. The composed PHP test catches packaged-template drift.
const template=String.raw`(function(hosts){
 'use strict';
 var roots='div#pp-landing,div#pp-universal-pl';
 function own(el){for(var n=el;n&&n.nodeType===1;n=n.parentElement){if(n.tagName==='DIV'&&(n.id==='pp-landing'||n.id==='pp-universal-pl'))return true;}return false;}
 function normalize(host){return host.toLowerCase().replace(/\.$/,'').replace(/^www\./,'');}
 function clean(el){
  if(!el||!/^(A|AREA)$/.test(el.tagName)||own(el))return;
  var href=el.getAttribute('href');if(href===null)return;
  var compact=href.replace(/[\x00-\x20]/g,''),remove=/^(javascript|mailto|tel):/i.test(compact);
  if(!remove&&/^(https?:)?\/\//i.test(compact)){
   var link=document.createElement('a');link.href=compact;
   remove=!!link.hostname&&hosts.indexOf(normalize(link.hostname))===-1;
  }
  if(remove){el.removeAttribute('href');el.removeAttribute('ping');}
 }
 function scan(node){
  if(!node||node.nodeType!==1||own(node))return;
  clean(node);var links=node.querySelectorAll('a[href],area[href]');
  for(var i=0;i<links.length;i++)clean(links[i]);
 }
 if(!document.querySelector(roots))return;
 scan(document.documentElement);
 if(window.MutationObserver)new MutationObserver(function(records){
  for(var i=0;i<records.length;i++){
   var r=records[i];
   if(r.type==='attributes')clean(r.target);
   else for(var j=0;j<r.addedNodes.length;j++)scan(r.addedNodes[j]);
  }
 }).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href','ping']});
})(__HOSTS__);`;
const [prefix,suffix]=template.split('__HOSTS__');
export function cleanerRuntimeHash(script,url){
 if(typeof script!=='string'||!script.startsWith(prefix)||!script.endsWith(suffix))return null;
 const literal=script.slice(prefix.length,script.length-suffix.length);
 if(literal.length>520)return null;
 let hosts,host;try{hosts=JSON.parse(literal);host=new URL(url).hostname.toLowerCase().replace(/\.+$/,'').replace(/^www\./,'');}catch{return null;}
 // The plugin emits precisely home_url and site_url hosts. Different origins
 // cannot be authenticated from an anonymous response, so remain unsupported.
 if(!Array.isArray(hosts)||hosts.length!==2||hosts.some(value=>typeof value!=='string'||value!==host)||JSON.stringify(hosts)!==literal)return null;
 return createHash('sha256').update(script).digest('base64');
}

export async function verifyCleanerRuntime(page){
 return page.evaluate(async()=>{
  const probe=document.createElement('div');probe.hidden=true;
  const external=document.createElement('a'),contact=document.createElement('a'),local=document.createElement('a'),own=document.createElement('div'),retained=document.createElement('a');
  own.id='pp-universal-pl';external.href='https://pageposter-cleaner-probe.invalid/';external.setAttribute('ping','https://pageposter-cleaner-probe.invalid/');contact.href='mailto:probe@example.invalid';local.href=location.origin+'/';retained.href=external.href;
  own.append(retained);probe.append(external,contact,local,own);document.body.append(probe);
  try{await Promise.resolve();return !external.hasAttribute('href')&&!external.hasAttribute('ping')&&!contact.hasAttribute('href')&&local.getAttribute('href')===location.origin+'/'&&retained.getAttribute('href')==='https://pageposter-cleaner-probe.invalid/';}
  finally{probe.remove();}
 });
}
