import {validatePublicUrl} from './network.mjs';
// A login may move only between the exact bare/www pair, before credentials or
// remote writes. This is not permission to follow arbitrary login redirects.
export function canonicalLoginBase(baseUrl,targetUrl){
 let base,target;try{base=validatePublicUrl(baseUrl);target=validatePublicUrl(targetUrl);}catch{return null;}
 const bare=host=>host.startsWith('www.')?host.slice(4):host;
 if(base.origin===target.origin||base.port!==target.port||bare(base.hostname)!==bare(target.hostname)||base.hostname.startsWith('www.')===target.hostname.startsWith('www.')||target.pathname!==new URL('wp-login.php',base).pathname||target.hash||target.searchParams.has('action')||target.searchParams.has('action2'))return null;
 const canonical=new URL(base.href);canonical.host=target.host;canonical.hash='';canonical.search='';return canonical.href;
}

// Only an intercepted GET redirect from the current login endpoint may discover
// a child installation. A page's form action alone never authorizes this move.
export function redirectedLoginBase(baseUrl,fromUrl,targetUrl){
 let base,from,target;try{base=validatePublicUrl(baseUrl);from=validatePublicUrl(fromUrl);target=validatePublicUrl(targetUrl);}catch{return null;}
 const bare=host=>host.startsWith('www.')?host.slice(4):host;
 if(from.origin!==base.origin||from.pathname!==new URL('wp-login.php',base).pathname||from.hash||from.searchParams.has('action')||from.searchParams.has('action2')||target.port!==base.port||bare(target.hostname)!==bare(base.hostname)||target.hash||target.searchParams.has('action')||target.searchParams.has('action2')||!target.pathname.endsWith('/wp-login.php'))return null;
 const directory=target.pathname.slice(0,-'wp-login.php'.length);
 if(!directory.startsWith(base.pathname)||!/^\/(?:[A-Za-z0-9._~-]+\/){0,8}$/.test(directory))return null;
 const canonical=new URL(target.href);canonical.pathname=directory;canonical.search='';canonical.hash='';
 return canonical.href===base.href?null:canonical.href;
}

export function canonicalLoginProofBase(baseUrl,proof){
 if(!proof||proof.requestedBaseUrl!==baseUrl)return null;
 let initial,final;try{initial=validatePublicUrl(baseUrl);final=validatePublicUrl(proof.baseUrl);}catch{return null;}
 if(proof.steps===undefined)return canonicalLoginBase(initial.href,new URL('wp-login.php',final).href)===final.href?final.href:null;
 if(!Array.isArray(proof.steps)||!proof.steps.length||proof.steps.length>8)return null;
 let current=initial.href;
 for(const step of proof.steps){
  if(!step||typeof step.from!=='string'||typeof step.to!=='string')return null;
  let from;try{from=validatePublicUrl(step.from);}catch{return null;}
  if(from.origin!==new URL(current).origin||from.pathname!==new URL('wp-login.php',current).pathname||from.hash||from.searchParams.has('action')||from.searchParams.has('action2'))return null;
  const next=step.kind==='redirect'?redirectedLoginBase(current,step.from,step.to):step.kind==='form'?canonicalLoginBase(current,step.to):null;
  if(!next)return null;current=next;
 }
 return current===final.href?current:null;
}
