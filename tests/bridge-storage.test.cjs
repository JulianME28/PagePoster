'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createPHP}=require('./qa/php-runtime.cjs');
const plugin=path.resolve(__dirname,'../wordpress/pageposter-bridge/includes');
async function run(body){
 const php=await createPHP();
 try{
  php.mkdir('/bridge');
  for(const file of fs.readdirSync(plugin))if(file.endsWith('.php'))php.writeFile('/bridge/'+file,fs.readFileSync(path.join(plugin,file)));
  const response=await php.run({code:'<?php require "/bridge/class-contract.php"; require "/bridge/class-database.php"; '+body});
  assert.equal(response.exitCode,0,response.errors);assert.equal(response.errors,'');return JSON.parse(response.text);
 }finally{php.exit();}
}
const tables=['wp_posts','wp_pageposter_bridge_ops','wp_pageposter_bridge_pages'];
const jsonLiteral=value=>JSON.stringify(JSON.stringify(value));
test('native PHP storage policy refuses invisible-trigger assumptions, roles and partial revocations',async()=>{
 const cases=[
  {grants:[],want:false},
  {grants:["GRANT `x, TRIGGER ON *.* TO y`@`%` TO `wp`@`localhost`"],want:false},
  {grants:tables.map(t=>"GRANT SELECT (`x, TRIGGER, y`) ON `site`.`"+t+"` TO 'wp'@'localhost'"),want:false},

  {grants:["GRANT TRIGGER ON `site`.`*` TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGER ON `*`.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGER ON `*`.`*` TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT USAGE ON *.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON `site`.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT `editor_role`@`%` TO `wp`@`localhost`"],want:false},
  {grants:["GRANT ALL PRIVILEGES ON `other`.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT SELECT ON `site`.* TO 'wp'@'localhost'","GRANT 'TRIGGER'@'%' TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGER ON `site`.`wp_posts` TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT ALL PRIVILEGES ON `site`.* TO 'wp'@'localhost'"],want:true},
  {grants:["GRANT SELECT, TRIGGER ON site.* TO 'wp'@'localhost' WITH GRANT OPTION"],want:true},
  {grants:tables.map(t=>"GRANT TRIGGER ON `site`.`"+t+"` TO 'wp'@'localhost'"),want:true},
  {grants:["GRANT ALL PRIVILEGES ON *.* TO 'wp'@'localhost'"],want:true},
  {grants:["GRANT TRIGGER ON *.* TO 'wp'@'localhost'","REVOKE TRIGGER ON `site`.* FROM 'wp'@'localhost'"],want:false},
  {grants:["GRANT ALL PRIVILEGES ON *.* TO 'wp'@'localhost'","REVOKE SELECT ON `unrelated`.* FROM 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGERING ON site.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT SELECT (TRIGGER) ON site.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGER ON `sit%`.* TO 'wp'@'localhost'"],want:false},
  {grants:["GRANT TRIGGER ON `SITE`.* TO 'wp'@'localhost'"],want:false}
 ];
 const actual=await run('$out=[];foreach(json_decode('+jsonLiteral(cases)+',true) as $case)$out[]=\\PagePoster\\Bridge\\Database::hasTriggerVisibility($case["grants"],"site",json_decode('+jsonLiteral(tables)+',true));echo json_encode($out);');
 assert.deepEqual(actual,cases.map(c=>c.want));
});
test('explicit escaped database identifiers are recognized without broadening table or wildcard scope',async()=>{
 const cases=[
  {database:'site_prod',grants:["GRANT TRIGGER ON `site\\_prod`.* TO 'wp'@'localhost'"],want:true},
  {database:'site_prod',grants:["GRANT TRIGGER ON `site_prod`.* TO 'wp'@'localhost'"],want:false},
  {database:'site_prod',grants:["GRANT SELECT ON `site%`.* TO 'wp'@'localhost'","GRANT TRIGGER ON `site_prod`.* TO 'wp'@'localhost'"],want:false},
  {database:'siteXprod',grants:["GRANT TRIGGER ON `site_prod`.* TO 'wp'@'localhost'"],want:false},
  {database:'site',grants:["GRANT TRIGGER ON `site`.`wp_%` TO 'wp'@'localhost'"],want:false},
  {database:'site',grants:["GRANT TRIGGER ON `site`.`wp_posts` TO 'wp'@'localhost'","GRANT TRIGGER ON `site`.`wp_pageposter_bridge_ops` TO 'wp'@'localhost'"],want:false}
 ];
 const actual=await run('$out=[];foreach(json_decode('+jsonLiteral(cases)+',true) as $case)$out[]=\\PagePoster\\Bridge\\Database::hasTriggerVisibility($case["grants"],$case["database"],json_decode('+jsonLiteral(tables)+',true));echo json_encode($out);');
 assert.deepEqual(actual,cases.map(c=>c.want));
});
test('REST readiness and operation gate reject a storage adapter without proven trigger visibility',async()=>{
 const body=String.raw`
class WP_Error {public $code,$message,$data;function __construct($c,$m,$d=[]){$this->code=$c;$this->message=$m;$this->data=$d;}}
function is_wp_error($value){return $value instanceof WP_Error;}
class WP_REST_Response {public $data,$status;function __construct($d,$s=200){$this->data=$d;$this->status=$s;}function header($k,$v){}}
class PagePoster_Clean_Links {const VERSION='1.1.1';const FEATURES=['contact-schemes','exact-wrapper-boundary'];static function is_pageposter_content($x){return true;}}
function get_option($key,$default=false){return $key==='active_plugins'?['pageposter-clean-links/pageposter-clean-links.php']:$default;}
function get_current_user_id(){return 7;}function is_ssl(){return true;}function is_multisite(){return false;}
function current_user_can($cap,...$args){return true;}
function get_post_type_object($type){return(object)['cap'=>(object)['create_posts'=>'edit_pages','edit_posts'=>'edit_pages','publish_posts'=>'publish_pages']];}
class Request {function get_body(){return json_encode(['operationId'=>'b8ebccf8-2ee1-4a43-b7ef-1784e024646d','kind'=>'create','postType'=>'page','title'=>'Safe','content'=>'<div id="pp-landing">Safe</div>','status'=>'draft']);}function get_header($name){return 'application/json';}function get_json_params(){return json_decode($this->get_body(),true);}}
class VisibilityAdapter {
 public $began=false;
 function ready(){return \PagePoster\Bridge\Database::hasTriggerVisibility(["GRANT SELECT,INSERT,UPDATE,CREATE ON site.* TO 'wp'@'localhost'"],'site',['wp_posts','wp_pageposter_bridge_ops','wp_pageposter_bridge_pages']);}
 function reasons(){return ['Trigger visibility cannot be verified.'];}
 function begin(){$this->began=true;throw new RuntimeException('must not begin');}
 function close(){}
}
require '/bridge/class-engine.php';require '/bridge/class-rest.php';
$db=new VisibilityAdapter;$rest=new \PagePoster\Bridge\Rest(function()use($db){return $db;});
$rest->captureApplicationPassword((object)['ID'=>7],['uuid'=>'valid']);
$status=$rest->status(new Request);$operation=$rest->operation(new Request);
echo json_encode([$status,$operation,$db->began]);
`;
 const result=await run(body);
 assert.equal(result[0].data.ready,false);assert.equal(result[0].data.capabilities.create,false);
 assert.equal(result[1].code,'pp_bridge_unsupported_storage');assert.equal(result[2],false);
});
