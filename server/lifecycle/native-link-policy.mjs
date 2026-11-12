import {JSDOM} from './dom-runtime.mjs';

// Editorial exports reserve a native link in each destination group. Derive
// public expectations from the committed snapshot, never the fetched page.
export function expectedNativeCounts(html){
 const counts=new Map();if(typeof html!=='string'||!html.includes('pp-editorial-v2'))return counts;
 const dom=new JSDOM(html);
 try{
  const root=dom.window.document.querySelector('#pp-landing.pp-editorial-v2');if(!root)return counts;
  const groups=new Map();
  for(const node of root.querySelectorAll('a[href],[data-pp-url]')){
   const literal=node.getAttribute('data-pp-url')||node.getAttribute('href');
   if(!/^https?:\/\//i.test(literal||''))continue;
   try{const url=new URL(literal);if(!url.hostname||url.username||url.password)continue;}catch{continue;}
   if(!groups.has(literal))groups.set(literal,new Set());
   groups.get(literal).add(node.closest('header,footer')?'chrome':'content');
  }
  for(const [url,group] of groups)counts.set(url,group.size);
  return counts;
 }finally{dom.window.close();}
}
