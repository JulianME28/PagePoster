'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createPHP}=require('./qa/php-runtime.cjs');
const plugin=path.resolve(__dirname,'../wordpress/pageposter-bridge/includes');
test('native Classic Editor is scoped and shares the ledger writer',()=>{
 const main=fs.readFileSync(path.join(plugin,'../pageposter-bridge.php'),'utf8');
 for(const key of ['use_block_editor_for_post','edit_form_after_title','admin_init'])assert.ok(main.includes(key),key);
 const editor=fs.readFileSync(path.join(plugin,'class-native-editor.php'),'utf8');
 for(const key of ['pageposter_operation','pageposter_nonce','pageposter-operation-result','wp_verify_nonce','post.php','executeInput','application/json','JSON_HEX_TAG'])assert.ok(editor.includes(key),key);
 assert.match(editor,/exit;/);assert.doesNotMatch(editor,/wp_insert_post|wp_update_post/);
});
async function phpTest(body,options={}){
 const php=await createPHP();
 try{
  php.mkdir('/bridge');php.mkdir('/bridge/includes');const main=path.join(plugin,'../pageposter-bridge.php');if(fs.existsSync(main))php.writeFile('/bridge/pageposter-bridge.php',fs.readFileSync(main));
  for(const file of fs.readdirSync(plugin))if(file.endsWith('.php'))php.writeFile('/bridge/includes/'+file,fs.readFileSync(path.join(plugin,file)));
  const cleaner=path.resolve(__dirname,'qa/legacy-clean-links');php.mkdir('/plugins');php.mkdir('/plugins/pageposter-clean-links');php.mkdir('/plugins/pageposter-clean-links/compat');
  for(const folder of ['', 'compat/'])for(const file of fs.readdirSync(path.join(cleaner,folder)))if(file.endsWith('.php'))php.writeFile('/plugins/pageposter-clean-links/'+folder+file,fs.readFileSync(path.join(cleaner,folder,file)));
  const code=String.raw`<?php
define('WP_PLUGIN_DIR','/plugins');
class WP_Error {public $code,$message,$data;function __construct($code,$message,$data=[]){$this->code=$code;$this->message=$message;$this->data=$data;}}
class WP_REST_Response {public $data,$status,$headers=[];function __construct($data,$status=200){$this->data=$data;$this->status=$status;}function header($key,$value){$this->headers[$key]=$value;}}
function is_wp_error($v){return $v instanceof WP_Error;}
class PagePoster_Clean_Links {const VERSION='1.1.1';const FEATURES=['contact-schemes','exact-wrapper-boundary'];public static function is_pageposter_content($html){return true;}}
$GLOBALS['active_plugins']=['pageposter-clean-links/pageposter-clean-links.php'];function get_option($key,$default=false){return $key==='active_plugins'?$GLOBALS['active_plugins']:$default;}
$GLOBALS['uid']=7;$GLOBALS['ssl']=true;$GLOBALS['caps']=['read'=>true,'unfiltered_html'=>true,'edit_pages'=>true,'edit_posts'=>true,'edit_post'=>true,'publish_pages'=>true,'publish_posts'=>true];$GLOBALS['routes']=[];
function get_current_user_id(){return $GLOBALS['uid'];}function is_ssl(){return $GLOBALS['ssl'];}function is_multisite(){return false;}
function current_user_can($cap,...$args){return !empty($GLOBALS['caps'][$cap]);}
function get_post_type_object($type){return(object)['cap'=>(object)['create_posts'=>'edit_'.$type.'s','edit_posts'=>'edit_'.$type.'s','publish_posts'=>'publish_'.$type.'s']];}
function register_rest_route($namespace,$route,$args){$GLOBALS['routes'][]=[$namespace,$route,$args];}
function wp_cache_delete($id,$group){}function clean_post_cache($id){}function wp_cache_set_posts_last_changed(){}
class Request {public $params,$body,$type;function __construct($params=[],$body='{}',$type='application/json'){$this->params=$params;$this->body=$body;$this->type=$type;}function get_param($name){return $this->params[$name]??null;}function get_body(){return $this->body;}function get_header($name){return $this->type;}function get_json_params(){return json_decode($this->body,true);}}
class DB {
 public $post=['ID'=>9,'post_type'=>'page','post_title'=>'Stored','post_content'=>'<div id="pp-landing">Stored</div>','post_status'=>'draft','post_modified_gmt'=>'2026-10-14 10:00:00'];
 public $managed=true,$record=null;
 public $ops=[];
 function begin(){}function commit(){}function rollback(){return true;}function lockPost($id){return $this->readPost($id);}
 function claimOperation($id,$owner,$hash,$kind,$token,$time){if(!isset($this->ops[$id]))$this->ops[$id]=['operation_id'=>$id,'owner_id'=>$owner,'payload_hash'=>$hash,'execution_token'=>$token,'kind'=>$kind,'state'=>'pending','created_at'=>$time,'result_json'=>null];return $this->ops[$id];}
 function insertPost($data,$owner,$operation){$this->post=array_merge($this->post,['post_type'=>$data['postType'],'post_title'=>$data['title'],'post_content'=>$data['content'],'post_status'=>$data['status']]);return $this->post;}
 function completeOperation($id,$result,$before){$this->ops[$id]['result_json']=json_encode($result);}
 function ready(){return true;}function reasons(){return [];}function readPost($id){return $id===9?$this->post:null;}function isManaged($id){return $this->managed;}function getOperation($id){return $this->record;}function url($p){return 'https://example.com/?page_id='.$p['ID'];}function close(){}
}
require '/bridge/includes/class-contract.php';require '/bridge/includes/class-engine.php';require '/bridge/includes/class-rest.php';
$db=new DB;$rest=new \PagePoster\Bridge\Rest(function()use($db){return $db;});
`+body;
  const testCode=code.replace("const VERSION='1.1.1'","const VERSION="+JSON.stringify(options.cleanVersion||'1.1.1'));
  const result=await php.run({code:testCode});assert.equal(result.exitCode,0,result.errors);assert.equal(result.errors,'');return options.raw?result.text:JSON.parse(result.text);
 }finally{php.exit();}
}
test('cookie login and insecure transport cannot impersonate Application Password authentication',async()=>{
 const out=await phpTest('$a=$rest->permission();$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$b=$rest->permission();$GLOBALS["ssl"]=false;$c=$rest->permission();$GLOBALS["ssl"]=true;$GLOBALS["uid"]=8;$d=$rest->permission();echo json_encode([$a,$b,$c,$d]);');
 assert.equal(out[0].data.status,401);assert.equal(out[1],true);assert.equal(out[2].data.status,403);assert.equal(out[3].data.status,401);
});
const nativeStubs=String.raw`
require '/bridge/includes/class-native-editor.php';
function is_user_logged_in(){return get_current_user_id()>0;}function wp_verify_nonce($nonce,$action){return $nonce==='validnonce'&&str_starts_with($action,'pageposter-native-');}
function wp_unslash($value){return stripslashes($value);}function status_header($status){}function nocache_headers(){}function wp_json_encode($value,$flags=0){return json_encode($value,$flags);}
$pagenow='post.php';$_SERVER['REQUEST_METHOD']='POST';$_POST=['pageposter_operation'=>'b8ebccf8-2ee1-4a43-b7ef-1784e024646d','pageposter_nonce'=>'validnonce','action'=>'editpost','publish'=>'Publish','post_type'=>'page','post_title'=>'Пряма сторінка','content'=>addslashes('<div id="pp-landing"><script>"</script><p>UTF-8</p></div>')];
$native=new \PagePoster\Bridge\NativeEditor(function()use($db){return $db;},$rest);
`;
test('native Publish uses exact submitted UTF-8 content and exits before the core save handler',async()=>{
 const html=await phpTest(nativeStubs+'$native->submit();echo "CORE_SAVE_MUST_NOT_RUN";',{raw:true});
 assert.doesNotMatch(html,/CORE_SAVE_MUST_NOT_RUN/);const json=html.match(/id="pageposter-operation-result">([^<]+)<\/script>/)?.[1];assert.ok(json);const result=JSON.parse(json);assert.equal(result.status,201);assert.equal(result.data.state,'completed');assert.equal(result.data.status,'publish');assert.equal(result.data.postType,'page');
});
test('shared native writer preserves exact bytes and replays a committed operation once',async()=>{
 const out=await phpTest(nativeStubs+String.raw`$input=['operationId'=>$_POST['pageposter_operation'],'kind'=>'create','postType'=>'page','title'=>$_POST['post_title'],'content'=>wp_unslash($_POST['content']),'status'=>'publish'];$a=$rest->executeInput($db,$input);$b=$rest->executeInput($db,$input);echo json_encode([$a,$b,$db->post,count($db->ops)]);`);
 assert.equal(out[0][0],201);assert.equal(out[1][0],200);assert.equal(out[1][1].replayed,true);assert.equal(out[0][1].postId,out[1][1].postId);assert.equal(out[2].post_title,'Пряма сторінка');assert.equal(out[2].post_content,'<div id="pp-landing"><script>"</script><p>UTF-8</p></div>');assert.equal(out[3],1);
});
test('native invalid nonce, capabilities and UUID return safe structured failures without core save',async()=>{
 for(const [change,status] of [["$_POST['pageposter_nonce']='bad';",403],["$GLOBALS['caps']['unfiltered_html']=false;",403],["$_POST['pageposter_operation']='invalid';",400],["unset($_POST['publish']);",400]]){
  const html=await phpTest(nativeStubs+change+'$native->submit();echo "CORE_SAVE_MUST_NOT_RUN";',{raw:true});assert.doesNotMatch(html,/CORE_SAVE_MUST_NOT_RUN/);assert.equal(JSON.parse(html.match(/id="pageposter-operation-result">([^<]+)<\/script>/)[1]).status,status);
 }
});
test('native Classic Editor filters leave ordinary and custom post editors alone',async()=>{
 const out=await phpTest(nativeStubs+"$_POST=[];$a=$native->blockEditor(true,(object)['post_type'=>'page']);$_GET['pageposter_operation']='b8ebccf8-2ee1-4a43-b7ef-1784e024646d';$b=$native->blockEditor(true,(object)['post_type'=>'page']);$c=$native->blockEditor(true,(object)['post_type'=>'product']);echo json_encode([$a,$b,$c]);");assert.deepEqual(out,[true,false,true]);
});
test('all Bridge REST endpoints use a permission callback and no public write route',async()=>{
 const routes=await phpTest('$rest->registerRoutes();echo json_encode(array_map(function($r){return [$r[0],$r[1],isset($r[2]["permission_callback"])];},$GLOBALS["routes"]));');
 assert.equal(routes.length,5);for(const r of routes){assert.equal(r[0],'pageposter/v1');assert.equal(r[2],true);}
});
test('status exposes explicit write capabilities and missing unfiltered_html disables writes',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$a=$rest->status(new Request);unset($GLOBALS["caps"]["unfiltered_html"]);$b=$rest->status(new Request);echo json_encode([$a,$b]);');
 assert.equal(out[0].data.version,'0.2.1');assert.equal(out[0].data.capabilities.atomicCas,true);assert.equal(out[1].data.capabilities.create,false);assert.equal(out[1].data.capabilities.update,false);
});
test('raw snapshots require current edit permissions and authoritative managed registry',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$a=$rest->page(new Request(["id"=>9]));$db->managed=false;$b=$rest->page(new Request(["id"=>9]));$db->managed=true;unset($GLOBALS["caps"]["edit_post"]);$c=$rest->page(new Request(["id"=>9]));echo json_encode([$a,$b,$c]);');
 assert.equal(out[0].data.content,'<div id="pp-landing">Stored</div>');assert.equal(out[0].headers['Cache-Control'],'no-store');assert.equal(out[1].data.status,403);assert.equal(out[2].data.status,403);
});
test('unknown operation and unsupported body return precise safe errors',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$a=$rest->readOperation(new Request(["id"=>"b8ebccf8-2ee1-4a43-b7ef-1784e024646d"]));$b=$rest->operation(new Request([],"{}","text/plain"));$c=$rest->operation(new Request([],"{broken"));echo json_encode([$a,$b,$c]);');
 assert.equal(out[0].code,'pp_bridge_operation_not_found');assert.equal(out[0].data.status,404);assert.equal(out[1].data.status,415);assert.equal(out[2].data.status,400);
});
test('native adapter uses fixed conditional byte comparisons and a non-retrying transaction path',()=>{
 const source=fs.readFileSync(path.join(plugin,'class-database.php'),'utf8');
 assert.match(source,/FOR UPDATE/);for(const field of ['post_type','post_title','post_content','post_status'])assert.match(source,new RegExp('BINARY '+field+' = BINARY \\\\?'));
 assert.doesNotMatch(source,/\$wpdb->(?:query|insert|update)\s*\(/);
 assert.match(source,/ON DUPLICATE KEY UPDATE operation_id=operation_id/);assert.match(source,/ENGINE=InnoDB/);assert.match(source,/commit\(/);
});

test('plugin bootstrap registers authenticated routes and refuses network activation',async()=>{
 const out=await phpTest('$GLOBALS["hooks"]=[];$GLOBALS["activation"]=null;function add_action($name,$callback,$priority=10,$count=1){$GLOBALS["hooks"][$name]=$callback;}function add_filter($name,$callback,$priority=10,$count=1){$GLOBALS["hooks"][$name]=$callback;}function register_activation_hook($file,$callback){$GLOBALS["activation"]=$callback;}function wp_die($message){throw new RuntimeException($message);}define("ABSPATH","/");require "/bridge/pageposter-bridge.php";$blocked=false;try{($GLOBALS["activation"])(true);}catch(Throwable $e){$blocked=true;}echo json_encode([array_keys($GLOBALS["hooks"]),is_callable($GLOBALS["activation"]),$blocked]);');
 assert.ok(out[0].includes('application_password_did_authenticate'));assert.ok(out[0].includes('rest_api_init'));assert.ok(out[0].includes('rest_post_dispatch'));assert.equal(out[1],true);assert.equal(out[2],true);
});

test('missing Clean Links disables readiness and blocks writes before a transaction',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$a=$rest->status(new Request);$GLOBALS["active_plugins"]=[];$b=$rest->status(new Request);$c=$rest->operation(new Request);$GLOBALS["active_plugins"]=["renamed-folder/pageposter-clean-links.php"];$d=$rest->status(new Request);echo json_encode([$a,$b,$c,$d]);');
 assert.equal(out[0].data.cleanLinksActive,true);assert.equal(out[1].data.cleanLinksActive,false);assert.equal(out[1].data.ready,false);assert.equal(out[1].data.capabilities.create,false);
 assert.equal(out[2].code,'pp_bridge_clean_links_required');assert.equal(out[3].data.cleanLinksActive,false);
});

test('nonstandard database adapters are rejected before opening a private connection',async()=>{
 const out=await phpTest('require_once "/bridge/includes/class-database.php";define("DB_HOST","unused.invalid");define("DB_USER","unused");define("DB_PASSWORD","unused");define("DB_NAME","unused");class CustomAdapter {public $dbh;function __construct(){$this->dbh=mysqli_init();}function parse_db_host($host){throw new RuntimeException("adapter should be rejected first");}}try{\\PagePoster\\Bridge\\Database::connect(new CustomAdapter);$out=["ok"=>true];}catch(\\PagePoster\\Bridge\\Fault $e){$out=["code"=>$e->slug,"status"=>$e->httpStatus];}catch(Throwable $e){$out=["code"=>"unexpected"];}echo json_encode($out);');
 assert.equal(out.code,'pp_bridge_unsupported_storage');assert.equal(out.status,503);
});
test('authenticated inspect reads an unmanaged snapshot without granting mutation or changing bytes',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$db->managed=false;$before=$db->post;$a=$rest->inspect(new Request(["id"=>9]));unset($GLOBALS["caps"]["edit_post"]);$b=$rest->inspect(new Request(["id"=>9]));echo json_encode([$a,$b,$before===$db->post,$db->managed]);');assert.equal(out[0].data.managed,false);assert.equal(out[0].data.canEdit,true);assert.equal(out[1].code,'pp_bridge_forbidden');assert.equal(out[2],true);assert.equal(out[3],false);
});
test('a loaded active Clean Links class with an old version is insufficient for readiness',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);echo json_encode([$rest->status(new Request),$rest->operation(new Request)]);',{cleanVersion:'1.1.0'});assert.equal(out[0].data.cleanLinksVersion,'1.1.0');assert.equal(out[0].data.ready,false);assert.equal(out[1].code,'pp_bridge_clean_links_required');
});


