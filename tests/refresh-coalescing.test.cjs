const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
for(const [file,marker,reader,refresh]of [['autopilot-ui.js','let resultsRefresh=', 'readResults','loadResults'],['project-queue-ui.js','let queueRefresh=','readQueues','refreshQueues']])test(file+': coalesced refresh returns the newest outcome after a stale request fails',async()=>{
 const text=fs.readFileSync(require('node:path').join(__dirname,'../dist',file),'utf8'),begin=text.indexOf(marker),end=text.indexOf('async function '+reader,begin);assert.ok(begin>=0&&end>begin);
 let rejectFirst,calls=0,active=0,peak=0;const context=vm.createContext({[reader]:async()=>{calls++;active++;peak=Math.max(peak,active);try{if(calls===1)await new Promise((_,reject)=>rejectFirst=reject);}finally{active--;}}});
 vm.runInContext(text.slice(begin,end)+';globalThis.refresh='+refresh,context);const first=context.refresh(),newest=context.refresh();rejectFirst(Error('stale project'));await assert.doesNotReject(newest);await assert.doesNotReject(first);assert.equal(calls,2);assert.equal(peak,1);
});
