import {createAIHandler} from '../server/ai.mjs';
// Build embeds the existing browser files; identity remains enforced by Sites.
const handleAI=createAIHandler();
export default {
  async fetch(request,env,ctx){
    const pathname=new URL(request.url).pathname;
    if(pathname.startsWith('/api/lifecycle/'))return new Response(JSON.stringify({available:false,runtime:'editor',credentialStorage:false,monitoring:{enabled:false},publication:false,message:'Проєкти та моніторинг працюють у локальному сервері PagePoster. Онлайн-сховище ще не підключено.'}),{status:pathname==='/api/lifecycle/status'?200:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
    if(pathname.startsWith('/api/'))return handleAI(request,env);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    const name=pathname==='/'?'index.html':pathname.slice(1);
    const asset=PAGEPOSTER_ASSETS[name];
    if(!Object.hasOwn(PAGEPOSTER_ASSETS,name))return new Response('Not found',{status:404});
    return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
};
