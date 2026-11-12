const browserKind='browser-login';
const fail=()=>{throw Object.assign(Error('Stored credentials could not be authenticated.'),{code:'SECRET_DECRYPT_FAILED'});};

// The type lives inside the existing encrypted-envelope column. New browser
// credentials authenticate a distinct AAD, so removing the outer type cannot
// turn an ordinary login password into an API credential.
export function unpackSiteCredential(siteId,stored,site){
 if(!stored||typeof stored!=='object'||Array.isArray(stored))fail();
 if(Object.hasOwn(stored,'credentialKind')||Object.hasOwn(stored,'envelope')){
  if(stored.credentialKind!==browserKind||Object.keys(stored).length!==2||!stored.envelope||typeof stored.envelope!=='object')fail();
  return {kind:browserKind,envelope:stored.envelope,aad:siteId+':browser',wrapped:true};
 }
 return {kind:site?.bootstrap?.mode==='browser'?browserKind:'api',envelope:stored,aad:siteId,wrapped:false};
}
export function encryptSiteCredential(box,siteId,credentials,browser=false){
 return browser?{credentialKind:browserKind,envelope:box.encrypt(siteId+':browser',credentials)}:box.encrypt(siteId,credentials);
}
export function rekeySiteCredential(oldBox,newBox,siteId,stored,site){
 const value=unpackSiteCredential(siteId,stored,site);
 return encryptSiteCredential(newBox,siteId,oldBox.decrypt(value.aad,value.envelope),value.kind===browserKind);
}
