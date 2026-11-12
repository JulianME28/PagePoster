const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
for(const [source,target] of [['dompurify/dist/purify.min.js','purify.min.js'],['css-tree/dist/csstree.js','csstree.js']]){
 const sourcePath=path.join(root,'node_modules',source);
 fs.copyFileSync(sourcePath,path.join(root,'dist',target));
}
console.log('Pinned HTML and CSS parser bundles copied.');
