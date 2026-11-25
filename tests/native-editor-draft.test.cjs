const test=require('node:test'),assert=require('node:assert/strict');
const read=async html=>(await import('../server/lifecycle/native-editor-draft.mjs')).readNativeDraftId(html);
const classic=(id='71',type='page')=>'<form id="post"><input name="post_ID" value="'+id+'"><input name="post_type" value="'+type+'"></form>';
const block=source=>'<script id="wp-edit-post-js-after">'+source+'</script>';
const call=(id='71',type='page',target='editor')=>"wp.editPost.initializeEditor('"+target+"', '"+type+"', "+id+", {}, []);";
const ambiguous=error=>error.code==='NATIVE_EDITOR_UNAVAILABLE';

test('classic recovery identity comes only from the exact page form fields',async()=>{
 assert.equal(await read('<script>{"id":900}</script><input name="post_ID" value="800">'+classic()),71);
 assert.equal(await read('<form id="other"><input name="post_ID" value="71"><input name="post_type" value="page"></form>'),null);
 assert.equal(await read('<form id="post"><input name="post_ID" value="71"></form>'),null);
 assert.equal(await read('<form id="post"><input name="post_type" value="page"></form>'),null);
});

test('classic unsupported or invalid identities fail closed',async()=>{
 for(const id of ['', '0', '-1', '1.5', '1e2', '+71', '071', ' 71 ', '9007199254740992', 'postId'])assert.equal(await read(classic(id)),null,id);
 assert.equal(await read(classic('71','post')),null);
 assert.equal(await read(classic('9007199254740991')),9007199254740991);
});

test('classic duplicate fields must agree and duplicate forms are ambiguous',async()=>{
 assert.equal(await read(classic().replace('</form>','<input name="post_ID" value="71"><input name="post_type" value="page"></form>')),71);
 await assert.rejects(read(classic().replace('</form>','<input name="post_ID" value="72"></form>')),ambiguous);
 await assert.rejects(read(classic().replace('</form>','<input name="post_type" value="post"></form>')),ambiguous);
 await assert.rejects(read(classic()+classic()),ambiguous);
});

test('Gutenberg recovery identity accepts the multiline core wrapper before any JavaScript runs',async()=>{
 const html=block(`( function() {
  window._wpLoadBlockEditor = new Promise( function( resolve ) {
   wp.domReady( function() {
    resolve( wp.editPost.initializeEditor( 'editor', "page", 139, {"postLock":{"isLocked":false}}, [] ) );
   } );
  } );
 } )();`);
 assert.equal(await read(html),139);
 assert.equal(await read(block('missingDependency();'+call('72'))),72);
 assert.equal(await read(block('wp . editPost . initializeEditor ( "editor" , \'page\' , 73 , {}, [] );')),73);
 assert.equal(await read(block(call('9007199254740991'))),9007199254740991);
});

test('Gutenberg ignores unrelated scripts and arbitrary JSON ids',async()=>{
 assert.equal(await read('<script>'+call('999')+'</script><script type="application/json">{"id":888}</script>'+block(call('71'))),71);
 assert.equal(await read('<script>'+call()+'</script>'),null);
 assert.equal(await read('<script id="wp-edit-post-js-after" type="application/json">'+call()+'</script>'),null);
 assert.equal(await read('<script id="wp-edit-post-js-after" src="https://external.example/editor.js">'+call()+'</script>'),null);
});

test('Gutenberg rejects unsupported targets, post types and nonliteral positive integer ids',async()=>{
 for(const id of ['postId', '"71"', '0', '-1', '+71', '71.0', '7.1e1', '071', '9007199254740992', '71n', '71 + 1'])assert.equal(await read(block(call(id))),null,id);
 assert.equal(await read(block(call('71','post'))),null);
 assert.equal(await read(block(call('71','page','other'))),null);
 assert.equal(await read(block('window.'+call())),null);
 assert.equal(await read(block('wp "." editPost "." initializeEditor ( "editor", "page", 71, {}, [] );')),null);
 assert.equal(await read(block("wp.editPost.initializeEditor '(' 'editor', 'page', 71, {}, [] );")),null);
 assert.equal(await read(block("wp.editPost.initializeEditor('editor', 'page', 71, {}")),null);
});

test('comment and quoted lookalikes cannot supply Gutenberg recovery identity',async()=>{
 const fake=call('999');
 for(const source of ['// '+fake+'\n','/* '+fake+' */',JSON.stringify(fake)+';',"'wp.editPost.initializeEditor(\\'editor\\', \\'page\\', 999, {}, []);';",'`'+fake+'`;','/wp.editPost.initializeEditor("editor", "page", 999, {}, []);/;'])assert.equal(await read(block(source)),null,source);
 assert.equal(await read(block('const template=`${`'+fake+'`}`;')),null);
 assert.equal(await read(block('<!-- '+fake+'\n')),null);
 assert.equal(await read(block('/* '+fake+' */\nconst example='+JSON.stringify(fake)+';\n'+call('71'))),71);
 assert.equal(await read(block('wp /* comment */ . editPost . initializeEditor ( "editor", "page", 74, {}, [] );')),74);
});

test('duplicate Gutenberg scripts or direct calls are ambiguous even if their ids agree',async()=>{
 await assert.rejects(read(block(call())+block(call())),ambiguous);
 await assert.rejects(read(block(call()+call())),ambiguous);
 await assert.rejects(read(block(call()+call('72'))),ambiguous);
});

test('supported classic and Gutenberg markers must agree',async()=>{
 assert.equal(await read(classic()+block(call())),71);
 await assert.rejects(read(classic()+block(call('72'))),ambiguous);
 assert.equal(await read(classic('0')+block(call())),null);
});

test('HTML and inline source are parsed as data without executing scripts',async()=>{
 const malicious=classic()+'<script>document.querySelector("#post [name=post_ID]").value="999";</script>';
 assert.equal(await read(malicious),71);
 assert.equal(await read(''),null);
 assert.equal(await read('<form id="loginform"><input value="71"></form>'),null);
});
