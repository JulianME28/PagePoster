// A Sheet link identifies both the spreadsheet and, when present, its stable tab id.
const ID=/^[A-Za-z0-9_-]{1,200}$/;
const invalid=()=>{const error=new Error('Перевір посилання на Google-таблицю та обрану вкладку.');error.code='source_validation';throw error;};
function validSheetId(value){return Number.isSafeInteger(value)&&value>=0&&value<=2147483647;}
export function buildSourceUrl({spreadsheetId,sheetId=null}){
 if(typeof spreadsheetId!=='string'||!ID.test(spreadsheetId)||sheetId!==null&&!validSheetId(sheetId))invalid();
 return 'https://docs.google.com/spreadsheets/d/'+spreadsheetId+'/edit'+(sheetId===null?'':'#gid='+sheetId);
}
export const buildSourceURL=buildSourceUrl;
export function parseSheetReference(input){
 if(typeof input!=='string'||input.length>2000)invalid();
 const text=input.trim();
 if(ID.test(text))return {spreadsheetId:text,spreadsheetUrl:buildSourceUrl({spreadsheetId:text}),sheetId:null};
 // Check the original authority and path before URL normalization can hide ports,
 // credentials, encoded separators or dot segments.
 const match=/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{1,200})(?:\/edit)?\/?(?:[?#].*)?$/.exec(text);
 if(!match||/[\u0000-\u0020\u007f\\]/.test(text))invalid();
 let url;try{url=new URL(text);}catch{invalid();}
 let sheetId=null;
 for(const [index,params] of [url.searchParams,new URLSearchParams(url.hash.slice(1))].entries()){
  const seen=new Set();
  for(const [key,value] of params){
   if(!['gid','range',...(index===0?['usp','authuser']:[])].includes(key)||seen.has(key))invalid();seen.add(key);
   if(key==='usp'){if(!['sharing','drive_link'].includes(value))invalid();continue;}
   if(key==='authuser'){if(!/^\d{1,2}$/.test(value))invalid();continue;}
   if(key==='range'){if(!value||value.length>300||/[\r\n\0]/.test(value))invalid();continue;}
   if(!/^\d+$/.test(value)||!validSheetId(Number(value)))invalid();
   const parsed=Number(value);if(sheetId!==null&&sheetId!==parsed)invalid();sheetId=parsed;
  }
 }
 const spreadsheetId=match[1];return {spreadsheetId,spreadsheetUrl:buildSourceUrl({spreadsheetId,sheetId}),sheetId};
}
