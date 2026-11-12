const retryable=new Set(['network_timeout','network_failed','dns_failed','BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE','NATIVE_RESULT_UNCERTAIN','BROWSER_PUBLICATION_UNCERTAIN','NATIVE_TRASH_UNCERTAIN']);
export const safeReadRecoverable=error=>retryable.has(error?.code)||error?.name==='TimeoutError';
const preCreationFailures=new Set(['BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE','NATIVE_NAVIGATION_UNAVAILABLE','network_timeout','network_failed','dns_failed']);
export const isPreCreationDonorFailure=code=>preCreationFailures.has(code);
// Only callers which already hold the publication/material fence may supply a
// read operation. This helper never receives a publish/Trash/create callback.
export async function recoverSafeRead(read,{scope,previous,persist,guard=()=>{},clock=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),signal}={}){
 let attempt=previous?.scope===scope||previous?.scope===undefined?Math.min(previous?.attempt||0,3):0;
 // An interrupted read may finish after the user solves the challenge, even
 // when the interruption happened on the last allowed attempt.
 if(previous?.state==='manual_action')attempt=Math.max(0,attempt-1);
 if(previous?.retryAt&&Date.parse(previous.retryAt)>clock())await wait(Math.min(1000,Date.parse(previous.retryAt)-clock()));
 while(attempt<3){
  if(signal?.aborted)throw Object.assign(Error('Read cancelled'),{code:'PROJECT_PAUSED'});guard();attempt++;
  await persist({scope,state:'reading',attempt,limit:3,retryAt:null});
  try{const result=await read();guard();await persist({scope,state:'confirmed',attempt,limit:3,retryAt:null});return result;}
  catch(error){guard();const retry=safeReadRecoverable(error)&&attempt<3&&!signal?.aborted;
   const delay=100*2**(attempt-1);await persist({scope,state:retry?'waiting':['BROWSER_CAPTCHA_REQUIRED','BROWSER_LOGIN_REQUIRED'].includes(error.code)?'manual_action':'exhausted',attempt,limit:3,retryAt:retry?new Date(clock()+delay).toISOString():null});
   if(!retry)throw error;await wait(delay);
  }
 }
 throw Object.assign(Error('Safe reads exhausted'),{code:'READ_RETRIES_EXHAUSTED',uncertain:true});
}
