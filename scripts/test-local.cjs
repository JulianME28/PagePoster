'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'tests');
const files=fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>name.endsWith('.test.cjs')).sort():[];
if(!files.length){console.error('No test files found. Restore the tests directory before verifying this checkout.');process.exitCode=1;}
else{
 const child=spawn(process.execPath,['--test','--test-concurrency=2',...files.map(file=>'tests/'+file)],{cwd:root,env:process.env,stdio:'inherit'});
 child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('close',(code,signal)=>{process.exitCode=signal?1:code??1;});
}
