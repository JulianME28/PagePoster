'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto');
const loaded=import('../server/lifecycle/secrets.mjs'), key=()=>randomBytes(32).toString('base64');
test('requires canonical base64 256-bit key without a fallback',async()=>{
 const {createSecretBox}=await loaded;
 for(const bad of [undefined,'','bad',key()+'\n',randomBytes(16).toString('base64')]) assert.throws(()=>createSecretBox(bad),{code:'VALIDATION'});
});
test('fresh AES-GCM envelopes are bound to site ID and master key',async()=>{
 const {createSecretBox}=await loaded,box=createSecretBox(key()),c={username:'private-user',applicationPassword:'private-password'};
 const a=box.encrypt('site-A',c),b=box.encrypt('site-A',c);
 assert.notDeepEqual(a,b);assert.doesNotMatch(JSON.stringify(a),/private-/);assert.deepEqual(box.decrypt('site-A',a),c);
 assert.throws(()=>box.decrypt('site-B',a),{code:'SECRET_DECRYPT_FAILED'});
 assert.throws(()=>createSecretBox(key()).decrypt('site-A',a),{code:'SECRET_DECRYPT_FAILED'});
});
test('tampering fails without disclosing secrets',async()=>{
 const {createSecretBox}=await loaded,box=createSecretBox(key()),a=box.encrypt('site-A',{username:'private-user',applicationPassword:'private-password'});
 for(const bad of [{...a,ciphertext:'AAAA'},{...a,tag:'AAAA'},{...a,version:2},{...a,iv:'bad'}])
  assert.throws(()=>box.decrypt('site-A',bad),e=>e.code==='SECRET_DECRYPT_FAILED'&&!/private|AAAA/.test(e.message));
 assert.throws(()=>box.encrypt('',{username:'a',applicationPassword:'b'}),{code:'VALIDATION'});
});
