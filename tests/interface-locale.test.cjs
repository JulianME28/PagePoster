'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const russianUI=/[ыэъёЫЭЪЁ]|\b(?:ru-RU)\b|Подготовка|Публикация|Нажимаем|Ссылка|Название|Состояние|Сохран|Размер|Укажите|Войдите|Подключ|Нужно|Далее|аккаунт|Ничего|Попробуйте|Материал изменился|Будет|Подробности|Обновляем|ошибка/;

test('both workspace entry points expose Ukrainian captions, hints and accessible names',()=>{
 for(const file of ['index.html','autopilot.html']){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'dist',file),'utf8'));
  try{
   const d=dom.window.document;assert.equal(d.documentElement.lang,'uk');
   d.querySelectorAll('script,style').forEach(node=>node.remove());
   assert.doesNotMatch(d.documentElement.textContent,russianUI,file+' text');
   for(const node of d.querySelectorAll('*'))for(const name of ['aria-label','title','placeholder','alt','content']){
    const value=node.getAttribute(name);if(value)assert.doesNotMatch(value,russianUI,file+' '+name);
   }
   assert.match(d.querySelector('#ga-connect').textContent,/Увійти через Google/);
   assert.match(d.querySelector('#ap-source-advanced').textContent,/Додаткові налаштування/);
  }finally{dom.window.close();}
 }
});

test('dynamic interface, desktop and server sources do not introduce Russian interface captions',()=>{
 const folders=['dist','desktop','server','server/lifecycle'];
 for(const folder of folders)for(const name of fs.readdirSync(path.join(root,folder))){
  if(!/\.(?:js|mjs|cjs|html)$/.test(name)||['project-normalizer.js','csstree.js','PagePoster.html','autopilot.html','index.html'].includes(name))continue;
  const source=fs.readFileSync(path.join(root,folder,name),'utf8');
  assert.doesNotMatch(source,russianUI,folder+'/'+name);
 }
});

test('table errors are Ukrainian while Russian input column aliases remain supported',()=>{
 const table=require('../dist/project-table.js');
 assert.throws(()=>table.read('title,url\n"bad"tail,x'),error=>/Після закривальних лапок/.test(error.message));
 const normalizer=fs.readFileSync(path.join(root,'dist/project-normalizer.js'),'utf8');
 assert.match(normalizer,/'ссылка': 'url'/);
 assert.match(normalizer,/'язык': 'language'/);
});