test('authenticated status reports the exact installed PHP bytes rather than version claims',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);echo json_encode($rest->status(new Request));');
 assert.equal(out.data.packageIntegrity?.algorithm,'sha256');
 const cleaner=path.resolve(__dirname,'qa/legacy-clean-links');for(const folder of ['', 'compat/'])for(const file of fs.readdirSync(path.join(cleaner,folder)).filter(name=>name.endsWith('.php')))assert.equal(out.data.packageIntegrity.cleanLinks[folder+file],require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(cleaner,folder,file))).digest('hex'));
 assert.equal(Object.keys(out.data.packageIntegrity.bridge).length,6);assert.equal(Object.keys(out.data.packageIntegrity.cleanLinks).length,6);
 const crypto=require('node:crypto');for(const file of fs.readdirSync(plugin).filter(name=>name.endsWith('.php')))assert.equal(out.data.packageIntegrity.bridge['includes/'+file],crypto.createHash('sha256').update(fs.readFileSync(path.join(plugin,file))).digest('hex'));
});


test('installed-file evidence detects tampering and missing files without trusting version constants',async()=>{
 const out=await phpTest('$rest->captureApplicationPassword((object)["ID"=>7],["uuid"=>"valid"]);$a=$rest->status(new Request);file_put_contents("/plugins/pageposter-clean-links/pageposter-clean-links.php","<?php // altered same version");unlink("/plugins/pageposter-clean-links/compat/functions.php");file_put_contents("/bridge/includes/unexpected.php","<?php // extra runtime");$b=$rest->status(new Request);echo json_encode([$a,$b]);');
 assert.equal(out[0].data.cleanLinksVersion,out[1].data.cleanLinksVersion);assert.notEqual(out[0].data.packageIntegrity.cleanLinks['pageposter-clean-links.php'],out[1].data.packageIntegrity.cleanLinks['pageposter-clean-links.php']);assert.equal(out[1].data.packageIntegrity.cleanLinks['compat/functions.php'],undefined);assert.match(out[1].data.packageIntegrity.bridge['includes/unexpected.php'],/^[a-f0-9]{64}$/);
});
