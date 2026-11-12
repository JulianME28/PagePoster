import {DEFAULT_MONITORING_POLICY} from './store.mjs';
import {readdir,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function createMonitorScheduler({store,clock=Date.now,artifactRoot}){
 const policy=project=>({...DEFAULT_MONITORING_POLICY,...project?.monitoringPolicy});
 const activeProject=project=>!project.archived&&policy(project).enabled;
 function sitePolicy(siteId,projects=store.listProjects()){
  const linked=projects.filter(project=>activeProject(project)&&store.siteBelongsToProject(project.id,siteId));
  if(!linked.length)return null;
  return {project:linked[0],settings:{...policy(linked[0]),siteIntervalMinutes:Math.min(...linked.map(project=>policy(project).siteIntervalMinutes)),retryMinutes:Math.min(...linked.map(project=>policy(project).retryMinutes))}};
 }
 const pending=job=>['queued','running','paused'].includes(job.state);
 const scheduled=job=>/^monitor:(page_check|site_check):/.test(job.idempotencyKey||'')&&job.effect==='read';
 const activeJobs=(includeScheduled=false)=>store.listProjects().flatMap(project=>store.listJobs(project.id)).filter(job=>pending(job)&&(includeScheduled||!scheduled(job)));
 function pauseScheduled(){for(const job of activeJobs(true))if(job.state==='queued'&&scheduled(job))store.pauseJob(job.id);}

 function enqueue(type,entity,key,jobs=activeJobs()){
  // Archived paused work stays paused. A fresh explicit check uses its active requesting project; accepted queued/running reads may still be shared.
  const page=type==='page_check',existing=jobs.find(job=>job.type===type&&(page?job.pageId:job.siteId)===entity.id&&!(job.state==='paused'&&store.getProject(job.projectId)?.archived));
  if(existing)return {job:existing.state==='paused'&&existing.effect==='read'?store.resumeJob(existing.id):existing,reused:true};
  const job=store.enqueueJob({projectId:entity.projectId,siteId:page?entity.siteId:entity.id,...(page?{pageId:entity.id}:{}),type,payload:{},idempotencyKey:key||randomUUID()});
  jobs.push(job);return {job,reused:false};
 }
 function checkPages(projectId){
  const projects=store.listProjects().filter(project=>projectId?project.id===projectId:!project.archived),active=activeJobs(),seenSites=new Set(),jobs=new Map();
  const result={mode:'on-demand',projectIds:projects.map(project=>project.id),queued:0,reused:0,skipped:0,failed:0,jobs:[],pages:[]};
  const include=entry=>{if(!jobs.has(entry.job.id)){jobs.set(entry.job.id,entry.job);result[entry.reused?'reused':'queued']++;}return entry;};
  for(const project of projects)for(const page of store.listPages(project.id)){
   const site=page.siteId&&store.getSite(page.siteId),entry={projectId:project.id,pageId:page.id};
   const reason=!page.fullUrl?'not_published':!site?'missing_site':site.enabled===false&&!site.bootstrap?.restored?'site_disabled':null;
   if(reason){result.skipped++;result.pages.push({...entry,state:'skipped',reason});continue;}
   // Access is checked once for a shared site; each page still has its own result.
   if(!seenSites.has(site.id)){
    seenSites.add(site.id);
    try{include(enqueue('site_check',{...site,projectId:project.id},undefined,active));}
    catch{result.failed++;}
   }
   try{const queued=include(enqueue('page_check',page,undefined,active));result.pages.push({...entry,jobId:queued.job.id,state:queued.reused?'reused':'queued'});}
   catch{result.failed++;result.pages.push({...entry,state:'failed',reason:'queue_failed'});}
  }
  result.jobs=[...jobs.values()];return result;
 }
 const interval=(type,settings)=>(type==='page_check'?settings.pageIntervalMinutes:settings.siteIntervalMinutes)*60000;
 const delay=(type,settings,failures)=>failures>0&&failures<=3?Math.min(interval(type,settings),settings.retryMinutes*60000*2**(failures-1)):interval(type,settings);
 function dueAt(old,type,settings){
  if(!old)return clock();
  const previous=old.nextDue??clock(),anchor=Date.parse(old.lastCheckedAt||old.updatedAt);
  // A shorter policy takes effect even when a longer schedule was already saved.
  return Number.isFinite(anchor)?Math.min(previous,anchor+delay(type,settings,old.failures||0)):previous;
 }
 function schedule(){
  const projects=store.listProjects(),jobs=projects.flatMap(project=>store.listJobs(project.id)),sites=new Map();
  const queue=(project,settings,type,entity)=>{
   const page=type==='page_check',id='schedule:'+type+':'+entity.id,old=store.getRecord(id),due=dueAt(old,type,settings);
   if(due>clock()||jobs.some(job=>job.type===type&&(page?job.pageId:job.siteId)===entity.id&&['queued','running','paused'].includes(job.state)))return;
   jobs.push(store.enqueueJob({projectId:project.id,siteId:page?entity.siteId:entity.id,...(page?{pageId:entity.id}:{}),type,payload:{},idempotencyKey:'monitor:'+type+':'+entity.id+':'+due}));
   const data={entityId:entity.id,type,nextDue:clock()+interval(type,settings),failures:old?.failures||0};
   if(old)store.updateRecord(id,data,old.revision);else store.createRecord(project.id,'monitor-schedule',data,id);
  };
  for(const project of projects){
   const settings=policy(project);if(!activeProject(project))continue;
   for(const site of store.listSites(project.id))if(site.enabled!==false&&site.hasCredential)sites.set(site.id,site);
   for(const page of store.listPages(project.id)){const site=page.siteId&&store.getSite(page.siteId);if(page.fullUrl&&site?.enabled!==false&&site)queue(project,settings,'page_check',page);}
   store.pruneChecks(project.id,settings.retentionDays);
  }
  for(const site of sites.values()){const shared=sitePolicy(site.id,projects);queue(shared.project,shared.settings,'site_check',site);}
 }
 function complete(job,checks){
  if(!['page_check','site_check'].includes(job.type))return;
  const settings=job.type==='site_check'?(sitePolicy(job.siteId)?.settings||policy(store.getProject(job.projectId))):policy(store.getProject(job.projectId));
  const entityId=job.type==='page_check'?job.pageId:job.siteId,id='schedule:'+job.type+':'+entityId,old=store.getRecord(id),bad=checks.some(check=>['problem','unknown'].includes(check.state)),failures=bad?(old?.failures||0)+1:0;
  const data={entityId,type:job.type,nextDue:clock()+delay(job.type,settings,failures),failures,lastCheckedAt:new Date(clock()).toISOString()};
  if(old)store.updateRecord(id,data,old.revision);else store.createRecord(job.projectId,'monitor-schedule',data,id);
 }
 async function pruneArtifacts(){if(!artifactRoot)return;for(const project of store.listProjects())for(const page of store.listPages(project.id)){
  if(!/^[a-f0-9-]+$/.test(page.id))continue;const dir=path.join(artifactRoot,page.id),cutoff=clock()-policy(project).retentionDays*86400000;
  let files;try{files=await readdir(dir,{withFileTypes:true});}catch{continue;}
  for(const file of files)if(file.isFile()&&/^pageposter-[a-f0-9-]+-(desktop|mobile)\.png$/.test(file.name)){const target=path.join(dir,file.name);try{if((await stat(target)).mtimeMs<cutoff)await unlink(target);}catch{}}
 }}
 return {schedule,complete,pruneArtifacts,enqueue,checkPages,pauseScheduled};
}
