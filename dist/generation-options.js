(function(root){
 'use strict';
 const languages=Object.freeze({
  en:['English','Англійська','Visit casino','View website'],es:['Spanish','Іспанська','Visitar casino','Ver sitio web'],pl:['Polish','Польська','Odwiedź kasyno','Zobacz stronę'],de:['German','Німецька','Casino besuchen','Website öffnen'],fr:['French','Французька','Visiter le casino','Voir le site'],
  uk:['Ukrainian','Українська','Відвідати казино','Переглянути сайт'],nl:['Dutch','Нідерландська','Bezoek casino','Bekijk website'],pt:['Portuguese','Португальська','Visitar casino','Ver site'],it:['Italian','Італійська','Visita il casinò','Visita il sito'],sv:['Swedish','Шведська','Besök casino','Visa webbplats'],no:['Norwegian','Норвезька','Besøk kasino','Vis nettsted'],da:['Danish','Данська','Besøg casino','Se hjemmeside'],fi:['Finnish','Фінська','Vieraile kasinolla','Näytä verkkosivusto'],ro:['Romanian','Румунська','Vizitează cazinoul','Vezi site-ul'],hu:['Hungarian','Угорська','Kaszinó megtekintése','Weboldal megtekintése'],cs:['Czech','Чеська','Navštívit kasino','Zobrazit web'],sk:['Slovak','Словацька','Navštíviť kasíno','Zobraziť web'],el:['Greek','Грецька','Επίσκεψη στο καζίνο','Προβολή ιστοτόπου'],tr:['Turkish','Турецька','Kasinoyu ziyaret et','Web sitesini görüntüle'],id:['Indonesian','Індонезійська','Kunjungi kasino','Lihat situs web'],vi:['Vietnamese','В’єтнамська','Truy cập sòng bạc','Xem trang web'],hi:['Hindi','Гінді','कैसीनो पर जाएँ','वेबसाइट देखें']
 });
 function expandGenerationLinks(links,cardCount){
  const invalid=()=>{throw Object.assign(Error('Кількість карток має бути цілим числом від кількості пар посилань до 20.'),{code:'VALIDATION'});};
  if(!Array.isArray(links)||!links.length||links.length>20||links.some(pair=>!pair||typeof pair.url!=='string'||typeof pair.anchor!=='string'))invalid();
  const count=cardCount===undefined?links.length:cardCount;
  if(!Number.isSafeInteger(count)||count<links.length||count>20)invalid();
  return Array.from({length:count},(_,index)=>({...links[index%links.length]}));
 }
 const api=Object.freeze({languages,expandGenerationLinks});
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.PagePosterGenerationOptions=api;
})(typeof globalThis==='object'?globalThis:this);
