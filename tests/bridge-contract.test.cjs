'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const plugin=path.resolve(__dirname,'../wordpress/pageposter-bridge');
let runtime;
try { runtime=require('./qa/php-runtime.cjs'); } catch {}
async function runPHP(body) {
 assert.ok(runtime,'PHP 8.4 harness required: install the documented @php-wasm runtime or provide the existing QA runtime.');
 const php=await runtime.createPHP();
 try {
  php.mkdir('/bridge');php.mkdir('/bridge/includes');
  for(const name of fs.readdirSync(path.join(plugin,'includes')))if(name.endsWith('.php'))php.writeFile('/bridge/includes/'+name,fs.readFileSync(path.join(plugin,'includes',name)));
  const result=await php.run({code:'<?php require "/bridge/includes/class-contract.php"; require "/bridge/includes/class-engine.php"; '+body});
  assert.equal(result.exitCode,0,result.errors||result.text);assert.equal(result.errors,'');return JSON.parse(result.text);
 }finally{php.exit();}
}
const valid={operationId:'b8ebccf8-2ee1-4a43-b7ef-1784e024646d',kind:'create',postType:'page',title:'Пряма сторінка',content:'<div id="pp-landing"><a href="https://example.com/?q=%2f&a=1&b=2">Offer</a></div>',status:'draft'};
const literal=value=>JSON.stringify(JSON.stringify(value));
const memory=String.raw`
class FakeDB {
 public $ops=[],$posts=[],$managed=[],$nextId=1,$snapshot=null,$commitFails=false,$committed=false,$failInsert=false;
 public function ready(){return true;}
 public function begin(){$this->snapshot=serialize([$this->ops,$this->posts,$this->managed,$this->nextId]);}
 public function claimOperation($id,$owner,$hash,$kind,$token,$time){
  if(!isset($this->ops[$id]))$this->ops[$id]=['operation_id'=>$id,'owner_id'=>$owner,'payload_hash'=>$hash,'execution_token'=>$token,'kind'=>$kind,'state'=>'pending','created_at'=>$time,'result_json'=>null];
  return $this->ops[$id];
 }
 public function lockPost($id){return isset($this->posts[$id])?$this->posts[$id]:null;}
 public function readPost($id){return $this->lockPost($id);}
 public function isManaged($id){return isset($this->managed[$id]);}
 public function insertPost($data,$owner,$operation){
  if($this->failInsert)throw new RuntimeException('private SQL secret');
  $id=$this->nextId++;$this->posts[$id]=['ID'=>$id,'post_type'=>$data['postType'],'post_title'=>$data['title'],'post_content'=>$data['content'],'post_status'=>$data['status'],'post_modified_gmt'=>'2026-10-14 10:00:00'];$this->managed[$id]=true;return $this->posts[$id];
 }
 public function compareAndSwap($before,$data){
  if(\PagePoster\Bridge\Contract::contentHash($this->posts[$before['ID']])!==\PagePoster\Bridge\Contract::contentHash($before))return false;
  $this->posts[$before['ID']]=array_merge($before,['post_title'=>$data['title'],'post_content'=>$data['content'],'post_status'=>$data['status']]);return true;
 }
 public function completeOperation($id,$result,$before){$this->ops[$id]['state']=$result['state'];$this->ops[$id]['result_json']=json_encode($result);$this->ops[$id]['before_json']=$before===null?null:json_encode($before);}
 public function commit(){$this->snapshot=null;$this->committed=true;if($this->commitFails)throw new RuntimeException('lost COMMIT acknowledgement');}
 public function rollback(){if($this->snapshot!==null){[$this->ops,$this->posts,$this->managed,$this->nextId]=unserialize($this->snapshot);$this->snapshot=null;}return true;}
 public function url($post){return 'https://example.com/?page_id='.$post['ID'];}
}
function attempt($callback){try{return ['ok'=>true,'value'=>$callback()];}catch(\PagePoster\Bridge\Fault $e){return ['ok'=>false,'code'=>$e->slug,'status'=>$e->httpStatus];}}
function engine($db){return new \PagePoster\Bridge\Engine($db,function(){return '2026-10-14T10:00:00Z';});}
`;
test('Bridge payload validation retains every content byte and rejects unsupported writes',async()=>{
 const cases=[{...valid,kind:'delete'},{...valid,status:'private'},{...valid,postType:'attachment'},{...valid,extra:'field'},{...valid,content:'<div>unmanaged</div>'},{...valid,operationId:'x'},{...valid,kind:'update',postId:1},{...valid,kind:'update',postId:1,expectedContentHash:'x'.repeat(64)}];
 const out=await runPHP(memory+'$input=json_decode('+literal(valid)+',true);$out=[\\PagePoster\\Bridge\\Contract::validate($input)];foreach(json_decode('+literal(cases)+',true) as $bad){$out[]=attempt(function()use($bad){return \\PagePoster\\Bridge\\Contract::validate($bad);});}echo json_encode($out);');
 assert.deepEqual(out[0],valid);for(const bad of out.slice(1)){assert.equal(bad.ok,false);assert.equal(bad.status,400);}
});
test('snapshot hash includes exact UTF-8 title, content, type and status with unambiguous framing',async()=>{
 const row={ID:5,post_type:'page',post_title:valid.title,post_content:valid.content,post_status:'draft'};
 const out=await runPHP('$row=json_decode('+literal(row)+',true);$a=\\PagePoster\\Bridge\\Contract::contentHash($row);$row["post_title"].="!";echo json_encode([$a,\\PagePoster\\Bridge\\Contract::contentHash($row)]);');
 let input='pageposter-snapshot-v1\0';for(const field of ['post_type','post_title','post_content','post_status'])input+=Buffer.byteLength(row[field])+':'+row[field];
 assert.equal(out[0],createHash('sha256').update(input).digest('hex'));assert.notEqual(out[0],out[1]);
});
test('create replay returns one post and changed payload or owner cannot reuse operation ID',async()=>{
 const out=await runPHP(memory+'$db=new FakeDB;$e=engine($db);$p=json_decode('+literal(valid)+',true);$a=$e->execute($p,7,function(){return true;});$b=$e->execute($p,7,function(){return true;});$p["title"]="Different";$c=attempt(function()use($e,$p){return $e->execute($p,7,function(){return true;});});$p["title"]='+JSON.stringify(valid.title)+';$d=attempt(function()use($e,$p){return $e->execute($p,8,function(){return true;});});echo json_encode([$a,$b,$c,$d,count($db->posts)]);');
 assert.equal(out[0].state,'completed');assert.equal(out[0].status,'draft');assert.equal(out[1].postId,out[0].postId);assert.equal(out[1].replayed,true);assert.equal(out[2].status,409);assert.equal(out[3].status,403);assert.equal(out[4],1);
});
test('atomic update snapshots previous content and refuses a manual edit that won first',async()=>{
 const out=await runPHP(memory+'$db=new FakeDB;$e=engine($db);$p=json_decode('+literal(valid)+',true);$a=$e->execute($p,7,function(){return true;});$p["kind"]="update";$p["operationId"]="a8ebccf8-2ee1-4a43-b7ef-1784e024646d";$p["postId"]=$a["postId"];$p["expectedContentHash"]=$a["contentHash"];$p["content"].="updated";$b=$e->execute($p,7,function(){return true;});$backup=json_decode($db->ops[$p["operationId"]]["before_json"],true);$p["operationId"]="c8ebccf8-2ee1-4a43-b7ef-1784e024646d";$p["expectedContentHash"]=$b["contentHash"];$db->posts[1]["post_title"]="Manual change";$c=$e->execute($p,7,function(){return true;});echo json_encode([$b,$backup,$c,$db->posts[1]]);');
 assert.equal(out[0].state,'completed');assert.equal(out[1].post_content,valid.content);assert.equal(out[2].state,'conflict');assert.equal(out[3].post_title,'Manual change');
});
test('unmanaged posts, denied capabilities and changed post type are never overwritten',async()=>{
 const out=await runPHP(memory+'$db=new FakeDB;$e=engine($db);$p=json_decode('+literal(valid)+',true);$a=$e->execute($p,7,function(){return true;});$p["kind"]="update";$p["postId"]=1;$p["expectedContentHash"]=$a["contentHash"];$p["operationId"]="a8ebccf8-2ee1-4a43-b7ef-1784e024646d";$denied=attempt(function()use($e,$p){return $e->execute($p,7,function(){return false;});});unset($db->managed[1]);$unmanaged=attempt(function()use($e,$p){return $e->execute($p,7,function(){return true;});});echo json_encode([$denied,$unmanaged,$db->posts[1]]);');
 assert.equal(out[0].status,403);assert.equal(out[1].status,403);assert.equal(out[2].post_content,valid.content);
});
test('lost commit acknowledgement is uncertain and reconciliation prevents duplicate create',async()=>{
 const out=await runPHP(memory+'$db=new FakeDB;$db->commitFails=true;$e=engine($db);$p=json_decode('+literal(valid)+',true);$first=attempt(function()use($e,$p){return $e->execute($p,7,function(){return true;});});$db->commitFails=false;$second=$e->execute($p,7,function(){return true;});echo json_encode([$first,$second,count($db->posts)]);');
 assert.equal(out[0].code,'pp_bridge_uncertain');assert.equal(out[1].state,'completed');assert.equal(out[1].replayed,true);assert.equal(out[2],1);
});
test('pre-commit failure rolls back the post and operation without leaking SQL details',async()=>{
 const out=await runPHP(memory+'$db=new FakeDB;$db->failInsert=true;$e=engine($db);$p=json_decode('+literal(valid)+',true);$result=attempt(function()use($e,$p){return $e->execute($p,7,function(){return true;});});echo json_encode([$result,count($db->posts),count($db->ops)]);');
 assert.equal(out[0].code,'pp_bridge_database_failure');assert.equal(out[1],0);assert.equal(out[2],0);assert.ok(!JSON.stringify(out).includes('private SQL'));
});

