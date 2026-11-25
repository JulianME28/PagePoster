const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Windows launcher uses complete CRLF command lines',()=>{
 const text=fs.readFileSync(path.resolve(__dirname,'../Start-PagePoster.cmd'),'utf8');
 assert.doesNotMatch(text,/\r(?!\n)/);assert.ok(text.includes('\r\n'));assert.equal(text.split('\r\n').filter(Boolean).length,3);
});
