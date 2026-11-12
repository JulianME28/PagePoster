// Only allowlisted codes and bounded identifiers leave the provider boundary.
// Never forward raw provider messages: they may contain project IDs or secrets.
const providerCodes=new Set(['model_not_found','unsupported_country_region_territory','insufficient_permissions','permission_denied','invalid_api_key','insufficient_quota','rate_limit_exceeded']);
export function safeAIDiagnostics(value){
 if(!value||!Number.isInteger(value.httpStatus)||value.httpStatus<400||value.httpStatus>599)return undefined;
 const d={httpStatus:value.httpStatus};
 if(providerCodes.has(value.providerCode))d.providerCode=value.providerCode;
 if(typeof value.model==='string'&&/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(value.model)&&!/^sk-/i.test(value.model))d.model=value.model;
 if(typeof value.requestId==='string'&&/^req_[a-zA-Z0-9_-]{1,96}$/.test(value.requestId))d.requestId=value.requestId;
 return d;
}
export function aiDiagnosticMessage(value){
 const d=safeAIDiagnostics(value);if(!d)return null;
 if(d.providerCode==='model_not_found')return 'OpenAI: проект не имеет доступа к модели '+(d.model||'из настроек')+' или модель недоступна (HTTP '+d.httpStatus+', model_not_found). Выберите доступную модель или проверьте разрешения проекта.';
 if(d.providerCode==='unsupported_country_region_territory')return 'OpenAI отклонил запрос из неподдерживаемого региона (HTTP '+d.httpStatus+', unsupported_country_region_territory). Проверьте регион сервера и настройки сети.';
 if(['insufficient_permissions','permission_denied'].includes(d.providerCode))return 'OpenAI отклонил запрос из-за недостаточных разрешений ключа или проекта (HTTP '+d.httpStatus+', '+d.providerCode+').';
 if(d.providerCode==='invalid_api_key')return 'OpenAI не принял API-ключ (invalid_api_key). Проверьте ключ в подключениях.';
 if(d.providerCode==='insufficient_quota')return 'OpenAI: исчерпана квота API (insufficient_quota). Проверьте баланс и лимиты проекта.';
 return null;
}
export async function readAIDiagnostics(response,model){
 let providerCode;const reader=response.body?.getReader();let total=0;const chunks=[];
 if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>16384){await reader.cancel();return safeAIDiagnostics({httpStatus:response.status,model,requestId:response.headers.get('x-request-id')});}chunks.push(value);}const all=new Uint8Array(total);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}providerCode=JSON.parse(new TextDecoder().decode(all))?.error?.code;}catch{}finally{reader.releaseLock();}
 return safeAIDiagnostics({httpStatus:response.status,providerCode,model,requestId:response.headers.get('x-request-id')});
}
export async function providerFailure(response,model){
 const diagnostics=await readAIDiagnostics(response,model);
 let code=({400:'AI_REQUEST_INVALID',401:'AI_AUTH_FAILED',403:'AI_ACCESS_DENIED',404:'AI_MODEL_UNAVAILABLE',422:'AI_REQUEST_INVALID',429:'AI_RATE_LIMITED'})[response.status]||'AI_PROVIDER_UNAVAILABLE';
 if(diagnostics?.providerCode==='model_not_found')code='AI_MODEL_UNAVAILABLE';
 if(diagnostics?.providerCode==='unsupported_country_region_territory')code='AI_REGION_UNSUPPORTED';
 const fallback={400:'API не прийняв налаштування генерації. Перевір модель або скороти запит.',401:'Ключ API не прийнятий. Перевір підключення OpenAI.',403:'OpenAI відхилив доступ (HTTP 403). Точну причину не надано; перевір дозволи API-проєкту.',404:'Вибрана модель недоступна. Перевір OPENAI_MODEL.',429:'Ліміт або баланс OpenAI вичерпано. Перевір свій API-акаунт і повтори пізніше.'};
 return {code,error:aiDiagnosticMessage(diagnostics)||fallback[response.status]||'OpenAI тимчасово недоступний. Спробуй пізніше.',diagnostics};
}

const outputIssueMessages={
 UNSUPPORTED_OFFER_CLAIM:'В этом фрагменте найдено утверждение, не подтверждённое исходными данными.',
 MANUAL_FACT_CHANGED:'ИИ изменил факт, введённый вручную.',
 AI_SHAPE_INVALID:'ИИ вернул неполную структуру страницы или лишние поля.',
 AI_TEXT_INVALID:'ИИ вернул слишком короткий, слишком длинный или недопустимый текст.',
 AI_MODEL_LINK_TOKEN:'ИИ добавил служебную метку ссылки вместо обычного текста.',
 AI_LINK_MISSING:'ИИ пропустил обязательное размещение ссылки.',
 AI_LINK_DUPLICATE:'ИИ повторил обязательное размещение ссылки.',
 AI_LINK_MISPLACED:'ИИ поместил ссылку в неподходящее поле.',
 AI_RESPONSE_INVALID:'OpenAI вернул незавершённую или нечитаемую страницу.',
 AI_DESIGN_INVALID:'ИИ вернул неподдерживаемые настройки оформления.',
 AI_LANGUAGE_INVALID:'ИИ вернул некорректный код языка.',
 AI_OUTPUT_TOO_LARGE:'Ответ ИИ превышает допустимый размер страницы.'
};
const outputRoots=new Set('response plan links cards moreCards language topic title brand brandTagline intro cardsTitle articleTitle faqTitle footerTitle footer footerLinksTitle footerNote ctaLabel tocTitle tableTitle tableText design offers sections faq navLabels linkSentences'.split(' '));
export function safeAIOutputIssues(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,10).filter(i=>i&&Object.hasOwn(outputIssueMessages,i.code)).map(i=>({code:i.code,...(typeof i.fieldPath==='string'&&i.fieldPath.length<=100&&/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/.test(i.fieldPath)&&outputRoots.has(i.fieldPath.split('.')[0])?{fieldPath:i.fieldPath}:{})}));
}
export function aiOutputMessage(value){const issue=safeAIOutputIssues(value)[0];return issue?outputIssueMessages[issue.code]+(issue.fieldPath?' Поле: '+issue.fieldPath+'.':'')+' Страница не подготовлена; ссылки и анкоры сохранены.':null;}
