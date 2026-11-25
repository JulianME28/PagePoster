import {getDomain} from 'tldts';

// Catalogue identity only. This function never changes the actual origin that
// a user authorized, any URL allow-list, or a WordPress request destination.
export function donorDomainKey(value){
 const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
 // WordPress.com tenants are independent sites although its public-suffix
 // registration does not currently include every managed hosting product.
 if(host.endsWith('.wordpress.com'))return host.split('.').slice(-3).join('.');
 return getDomain(host,{allowPrivateDomains:true})||host;
}
