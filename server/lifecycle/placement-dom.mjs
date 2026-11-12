import Placements from '../../dist/link-placements.js';
import {JSDOM} from './dom-runtime.mjs';

// Placement operations return plain data. Their temporary DOMParser documents
// must not attach selector listeners to the long-lived rendering window.
export function createScopedPlacementRegistry(){
 const invoke=(method,args)=>{
  let dom;
  const window={get DOMParser(){dom??=new JSDOM('',{url:'https://pageposter.invalid/'});return dom.window.DOMParser;}};
  try{return Placements.create({window})[method](...args);}
  finally{dom?.window.close();}
 };
 return Object.fromEntries(['prepare','list','propose','apply'].map(method=>[method,(...args)=>invoke(method,args)]));
}
