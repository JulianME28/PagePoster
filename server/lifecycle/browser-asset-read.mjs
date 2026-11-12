import {validatePublicUrl} from './network.mjs';

export function isBrowserStaticRead({url,baseUrl,method,resourceType}){
 if(method!=='GET'||!['script','stylesheet'].includes(resourceType))return false;
 let target,base,suffix;try{target=validatePublicUrl(url);base=validatePublicUrl(baseUrl);suffix=decodeURIComponent(target.pathname.slice(base.pathname.length));}catch{return false;}
 if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname)||target.hash||/%(?:2f|5c)/i.test(target.pathname)||/[\\\u0000-\u001f\u007f]/.test(suffix)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(suffix))return false;
 const bundle=resourceType==='script'?'wp-admin/load-scripts.php':'wp-admin/load-styles.php';
 if(suffix===bundle)return [...target.searchParams.keys()].every(key=>['c','dir','ver'].includes(key)||/^load(?:\[(?:chunk_\d+)?\])?$/.test(key));
 const extension=resourceType==='script'?'js':'css';
 return new RegExp('^wp-(?:includes|content)/.+\\.'+extension+'$').test(suffix)&&!/\.php\d*(?:[./;]|$)/i.test(suffix)&&[...target.searchParams.keys()].every(key=>['ver','v','version'].includes(key));
}

// A failed core script must be recovered before Chromium starts dependent
// scripts. Only a known read-only static resource gets one additional attempt;
// editor navigation, REST and every write remain single-dispatch operations.
export async function retryBrowserAssetRead(load,input){
 try{return await load();}
 catch(error){if(input?.signal?.aborted||!['network_timeout','network_failed'].includes(error.code)||!isBrowserStaticRead(input||{}))throw error;return load();}
}