test('marker validation requires exactly one actual element, not strings/comments/data-id',async()=>{
 const content=['<!-- id="pp-landing" -->','<div data-id="pp-landing">Fake</div>','<script>const text=\\\'id="pp-landing"\\\';</script>','<div id="PP-LANDING">Wrong case</div>','<main id="pp-landing">Not compatible with Clean Links</main>','<div id="pp-landing"></div><section id="pp-landing"></section>'];
 const out=await runPHP(memory+'$out=[];foreach(json_decode('+literal(content)+',true) as $content){$p=json_decode('+literal(valid)+',true);$p["content"]=$content;$out[]=attempt(function()use($p){return \\PagePoster\\Bridge\\Contract::validate($p);});}echo json_encode($out);');
 for(const item of out){assert.equal(item.ok,false);assert.equal(item.status,400);}
});
test('stored byte changes cause rollback before the operation commits',async()=>{
 const out=await runPHP(memory+'class AlteringDB extends FakeDB {public function insertPost($data,$owner,$operation){$post=parent::insertPost($data,$owner,$operation);$this->posts[$post["ID"]]["post_content"]="truncated";return $this->posts[$post["ID"]];}}$db=new AlteringDB;$e=engine($db);$p=json_decode('+literal(valid)+',true);$result=attempt(function()use($e,$p){return $e->execute($p,7,function(){return true;});});echo json_encode([$result,count($db->posts),count($db->ops)]);');
 assert.equal(out[0].code,'pp_bridge_content_changed');assert.equal(out[1],0);assert.equal(out[2],0);
});
test('adoption atomically registers an editable existing marked post without changing any stored bytes',async()=>{
 const out=await runPHP(memory+'class AdoptionDB extends FakeDB {public $writes=0;public function registerManaged($id,$owner,$operation){$this->managed[$id]=true;}public function compareAndSwap($before,$data){$this->writes++;return parent::compareAndSwap($before,$data);}}$db=new AdoptionDB;$db->posts[42]=["ID"=>42,"post_type"=>"page","post_title"=>"Manual title","post_content"=>"<style>#pp-universal-pl{color:red}</style>\\n<div id=\\\"pp-universal-pl\\\"><a href=\\\"https://example.com/?x=%2F&amp;y=1\\\">Exact</a></div>","post_status"=>"publish","post_modified_gmt"=>"2026-10-15 10:00:00"];$before=$db->posts[42];$input=["operationId"=>"b8ebccf8-2ee1-4a43-b7ef-1784e024646d","kind"=>"adopt","postType"=>"page","postId"=>42,"expectedContentHash"=>\\PagePoster\\Bridge\\Contract::contentHash($before)];$e=engine($db);$a=attempt(function()use($e,$input){return $e->execute($input,7,function(){return true;});});$b=attempt(function()use($e,$input){return $e->execute($input,7,function(){return true;});});echo json_encode([$a,$b,$db->posts[42]===$before,$db->isManaged(42),$db->writes,count($db->ops)]);');
 assert.equal(out[0].ok,true);assert.equal(out[0].value.kind,'adopt');assert.equal(out[1].value.replayed,true);assert.equal(out[2],true);assert.equal(out[3],true);assert.equal(out[4],0);assert.equal(out[5],1);
});
test('adoption refuses stale snapshots, unmarked pages and injected write fields',async()=>{
 const out=await runPHP(memory+'class AdoptionDB extends FakeDB {public function registerManaged($id,$owner,$op){$this->managed[$id]=true;}}$db=new AdoptionDB;$db->posts[42]=["ID"=>42,"post_type"=>"page","post_title"=>"Manual","post_content"=>"<div id=\\\"pp-landing\\\">Original</div>","post_status"=>"draft","post_modified_gmt"=>"unchanged"];$input=["operationId"=>"b8ebccf8-2ee1-4a43-b7ef-1784e024646d","kind"=>"adopt","postType"=>"page","postId"=>42,"expectedContentHash"=>str_repeat("0",64)];$e=engine($db);$a=attempt(function()use($e,$input){return $e->execute($input,7,function(){return true;});});$input["operationId"]="c8ebccf8-2ee1-4a43-b7ef-1784e024646d";$db->posts[42]["post_content"]="<main>Unmarked</main>";$input["expectedContentHash"]=\\PagePoster\\Bridge\\Contract::contentHash($db->posts[42]);$b=attempt(function()use($e,$input){return $e->execute($input,7,function(){return true;});});$input["content"]="Injected";$c=attempt(function()use($input){return \\PagePoster\\Bridge\\Contract::validate($input);});echo json_encode([$a,$b,$c,$db->managed]);');
 assert.equal(out[0].value.state,'conflict');assert.equal(out[1].code,'pp_bridge_unmanaged');assert.equal(out[2].code,'pp_bridge_validation');assert.deepEqual(out[3],[]);
});

