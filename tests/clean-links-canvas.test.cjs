'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const plugin=path.resolve(__dirname,'../wordpress/pageposter-clean-links/pageposter-clean-links.php'),fixture=path.join(__dirname,'fixtures/clean-links-canvas.php');
const qa=path.join(__dirname,'qa'),{createPHP,resolvePHP56}=require('./qa/php-runtime.cjs'),php56=resolvePHP56();
test('canvas renders saved content despite an empty theme without affecting ordinary or protected requests (PHP 5.6)',{skip:!php56},()=>{
 const r=spawnSync(php56,['-n',fixture],{encoding:'utf8',env:{...process.env,PP_CANVAS_PLUGIN:plugin},timeout:30000,windowsHide:true});
 assert.equal(r.status,0,r.stderr||r.stdout);const proof=JSON.parse(r.stdout);assert.equal(proof.passed,true);assert.ok(proof.checks>=23);
});
test('canvas supports current PHP with the real WordPress tag processor',{timeout:60000},async()=>{
 const php=await createPHP();
 try{
  php.mkdir('/plugin');php.mkdir('/plugin/templates');php.writeFile('/plugin/pageposter-clean-links.php',fs.readFileSync(plugin));
  for(const file of fs.existsSync(path.join(path.dirname(plugin),'templates'))?fs.readdirSync(path.join(path.dirname(plugin),'templates')):[])php.writeFile('/plugin/templates/'+file,fs.readFileSync(path.join(path.dirname(plugin),'templates',file)));
  php.mkdir('/vendor');let preload='';for(const name of ['class-wp-html-attribute-token.php','class-wp-html-text-replacement.php','class-wp-html-span.php','class-wp-html-tag-processor.php']){php.writeFile('/vendor/'+name,fs.readFileSync(path.join(qa,'vendor',name)));preload+="require '/vendor/"+name+"';";}
  php.writeFile('/test.php',fs.readFileSync(fixture));const r=await php.run({code:"<?php function wp_kses_uri_attributes(){return array('href','src','action');}"+preload+"putenv('PP_CANVAS_PLUGIN=/plugin/pageposter-clean-links.php');require '/test.php';"});
  assert.equal(r.exitCode,0,r.errors||r.text);assert.equal(JSON.parse(r.text).passed,true);
 }finally{php.exit();}
});
