import {publicPublication,safePublicationDiagnostics} from './publication-diagnostics.mjs';

const STARTUP_PHASES=['main-entered','electron-ready','window-created','startup-loaded','backend-spawned','backend-ready','workspace-loaded','queue-response','failed'];
const STATES=new Set(['queued','running','paused','uncertain','failed','review','awaiting_review','preparing','generating','selecting','installing','publishing','checking','completed','cancelled','needs_attention','ready','waiting_source','active','deleted','blocked']);
const PUBLICATION_STATES=new Set(['not_sent','draft','reconciling','published_checking','published','verification_unknown','manual_action','cleanup_pending','trashed','blocked']);
const MAX_PROJECTS=100,MAX_RECORDS=1000,MAX_MS=604800000;
const MAX_TIMING_SAMPLES=MAX_RECORDS*32;
const TIMING_METRICS=['elapsedMs','networkMs','queueMs','workerQueueWaitMs','manualWaitMs','jobLifetimeMs'];
const timingStats=()=>({samples:0,totalMs:0,minMs:null,maxMs:null,p50Ms:null,p95Ms:null});
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const version=value=>typeof value==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value)?value:null;
const count=(target,value,allowed)=>{const key=allowed.has(value)?value:'unknown';target[key]=(target[key]||0)+1;};
function startupSnapshot(value){
 if(value?.format!==1)return null;
 const phases={};for(const name of STARTUP_PHASES){const elapsed=integer(value.phases?.[name],MAX_MS);if(elapsed!==null)phases[name]=elapsed;}
 return {format:1,startedAt:integer(value.startedAt),phases};
}

// This builds a new allowlist. It never serializes a backup or copies record text.
export function createSupportReport({store,metadata=null,now=Date.now(),desktop=false}={}){
 const build=metadata?.build?.state==='available'&&/^[a-f0-9]{64}$/.test(metadata.build.manifestSha256||'')?{state:'available',manifestSha256:metadata.build.manifestSha256}:{state:'unavailable'};
 if(build.state==='available'&&typeof metadata.build.buildId==='string'&&/^[a-f0-9]{64}$/.test(metadata.build.buildId))build.buildId=metadata.build.buildId;
 const runtime={kind:desktop?'desktop':'local',node:version(process.versions.node),platform:['win32','linux','darwin'].includes(process.platform)?process.platform:'other',arch:['x64','arm64','ia32'].includes(process.arch)?process.arch:'other',electron:version(metadata?.runtime?.electron)};
 const counters={projects:0,pages:0,jobs:0,runs:0},runStates={},jobStates={},publicationStates={},phaseTimings={},phaseCodes={},timingSamples=new Map();
 const sample=(summary,value)=>{if(value===null)return;let values=timingSamples.get(summary);if(!values){values=[];timingSamples.set(summary,values);}if(values.length>=MAX_TIMING_SAMPLES){truncated=true;return;}values.push(value);summary.samples++;summary.totalMs+=value;summary.minMs=summary.minMs===null?value:Math.min(summary.minMs,value);summary.maxMs=summary.maxMs===null?value:Math.max(summary.maxMs,value);};
 let truncated=false;
 const projects=store.listProjects();if(projects.length>MAX_PROJECTS)truncated=true;
 for(const project of projects.slice(0,MAX_PROJECTS)){
  counters.projects++;
  const pages=store.listPageSummaries(project.id),jobs=store.listJobs(project.id),runs=store.listRecords(project.id,'autopilot');
  counters.pages+=Math.min(pages.length,MAX_RECORDS);if(pages.length>MAX_RECORDS)truncated=true;
  const remainingJobs=MAX_RECORDS-counters.jobs;if(jobs.length>remainingJobs)truncated=true;
  for(const job of jobs.slice(0,remainingJobs)){counters.jobs++;count(jobStates,job.state,STATES);}
  const remaining=MAX_RECORDS-counters.runs;if(runs.length>remaining)truncated=true;
  for(const run of runs.slice(0,remaining)){
   counters.runs++;count(runStates,run.state,STATES);
   const page=run.pageId&&typeof store.getPage==='function'?store.getPage(run.pageId):null;
   const publication=publicPublication(run,page,{now});if(publication)count(publicationStates,publication.state,PUBLICATION_STATES);
   for(const entry of safePublicationDiagnostics(run.publicationDiagnostics)){
    const summary=phaseTimings[entry.phase]||={...timingStats(),scope:'recorded_elapsed_values',safeReadRetries:0,scopes:{}};
    sample(summary,entry.elapsedMs);
    const scope=entry.timingScope||'unknown';
    for(const metric of TIMING_METRICS){if(entry[metric]===null)continue;const scoped=summary.scopes[scope]||={};const values=scoped[metric]||={...timingStats(),scope:metric==='networkMs'?entry.networkScope||'unknown':metric==='queueMs'?entry.queueScope||'unknown':metric==='workerQueueWaitMs'?entry.workerQueueWaitScope||'unknown':metric==='manualWaitMs'?entry.manualWaitScope||'unknown':metric==='jobLifetimeMs'?'job_lifetime':scope};sample(values,entry[metric]);}
    summary.safeReadRetries+=entry.safeReadRetries;
    const codes=phaseCodes[entry.phase]||={};codes[entry.code]=(codes[entry.code]||0)+1;
   }
  }
 }
 for(const [summary,values]of timingSamples){values.sort((a,b)=>a-b);summary.p50Ms=values[Math.ceil(values.length*.5)-1]??null;summary.p95Ms=values[Math.ceil(values.length*.95)-1]??null;}
 return {format:1,generatedAt:integer(now),build,runtime,startup:startupSnapshot(metadata?.startup),counters,runStates,jobStates,publicationStates,phaseTimings,phaseCodes,timingAggregation:{quantile:'nearest_rank',maxSamplesPerMetric:MAX_TIMING_SAMPLES},coverage:{truncated,limits:{projects:MAX_PROJECTS,runs:MAX_RECORDS,jobs:MAX_RECORDS,pagesPerProject:MAX_RECORDS},screenshotsIncluded:false}};
}
