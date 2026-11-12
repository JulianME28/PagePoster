import {JSDOM} from './dom-runtime.mjs';

const ambiguous=()=>{throw Object.assign(Error('NATIVE_EDITOR_UNAVAILABLE'),{code:'NATIVE_EDITOR_UNAVAILABLE'});};
function postId(value){
 if(typeof value!=='string'||!/^\d+$/.test(value)||value[0]==='0')return null;
 const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null;
}
function field(form,name){
 const values=[...form.querySelectorAll('input[name="'+name+'"]')].map(input=>input.getAttribute('value')??'');
 if(new Set(values).size>1)ambiguous();
 return values[0]??null;
}
function classicId(form){
 const id=field(form,'post_ID'),type=field(form,'post_type');
 return type==='page'?postId(id):null;
}

// A deliberately limited lexer for the core inline initializer, never an
// interpreter. Strings/comments cannot contribute calls. Regex, division and
// interpolated templates are outside that core shape and fail closed.
function tokens(source){
 const out=[];let i=0;
 while(i<source.length){
  const char=source[i];
  if(/\s/.test(char)){i++;continue;}
  if(source.startsWith('//',i)||source.startsWith('<!--',i)||source.startsWith('-->',i)){
   while(i<source.length&&!/[\r\n\u2028\u2029]/.test(source[i]))i++;
   continue;
  }
  if(source.startsWith('/*',i)){
   const end=source.indexOf('*/',i+2);if(end<0)return null;i=end+2;continue;
  }
  if(char==='/'||char==='\\')return null;
  if(char==='"'||char==="'"||char==='`'){
   const quote=char,start=++i;let escaped=false;
   while(i<source.length&&source[i]!==quote){
    if(quote==='`'&&source.startsWith('${',i))return null;
    if(quote!=='`'&&/[\r\n\u2028\u2029]/.test(source[i]))return null;
    if(source[i]==='\\'){escaped=true;i+=2;}else i++;
   }
   if(i>=source.length)return null;
   out.push({kind:quote==='`'?'template':'string',value:source.slice(start,i),escaped});i++;continue;
  }
  const identifier=source.slice(i).match(/^[A-Za-z_$][\w$]*/);
  if(identifier){out.push({kind:'identifier',value:identifier[0]});i+=identifier[0].length;continue;}
  const number=source.slice(i).match(/^\d+/);
  if(number){out.push({kind:'number',value:number[0]});i+=number[0].length;continue;}
  if(char.charCodeAt(0)>127)return null;
  out.push({kind:'punctuation',value:char});i++;
 }
 return out;
}
function argumentsAt(list,start){
 const stack=['('],args=[];let from=start+1;
 const pairs={')':'(',']':'[','}':'{'};
 for(let i=from;i<list.length;i++){
  const token=list[i];if(token.kind!=='punctuation')continue;
  if(['(','[','{'].includes(token.value))stack.push(token.value);
  else if(Object.hasOwn(pairs,token.value)){
   if(stack.pop()!==pairs[token.value])return null;
   if(!stack.length){args.push(list.slice(from,i));return args.every(arg=>arg.length)?args:null;}
  }else if(token.value===','&&stack.length===1){args.push(list.slice(from,i));from=i+1;}
 }
 return null;
}
function blockId(script){
 const type=(script.getAttribute('type')||'').trim().toLowerCase();
 if(script.hasAttribute('src')||type&&!['text/javascript','application/javascript'].includes(type))return null;
 const list=tokens(script.textContent);if(!list)return null;
 const calls=[],is=(index,kind,value)=>list[index]?.kind===kind&&list[index].value===value;
 for(let i=0;i<list.length;i++){
  if(is(i-1,'punctuation','.')||is(i-1,'identifier','new'))continue;
  if(is(i,'identifier','wp')&&is(i+1,'punctuation','.')&&is(i+2,'identifier','editPost')&&is(i+3,'punctuation','.')&&is(i+4,'identifier','initializeEditor')&&is(i+5,'punctuation','('))calls.push(i+5);
 }
 if(calls.length>1)ambiguous();if(!calls.length)return null;
 const args=argumentsAt(list,calls[0]);if(!args||args.length<4)return null;
 const literal=(arg,value)=>arg.length===1&&arg[0].kind==='string'&&!arg[0].escaped&&arg[0].value===value;
 if(!literal(args[0],'editor')||!literal(args[1],'page')||args[2].length!==1||args[2][0].kind!=='number')return null;
 return postId(args[2][0].value);
}

// Recovery identity only: the caller must gate the main Add New HTML response
// and independently verify editor status/content before dispatching publication.
export function readNativeDraftId(html){
 if(typeof html!=='string'||!html)return null;
 // JSDOM's defaults do not execute scripts or fetch subresources.
 const dom=new JSDOM(html);
 try{
  const document=dom.window.document,forms=[...document.querySelectorAll('form#post')],scripts=[...document.querySelectorAll('script#wp-edit-post-js-after')];
  if(forms.length>1||scripts.length>1)ambiguous();
  const classic=forms.length?classicId(forms[0]):undefined,block=scripts.length?blockId(scripts[0]):undefined;
  if(classic===null||block===null)return null;
  if(classic!==undefined&&block!==undefined&&classic!==block)ambiguous();
  return classic??block??null;
 }finally{dom.window.close();}
}
