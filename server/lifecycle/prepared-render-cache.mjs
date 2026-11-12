import {serialize,deserialize} from 'node:v8';

const MAX_ENTRIES=128,MAX_BYTES=16*1024*1024;
// Stored configurations are JSON data. Unsupported shapes bypass this optional
// optimization, so accessors, omitted values or prototypes cannot collide with
// a different input's serialized key. Output may additionally contain undefined.
function plainData(value,allowUndefined=false){
 try{
 const pending=[value],seen=new Set();let visited=0;
 while(pending.length){
  if(++visited>100000)return false;
  const current=pending.pop();
  if(current===undefined){if(!allowUndefined)return false;continue;}
  if(current===null||typeof current==='string'||typeof current==='boolean')continue;
  if(typeof current==='number'){if(!Number.isFinite(current)||!allowUndefined&&Object.is(current,-0))return false;continue;}
  if(typeof current!=='object'||seen.has(current)||Object.getOwnPropertySymbols(current).length)return false;
  seen.add(current);const array=Array.isArray(current),prototype=Object.getPrototypeOf(current);
  if(prototype!==(array?Array.prototype:Object.prototype))return false;
  const descriptors=Object.getOwnPropertyDescriptors(current),keys=Object.keys(descriptors).filter(key=>!array||key!=='length');
  if(array&&(keys.length!==current.length||keys.some((key,index)=>key!==String(index))))return false;
  for(const key of keys){const descriptor=descriptors[key];if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))return false;pending.push(descriptor.value);}
 }
 return true;
 }catch{return false;}
}

// One bounded cache per store instance; no page, run, approval or live guard is
// retained. The caller must freshly derive every authorization binding.
export function createPreparedRenderCache(compute,canReuse=()=>true){
 if(typeof compute!=='function')throw new TypeError('A pure render function is required.');
 const trusted=config=>{try{return canReuse(config)===true;}catch{return false;}};
 const stores=new WeakMap();
 return (store,config)=>{
  if(!store||!['object','function'].includes(typeof store)||!plainData(config)||!trusted(config))return compute(config);
  let key;try{key=JSON.stringify(config);}catch{return compute(config);}
  if(typeof key!=='string')return compute(config);
  const keyBytes=Buffer.byteLength(key);if(keyBytes>MAX_BYTES)return compute(config);
  let cache=stores.get(store);const previous=cache?.entries.get(key);
  if(previous){cache.entries.delete(key);cache.entries.set(key,previous);return deserialize(previous.value);}
  const result=compute(config); // Errors propagate unchanged and are never cached.
  if(!trusted(config)||!plainData(result,true))return result;
  let value;try{value=serialize(result);}catch{return result;}
  const size=keyBytes+value.length;if(size>MAX_BYTES)return result;
  if(!cache){cache={entries:new Map(),bytes:0};stores.set(store,cache);}
  while(cache.entries.size>=MAX_ENTRIES||cache.bytes+size>MAX_BYTES){const oldest=cache.entries.keys().next().value;cache.bytes-=cache.entries.get(oldest).size;cache.entries.delete(oldest);}
  cache.entries.set(key,{value,size});cache.bytes+=size;
  return deserialize(value);
 };
}
