// Routing through a pinned HTTPS transport bypasses Chromium's per-host socket
// budget. Restore a bounded session budget so a large editor cannot flood the
// donor with hundreds of simultaneous TLS connections.
export function createBrowserRequestQueue(transport){
 const normal=[],priority=[];let active=0;
 const cancelled=()=>Object.assign(Error('BROWSER_REQUEST_CANCELLED'),{code:'BROWSER_REQUEST_CANCELLED'});
 function drain(){
  while(active<6&&(priority.length||normal.length)){
   const job=(priority.length?priority:normal).shift();job.started=true;job.options.signal?.removeEventListener('abort',job.abort);active++;
   Promise.resolve().then(()=>{if(job.options.signal?.aborted)throw cancelled();job.beforeStart?.();return transport(job.url,job.options);}).then(job.resolve,job.reject).finally(()=>{active--;drain();});
  }
 }
 return (url,options={},urgent=false,beforeStart)=>new Promise((resolve,reject)=>{
  if(options.signal?.aborted)return reject(cancelled());
  if(normal.length+priority.length>=512)return reject(Object.assign(Error('BROWSER_REQUEST_LIMIT'),{code:'BROWSER_REQUEST_LIMIT'}));
  const list=urgent?priority:normal,job={url,options,resolve,reject,beforeStart,started:false};
  job.abort=()=>{if(job.started)return;const index=list.indexOf(job);if(index>=0)list.splice(index,1);options.signal?.removeEventListener('abort',job.abort);reject(cancelled());};
  list.push(job);options.signal?.addEventListener('abort',job.abort,{once:true});drain();
 });
}
