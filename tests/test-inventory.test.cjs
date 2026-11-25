'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('public test command refuses a checkout without actual tests',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-empty-tests-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'scripts'));
 fs.copyFileSync(path.join(__dirname,'../scripts/test-local.cjs'),path.join(root,'scripts/test-local.cjs'));
 const output=spawnSync(process.execPath,[path.join(root,'scripts/test-local.cjs')],{encoding:'utf8'});assert.equal(output.status,1);assert.match(output.stderr,/No test files/);assert.doesNotMatch(output.stdout,/tests 0/);
});
