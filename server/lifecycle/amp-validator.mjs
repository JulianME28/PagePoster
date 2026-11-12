import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
let loading,validator;
const checksum='f1f4629ab36f555f5a9937a5cf00f0ef780bf025883c035d06389b151c896f26';
export function initializeAmpValidator(){
 if(!loading)loading=(async()=>{
  const code=await readFile(new URL('../../assets/amp/validator_wasm.js',import.meta.url));
  if(createHash('sha256').update(code).digest('hex')!==checksum)throw Object.assign(Error('AMP validator integrity mismatch'),{code:'AMP_VALIDATOR_UNAVAILABLE'});
  const context=vm.createContext({console:{log(){},warn(){},error(){}},TextEncoder,TextDecoder,WebAssembly,setTimeout,clearTimeout});
  vm.runInContext(code.toString('utf8'),context,{timeout:15000});await context.amp.validator.init();validator=context.amp.validator;
 })().catch(error=>{loading=null;throw Object.assign(Error('AMP validator unavailable'),{code:'AMP_VALIDATOR_UNAVAILABLE',cause:error});});
 return loading;
}
export function validateAmpDocument(html){
 if(!validator)throw Object.assign(Error('AMP validator not initialized'),{code:'AMP_VALIDATOR_UNAVAILABLE'});
 const result=validator.validateString(html);
 if(result.status!=='PASS')throw Object.assign(Error('AMP validation failed'),{code:'AMP_VALIDATION_FAILED',ampIssues:Array.from(result.errors).filter(issue=>issue.severity==='ERROR').slice(0,10).map(issue=>({code:issue.code,line:issue.line,col:issue.col}))});
 return {status:'PASS'};
}
