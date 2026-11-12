// Release only a local, unused choice. A remote page or uncertain action keeps
// its reservation even while the project is closed.
export function unusedDonorReservation(run,store,now=Date.now()){
 if(!run.candidate||run.manualTarget||run.browserWindow||run.browserPreparing||run.nativePublication||run.nativeSnapshot||run.nativeCapacityReserved||run.siteId||run.jobId||run.checkJobId||run.bootstrapStage||run.apiCredential||run.publicationMode||['running','publishing','checking','completed','uncertain'].includes(run.state)||run.leaseToken&&(!Number.isFinite(Date.parse(run.leaseUntil))||Date.parse(run.leaseUntil)>now))return false;
 if(!['selecting','installing'].includes(run.stage)||!run.pageId)return false;
 const page=store.getPage(run.pageId);if(!page||page.wpId||page.fullUrl||store.listJobs(run.projectId).some(job=>job.pageId===page.id&&job.effect==='write'))return false;
 return true;
}
export function releasedDonorPatch(run){return {candidate:null,candidateCredential:null,alternateCredential:null,donorPinned:false,candidateCredentialIndex:0,candidateCredentialFailures:[],publicationApproval:null,destinationRevision:(run.destinationRevision||0)+1,state:'awaiting_review',stage:'selecting',error:null,selectionDiagnostics:null};}