test('operation metadata records the actual stored modified GMT and retains it on ledger replay',async()=>{
 const out=await runPHP(memory+'class ModifiedDB extends FakeDB {public function insertPost($data,$owner,$operation){$post=parent::insertPost($data,$owner,$operation);$this->posts[$post["ID"]]["post_modified_gmt"]="2025-06-07 08:09:10";return $this->posts[$post["ID"]];}public function compareAndSwap($before,$data){$ok=parent::compareAndSwap($before,$data);if($ok)$this->posts[$before["ID"]]["post_modified_gmt"]="2026-10-15 12:34:56";return $ok;}}$db=new ModifiedDB;$e=engine($db);$p=json_decode('+literal(valid)+',true);$a=$e->execute($p,7,function(){return true;});$p["kind"]="update";$p["operationId"]="a8ebccf8-2ee1-4a43-b7ef-1784e024646d";$p["postId"]=$a["postId"];$p["expectedContentHash"]=$a["contentHash"];$p["content"].="updated";$b=$e->execute($p,7,function(){return true;});$db->posts[1]["post_modified_gmt"]="2026-10-16 00:00:00";$replay=$e->execute($p,7,function(){return true;});echo json_encode([$a,$b,$replay]);');
 assert.equal(out[0].modifiedGmt,'2025-06-07 08:09:10');assert.equal(out[1].modifiedGmt,'2026-10-15 12:34:56');assert.equal(out[2].modifiedGmt,out[1].modifiedGmt);assert.equal(out[2].replayed,true);assert.equal(out[0].completedAt,'2026-10-14T10:00:00Z');
});
