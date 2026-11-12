// A local projection of the selected reader, not a grant for any particular file.
export function projectImportCapabilities({source={},account={},serviceReady=false}={}){
 const mode=['user','service','browser'].includes(source?.authMode)?source.authMode:account?.connected===true?'user':'none';
 const connected=mode==='user'?account?.connected===true&&account.phase!=='waiting':mode==='service'?serviceReady===true:mode==='browser'?source.configured===true:false;
 const available=connected&&['user','service'].includes(mode);
 const reason=available?'Читання з Google доступне. Права на конкретну таблицю чи файл перевіримо під час читання.':mode==='browser'?'Поточне браузерне підключення читає лише базу донорів. Для імпорту таблиці чи Google Drive скористайтеся кнопкою «Увійти через Google» у налаштуваннях або виберіть локальні HTML/CSV.':mode==='service'?'Вибране сервісне підключення ще не готове. Можна використати локальні файли або змінити підключення в налаштуваннях.':account?.phase==='waiting'?'Завершіть вибір акаунта Google. До цього доступні локальні файли та вставлення таблиці.':'Для імпорту з Google увійдіть через Google у налаштуваннях. Локальні HTML, CSV і вставлення таблиці доступні одразу.';
 return {version:1,local:{html:true,csv:true,paste:true},google:{mode,connected,sheets:{available,reason},drive:{available,reason}}};
}
