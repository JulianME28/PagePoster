import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let implementation;
const runtime=()=>implementation||(implementation=require('jsdom'));

// Preserve the real DOM objects and their options. Loading the workspace does
// not need jsdom's dependency graph; HTML operations initialize it on demand.
export class JSDOM{
 constructor(...args){return new (runtime().JSDOM)(...args);}
 static fragment(...args){return runtime().JSDOM.fragment(...args);}
 static fromURL(...args){return runtime().JSDOM.fromURL(...args);}
 static fromFile(...args){return runtime().JSDOM.fromFile(...args);}
 static [Symbol.hasInstance](value){return value instanceof runtime().JSDOM;}
}
export class VirtualConsole{
 constructor(...args){return new (runtime().VirtualConsole)(...args);}
 static [Symbol.hasInstance](value){return value instanceof runtime().VirtualConsole;}
}
