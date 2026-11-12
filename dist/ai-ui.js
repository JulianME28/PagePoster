(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PagePosterAIUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const BUCKETS = {cards:'Головні пропозиції',moreCards:'Додаткові пропозиції',navLinks:'Меню',tiles:'Плитки',services:'Категорії та послуги',sections:'Розділи статті',faq:'Запитання та відповіді',reviews:'Огляди'};
  const BATCH_SIZE = 16;

  function create(options) {
    const element = options.element;
    const engine = options.core || globalThis.PagePosterAI;
    const request = options.fetch || globalThis.fetch.bind(globalThis);
    const protocol = options.protocol || globalThis.location.protocol;
    const document = element.ownerDocument;
    let workflow = 'current', mode = 'empty', stage = null, stageLinks = '';
    let selected = new Set(), opened = new Set();
    let status = protocol === 'file:' ? 'offline' : 'unknown', checking = false, keyEntryAllowed = false, keyPersistent = false, connecting = false;
    let busy = false, operation = 0, abort = null, proposal = null, undo = null;
    let message = '', error = false, progress = '', budgetStatus = null, pendingRequest = null;
    let pendingInsertions = [], insertionSequence = 0;
    let checkpoint=null,storageWarning='';
    const checkpointKey='pageposter-ai-checkpoint-v1',checkpointLimit=2*1024*1024;
    const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);
    const storageKey='pageposter-ai-pending-v1';
    try { const saved=JSON.parse(document.defaultView?.sessionStorage?.getItem(storageKey)||'null'); if(saved&&/^[a-zA-Z0-9_-]{1,100}$/.test(saved.requestId)&&['pending','uncertain'].includes(saved.state)){pendingRequest={requestId:saved.requestId,state:'uncertain'};message='Попередній запит має невідомий результат або витрати. Повтор автоматично не виконується.';} } catch(_){}
    function rememberRequest(requestId,state){pendingRequest=requestId?{requestId,state}:null;try{const storage=document.defaultView?.sessionStorage;if(pendingRequest)storage?.setItem(storageKey,JSON.stringify(pendingRequest));else storage?.removeItem(storageKey);}catch(_){}}
    function budgetMarkup(){if(!budgetStatus||!Number.isFinite(budgetStatus.limits?.usd)||!Number.isFinite(budgetStatus.spentUSD)||!Number.isFinite(budgetStatus.reservedUSD))return '';return '<p class="ai-note">Місячний ліміт: $'+budgetStatus.limits.usd.toFixed(2)+' · використано $'+budgetStatus.spentUSD.toFixed(2)+' · зарезервовано $'+budgetStatus.reservedUSD.toFixed(2)+'.</p>';}
    const brief = {topic:'',language:'English',otherLanguage:'',instructions:'',links:'',cardCount:'',linkField:'sections.0.body',linkUrl:'',linkAnchor:'',linkCount:'1'};
    function persistCheckpoint(){
      try{
        const storage=document.defaultView?.localStorage;if(!storage){storageWarning='Проміжні тексти збережені лише в цій вкладці: сховище браузера недоступне.';return;}
        if(!checkpoint){storage.removeItem(checkpointKey);return;}
        const encoded=JSON.stringify(checkpoint,(key,value)=>{if(/^(?:authorization|apikey|openaiapikey|password|applicationpassword|credentials?|secret|masterkey|privatekey|ciphertext)$/i.test(key.replace(/[-_ ]/g,'')))throw Error('secret');return value;});
        if(encoded.length>checkpointLimit)throw Error('size');storage.setItem(checkpointKey,encoded);storageWarning='';
      }catch{storageWarning='Не вдалося зберегти проміжні тексти в браузері. Не закривай вкладку; поточні результати залишаються в пам’яті.';}
    }
    function clearCheckpoint(){checkpoint=null;persistCheckpoint();rememberRequest(null);}
    function choice(){return {workflow,mode,paths:[...selected].sort(),insertions:pendingInsertions,brief:{topic:brief.topic,language:brief.language,otherLanguage:brief.otherLanguage,instructions:brief.instructions},stageLinks};}
    function checkpointMatches(){return !!checkpoint&&checkpoint.base===stable(options.getData())&&checkpoint.choice===stable(choice());}
    function mapUpdates(plan,updates){return updates.map(update=>{const target=checkpoint.targets.find(item=>item.targetId===update.targetId),mapped=plan.targets.find(item=>item.fieldPath===target?.fieldPath);if(!mapped)throw Error('Збережений план не відповідає полям сторінки.');return {targetId:mapped.targetId,value:update.value};});}
    function acceptBatch(result){
      const batch=checkpoint.targets.slice(checkpoint.next,checkpoint.next+BATCH_SIZE),requestId=checkpoint.prefix+'-'+checkpoint.next;
      if(result.requestId!==requestId||!Array.isArray(result.updates)||result.updates.length!==batch.length)throw Error('Відповідь неповна. Збережені частини не втрачено.');
      const seen=new Set();for(const update of result.updates){const target=batch.find(item=>item.targetId===update.targetId);if(!target||seen.has(update.targetId)||typeof update.value!=='string'||update.value.length>target.maxLength)throw Error('Відповідь містить некоректні тексти. Збережені частини не втрачено.');seen.add(update.targetId);}
      const paths=batch.map(target=>target.fieldPath),plan=engine.makePlan(checkpoint.source,{mode:checkpoint.mode,paths,linkInsertions:checkpoint.insertions.filter(item=>paths.includes(item.fieldPath))});
      engine.validateUpdates(plan,mapUpdates(plan,result.updates));
      checkpoint.updates.push(...result.updates.map(update=>({targetId:update.targetId,value:update.value})));checkpoint.next+=batch.length;checkpoint.state='ready';checkpoint.errorCode=null;
      if(Array.isArray(result.notes))for(const note of result.notes)if(typeof note==='string'&&!checkpoint.notes.includes(note))checkpoint.notes.push(note);
      rememberRequest(null);persistCheckpoint();
    }
    function restoreProposal(){
      if(!checkpointMatches()||checkpoint.next!==checkpoint.targets.length)return false;
      const plan=engine.makePlan(checkpoint.source,{mode:checkpoint.mode,paths:checkpoint.paths,linkInsertions:checkpoint.insertions}),updates=mapUpdates(plan,checkpoint.updates);engine.validateUpdates(plan,updates);
      checkpoint.state='complete';persistCheckpoint();proposal={plan,updates,notes:checkpoint.notes,source:checkpoint.source,workflow:checkpoint.workflow,revision:options.getRevision(),base:checkpoint.base,language:checkpoint.requestBrief.language};return true;
    }
    async function reconcile(retry){
      if(!checkpoint||!checkpointMatches())throw Error('Чернетка або план змінилися. Відкинь збережений запуск перед новою генерацією.');
      const requestId=checkpoint.prefix+'-'+checkpoint.next;
      const response=await request('/api/ai/retry',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({requestId,action:'inspect'})});
      const receipt=await response.json();if(!response.ok)throw Error('Не вдалося перевірити збережений запит. Платний повтор не виконано.');
      if(receipt.replay&&receipt.result){acceptBatch(receipt.result);restoreProposal();return true;}
      if(receipt.state==='not_found'&&['not_configured','AI_BUDGET_EXCEEDED','AI_RATE_UNKNOWN'].includes(checkpoint.errorCode)){checkpoint.state='ready';persistCheckpoint();return true;}
      if(retry&&receipt.retryable){const authorized=await request('/api/ai/retry',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({requestId,action:'retry'})});if(!authorized.ok)throw Error('Безпечний повтор не дозволений обліком витрат.');checkpoint.state='ready';rememberRequest(null);persistCheckpoint();return true;}
      if(receipt.retryable){checkpoint.state='failed';rememberRequest(null);persistCheckpoint();message='Облік підтвердив відхилений неоплачений запит. Можна продовжити зі збереженої частини.';return false;}
      throw Error('Результат або витрати запиту невідомі чи вже оплачені; повтор автоматично не виконується. Збережені частини залишаються.');
    }
    try{
      const encoded=document.defaultView?.localStorage?.getItem(checkpointKey);
      if(encoded){if(encoded.length>checkpointLimit)throw Error('size');const saved=JSON.parse(encoded);if(saved.version!==1||!saved.source||!Array.isArray(saved.targets)||!saved.targets.length||saved.targets.length>1000||!Array.isArray(saved.updates)||saved.updates.length!==saved.next||!Number.isInteger(saved.next)||saved.next<0||saved.next>saved.targets.length||!/^[a-zA-Z0-9_-]{1,85}$/.test(saved.prefix)||!Array.isArray(saved.paths)||!Array.isArray(saved.insertions)||!Array.isArray(saved.notes))throw Error('invalid');checkpoint=saved;workflow=saved.workflow;mode=saved.mode;selected=new Set(saved.paths);pendingInsertions=saved.insertions;Object.assign(brief,saved.uiBrief);stageLinks=saved.stageLinks||'';if(workflow==='new')stage=checkpoint.source;if(saved.state==='pending'){checkpoint.state='uncertain';rememberRequest(saved.prefix+'-'+saved.next,'uncertain');persistCheckpoint();}message=checkpoint.base===stable(options.getData())?'Збережено '+saved.next+' із '+saved.targets.length+' полів. Можна продовжити без повтору готових частин.':'Чернетка змінилася. Збережений запуск належить іншій версії й не буде застосований.';restoreProposal();}
    }catch{checkpoint=null;storageWarning='Збережений запуск пошкоджений або завеликий. Автоматичне відновлення не виконано.';}
    const groups = () => engine.listGroups(workflow === 'new' ? stage || {} : options.getData());
    const eligible = group => group.fields.filter(field => mode === 'selected' || !String(field.currentValue || '').trim());
    const fieldPaths = group => eligible(group).map(field => field.path);
    const currentPlan = () => {
      const source = workflow === 'new' ? stage : options.getData();
      return source ? engine.makePlan(source,{mode,paths:[...selected],linkInsertions:pendingInsertions}) : {targets:[]};
    };
    function buckets(items) {
      const result = [];
      items.forEach(group => {
        const path = group.paths[0] || '';
        const parts = path.split('.');
        const key = /^\d+$/.test(parts[1] || '') ? parts[0] : '$' + group.id;
        let bucket = result.find(item => item.id === key);
        if (!bucket) { bucket = {id:key,label:BUCKETS[key] || group.label,groups:[]};result.push(bucket); }
        bucket.groups.push(group);
      });
      return result;
    }
    function checked(paths) { return paths.length > 0 && paths.every(path => selected.has(path)); }
    function checkbox(attribute,id,paths,label,disabled) {
      const count = paths.filter(path => selected.has(path)).length;
      return '<label class="ai-check"><input type="checkbox" '+attribute+'="'+escape(id)+'"'+(checked(paths)?' checked':'')+(disabled||!paths.length?' disabled':'')+(count>0&&count<paths.length?' data-mixed="true"':'')+'><span>'+escape(label)+'</span></label>';
    }
    function row(group,locked) {
      const paths = fieldPaths(group);
      return '<details class="ai-select-row" data-ai-open="'+escape(group.id)+'"'+(opened.has(group.id)?' open':'')+'><summary>'+checkbox('data-ai-group',group.id,paths,group.label,locked)+'<small>'+paths.filter(path=>selected.has(path)).length+' / '+paths.length+'</small></summary><div class="ai-fields">'+group.fields.map(field=>{
        const filled = mode==='empty' && String(field.currentValue || '').trim();
        const preview = String(field.currentValue || '').replace(/\s+/g,' ').slice(0,100);
        return '<label class="ai-field-choice'+(filled?' ai-filled':'')+'"><input type="checkbox" data-ai-path="'+escape(field.path)+'"'+(selected.has(field.path)&&!filled?' checked':'')+(locked||filled?' disabled':'')+'><span>'+escape(field.label)+'<small>'+escape(preview || 'Порожнє поле')+(preview.length===100?'…':'')+'</small></span></label>';
      }).join('')+'</div></details>';
    }
    function selectionMarkup(locked) {
      if(workflow==='new'&&!stage)return '';
      const items=groups();
      const allPaths=items.flatMap(fieldPaths);
      const validPaths=new Set(items.flatMap(group=>group.paths));
      selected=new Set([...selected].filter(path=>validPaths.has(path)));
      return '<div class="ai-section-title"><h3>Які тексти написати</h3><span>'+currentPlan().targets.length+' полів</span></div>'+
        '<div class="ai-bulk"><button type="button" class="quiet-btn" data-ai-action="all"'+(locked?' disabled':'')+'>Вибрати все</button><button type="button" class="quiet-btn" data-ai-action="none"'+(locked?' disabled':'')+'>Зняти вибір</button></div>'+
        (allPaths.length?'':'<p class="ai-note">Порожніх текстових полів немає. Додай рядки в редакторі або вибери «Замінити вибрані тексти».</p>')+
        '<div class="ai-selection">'+buckets(items).map(bucket=>{
          if(bucket.groups.length===1 && bucket.id[0]==='$')return row(bucket.groups[0],locked);
          const paths=bucket.groups.flatMap(fieldPaths);
          return '<details class="ai-select-block" data-ai-open="'+escape(bucket.id)+'"'+(opened.has(bucket.id)?' open':'')+'><summary>'+checkbox('data-ai-bucket',bucket.id,paths,bucket.label,locked)+'<small>'+bucket.groups.length+' рядків</small></summary><div class="ai-block-rows">'+bucket.groups.map(group=>row(group,locked)).join('')+'</div></details>';
        }).join('')+'</div><p class="helper">Розгорни блок, щоб вибрати окремі рядки й поля. Зображення, адреси, оцінки та дати змінюються вручну.</p>';
    }

    function insertionMarkup(locked) {
      const source=workflow==='new'?stage:options.getData();if(!source)return '';
      const fields=engine.listGroups(source).flatMap(group=>group.fields.map(field=>({...field,groupLabel:group.label}))).filter(field=>/^(promoBody|(?:sections|tiles|services|reviews)\.\d+\.body|faq\.\d+\.answer)$/.test(field.path));
      if(!fields.some(field=>field.path===brief.linkField))brief.linkField=fields[0]?.path||'';
      const existing=Array.isArray(source.aiLinkInsertions)?source.aiLinkInsertions:[];
      return '<fieldset class="ai-brief"'+(locked?' disabled':'')+'><legend>Посилання всередині тексту</legend><p class="helper">Вибери поле, точну адресу й текст посилання. ШІ впише цей текст у речення; адресу та анкор збереже без змін.</p>'+
       '<label class="field"><span>Куди вставити</span><select data-ai-input="linkField">'+fields.map(field=>'<option value="'+escape(field.path)+'"'+(brief.linkField===field.path?' selected':'')+'>'+escape(field.groupLabel+' · '+field.label)+'</option>').join('')+'</select></label>'+
       '<label class="field"><span>Адреса</span><input data-ai-input="linkUrl" maxlength="4000" value="'+escape(brief.linkUrl)+'" placeholder="https://example.com/"></label>'+
       '<label class="field"><span>Точний текст посилання</span><input data-ai-input="linkAnchor" maxlength="2000" value="'+escape(brief.linkAnchor)+'"></label>'+
       '<label class="field"><span>Кількість у цьому полі</span><input type="number" min="1" max="10" data-ai-input="linkCount" value="'+escape(brief.linkCount)+'"></label>'+
       '<button type="button" class="secondary-btn" data-ai-action="add-link">Додати вставку</button>'+
       existing.map(item=>'<p class="helper">Збережено: '+escape(item.anchor)+' → '+escape(item.url)+' · '+escape(item.fieldPath)+'</p>').join('')+
       pendingInsertions.map(item=>'<p class="ai-note">'+escape(item.anchor)+' → '+escape(item.url)+' · '+escape(item.fieldPath)+' · '+item.count+' раз(ів) <button type="button" class="quiet-btn" data-ai-action="remove-link" data-ai-link-id="'+escape(item.id)+'">Прибрати</button></p>').join('')+
       '<p class="helper">Існуючі ручні посилання зберігаються. Нові вставки з’являться лише після перегляду й застосування текстів.</p></fieldset>';
    }
    function suggestionText(value,target){return value.replace(/\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/g,(token,id)=>{const item=(target.allowedLinks||[]).find(link=>link.id===id);return item?item.anchor:token;});}

    function render() {
      if(options.getData().contentMode==='html') {
        element.innerHTML='<div class="html-mode-notice"><span class="ai-spark">✦</span><h3>Зараз використовується готовий HTML</h3><p>ШІ заповнює поля конструктора. Щоб написати тексти або створити нову сторінку з посилань, спочатку перейди до конструктора. Твій HTML залишиться в чернетці.</p><p>Верхній і нижній блоки HTML можна налаштувати вручну у вкладці «Готовий HTML».</p><button type="button" class="primary-btn" data-ai-action="builder-mode">Перейти до конструктора</button></div>';
        return;
      }
      const focused=document && document.activeElement;
      const focusedName=focused && element.contains(focused) && focused.dataset.aiInput;
      const cursor=focusedName && typeof focused.selectionStart==='number' ? [focused.selectionStart,focused.selectionEnd] : null;
      const scroll=element.scrollTop;
      const locked=busy||Boolean(proposal)||connecting;
      let statusHtml='';
      if(status==='offline')statusHtml='<p>ШІ працює в локальній версії.</p><p>Запусти PagePoster на комп’ютері та відкрий <a href="http://127.0.0.1:4317" target="_blank" rel="noopener">редактор із ШІ ↗</a>. Чернетку можна перенести через JSON.</p>';
      else if(status==='ready')statusHtml='<span class="live-dot"></span> Ключ API налаштовано';
      else if(checking)statusHtml='Перевіряю підключення…';
      else if(status==='unknown')statusHtml='Перевір підключення OpenAI, щоб написати тексти.';
      else statusHtml='<p>'+(status==='missing'?'Потрібно налаштувати ключ OpenAI API для цієї версії.':'Не вдалося перевірити підключення. Переконайся, що PagePoster запущено.')+'</p>';
      element.innerHTML='<div class="ai-heading"><span class="ai-spark">✦</span><div><h3>Тексти з ШІ</h3><p>Вибери потрібні поля, перевір результат і застосуй.</p></div></div>'+
        '<div class="ai-connection" role="status">'+statusHtml+(status!=='offline'&&status!=='ready'?'<button type="button" class="small-btn" data-ai-action="status"'+(checking?' disabled':'')+'>Перевірити підключення</button>':'')+'</div>'+
        budgetMarkup()+(storageWarning?'<p class="ai-note">'+escape(storageWarning)+'</p>':'')+
        ((checkpoint||pendingRequest)&&!busy&&!proposal?'<p class="ai-note">'+(checkpoint?'Збережено '+checkpoint.next+' із '+checkpoint.targets.length+' полів. <button type="button" class="quiet-btn" data-ai-action="recover">Звірити результат</button> ':'Результат попереднього запиту невідомий. Повна чернетка запуску недоступна. ')+ '<button type="button" class="quiet-btn" data-ai-action="forget-checkpoint">Відкинути збережений запуск</button></p>':'')+
        (keyEntryAllowed?'<details class="ai-key-setup" data-ai-open="key"'+(opened.has('key')?' open':'')+'><summary>Ключ OpenAI API</summary><div><label class="field"><span>Ключ для локального редактора</span><input type="password" data-ai-key autocomplete="off" spellcheck="false" placeholder="Встав ключ API"'+(locked||connecting?' disabled':'')+'></label><p class="helper">'+(keyPersistent?'Ключ зберігається зашифрованим на цьому комп’ютері. Він не потрапляє в HTML, чернетки чи резервну копію проєктів.':'Ключ діє до закриття локального сервера. Він не зберігається у чернетці, файлах або браузері.')+'</p><div class="ai-key-actions"><button type="button" class="small-btn" data-ai-action="connect"'+(locked||connecting?' disabled':'')+'>'+(connecting?'Зберігаю…':'Зберегти ключ')+'</button>'+(status==='ready'?'<button type="button" class="quiet-btn" data-ai-action="disconnect"'+(locked||connecting?' disabled':'')+'>Прибрати ключ</button>':'')+'</div></div></details>':'')+
        '<fieldset class="ai-workflows"'+(locked?' disabled':'')+'><legend class="sr-only">Що створюємо</legend><label><input type="radio" name="ai-workflow" data-ai-input="workflow" value="current"'+(workflow==='current'?' checked':'')+'><span>Поточна сторінка</span></label><label><input type="radio" name="ai-workflow" data-ai-input="workflow" value="new"'+(workflow==='new'?' checked':'')+'><span>Нова з посилань</span></label></fieldset>'+
        '<fieldset class="ai-brief"'+(locked?' disabled':'')+'><legend class="sr-only">Побажання до текстів</legend>'+
        '<label class="field"><span>Тема сторінки <em>необов’язково</em></span><input data-ai-input="topic" maxlength="1000" value="'+escape(brief.topic)+'" placeholder="Наприклад, огляд сервісів для подорожей"></label>'+
        '<label class="field"><span>Мова текстів</span><select data-ai-input="language"><option value="English"'+(brief.language==='English'?' selected':'')+'>Англійська</option><option value="Ukrainian"'+(brief.language==='Ukrainian'?' selected':'')+'>Українська</option><option value="other"'+(brief.language==='other'?' selected':'')+'>Інша мова</option></select></label>'+
        (brief.language==='other'?'<label class="field"><span>Якою мовою написати</span><input data-ai-input="otherLanguage" maxlength="100" value="'+escape(brief.otherLanguage)+'" placeholder="Наприклад, польською"></label>':'')+
        '<label class="field"><span>Побажання до тексту <em>необов’язково</em></span><textarea data-ai-input="instructions" rows="3" maxlength="6000" placeholder="Стиль, важливі факти, що потрібно згадати">'+escape(brief.instructions)+'</textarea></label>'+
        (workflow==='new'?'<label class="field"><span>Посилання для нової сторінки</span><textarea data-ai-input="links" rows="5" maxlength="450000" placeholder="Назва | https://example.com\nhttps://another-site.com">'+escape(brief.links)+'</textarea><small>До 20 посилань, одне на рядок. Можна додати назву перед знаком |. Це адреси кнопок: вміст цих сайтів не завантажується.</small></label><label class="field"><span>Кількість карток</span><input type="number" data-ai-input="cardCount" min="1" max="20" value="'+escape(brief.cardCount)+'" placeholder="За кількістю адрес"><small>До 20. Якщо карток більше, адреси повторюються по черзі без зміни параметрів.</small></label><button type="button" class="secondary-btn ai-prepare" data-ai-action="prepare">'+(stage?'Оновити структуру':'Підготувати сторінку')+'</button>'+(stage?'<p class="ai-note">Нова структура готова: '+(stage.cards.length+(stage.moreCards||[]).length)+' пропозицій. Вибери тексти нижче. Поточна чернетка зміниться після натискання «Застосувати».</p>':'<p class="helper">Структура з’явиться тут для перегляду й вибору текстів.</p>'):'')+'</fieldset>'+
        insertionMarkup(locked)+
        '<fieldset class="ai-fill-mode"'+(locked?' disabled':'')+'><legend>Як заповнювати</legend><label><input type="radio" name="ai-mode" data-ai-input="mode" value="empty"'+(mode==='empty'?' checked':'')+'><span>Лише порожні поля</span></label><label><input type="radio" name="ai-mode" data-ai-input="mode" value="selected"'+(mode==='selected'?' checked':'')+'><span>Замінити вибрані тексти</span></label></fieldset>'+
        (mode==='selected'?'<p class="ai-note">Після застосування тексти у вибраних полях буде замінено.</p>':'')+
        (!proposal?selectionMarkup(locked):'')+
        (message?'<p class="ai-message'+(error?' ai-error':'')+'" role="'+(error?'alert':'status')+'">'+escape(message)+'</p>':'')+
        (busy?'<div class="ai-progress" role="status" aria-live="polite"><span class="ai-spinner" aria-hidden="true"></span><span>'+escape(progress)+'</span></div><button type="button" class="secondary-btn ai-wide" data-ai-action="cancel">Скасувати генерацію</button>':proposal?proposalMarkup():
          '<button type="button" class="primary-btn ai-wide" data-ai-action="generate"'+(status!=='ready'||connecting||!currentPlan().targets.length||(pendingRequest&&!checkpoint)||(checkpoint&&(!checkpointMatches()||checkpoint.state==='uncertain'||checkpoint.state==='pending'))?' disabled':'')+'>' +(checkpoint?'Продовжити зі збереженої частини':'✦ Написати вибрані тексти')+'</button><p class="helper">У запит до OpenAI потраплять тема, побажання та вибрані тексти з контекстом. Вміст сайтів за адресами не завантажується. Використання оплачується за твоїм тарифом API.</p>')+
        (undo?'<button type="button" class="quiet-btn ai-undo" data-ai-action="undo">↶ Скасувати останнє застосування</button>':'');
      element.querySelectorAll('[data-mixed]').forEach(input=>{input.indeterminate=true;});
      element.scrollTop=scroll;
      if(focusedName) {
        const next=element.querySelector('[data-ai-input="'+focusedName+'"]');
        if(next&&!next.disabled) {next.focus({preventScroll:true});if(cursor&&next.setSelectionRange)next.setSelectionRange(cursor[0],cursor[1]);}
      }
    }
    function proposalMarkup() {
      return '<div class="ai-review"><h3>Перевір тексти перед застосуванням</h3><p>'+proposal.updates.length+' полів'+(proposal.workflow==='new'?' для нової сторінки. Застосування замінить поточну чернетку.':'. Поточна сторінка ще не змінена.')+'</p>'+
        proposal.updates.map(update=>{
          const target=proposal.plan.targets.find(item=>item.targetId===update.targetId);
          return '<details class="ai-result"><summary>'+escape(target.context.groupLabel)+' · '+escape(target.label)+'</summary><div>'+escape(suggestionText(update.value,target))+'</div></details>';
        }).join('')+
        (proposal.notes.length?'<div class="ai-note">'+proposal.notes.map(note=>'<p>'+escape(note)+'</p>').join('')+'</div>':'')+
        '<div class="ai-review-actions"><button type="button" class="primary-btn" data-ai-action="apply">Застосувати'+(proposal.workflow==='new'?' нову сторінку':' тексти')+'</button><button type="button" class="secondary-btn" data-ai-action="discard">Відкинути</button></div></div>';
    }
    async function checkStatus() {
      if(checking||connecting||status==='offline')return;
      checking=true;render();
      try {
        const response=await request('/api/ai/status',{headers:{Accept:'application/json'},cache:'no-store'});
        if(!response.ok)throw new Error('status');
        const value=await response.json();
        status=value.configured===true?'ready':'missing';
        keyEntryAllowed=value.keyEntryAllowed===true;keyPersistent=value.keyPersistent===true;
        budgetStatus=value.budget||null;
      } catch (_) {status='error';}
      checking=false;render();
    }
    async function connect(apiKey) {
      if(!keyEntryAllowed||protocol==='file:'||connecting||busy||proposal)return;
      connecting=true;message='';error=false;render();
      try {
        const response=await request('/api/ai/connect',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({apiKey})});
        apiKey='';
        const result=await response.json();
        if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'Не вдалося зберегти ключ API.');
        status=result.configured===true?'ready':'missing';
        keyEntryAllowed=result.keyEntryAllowed===true;keyPersistent=result.keyPersistent===true;
        message=status==='ready'?'Ключ API налаштовано. Можна вибрати тексти для генерації.':'Локальний ключ прибрано.';
      } catch(cause){apiKey='';message=cause.message||'Не вдалося зберегти ключ API.';error=true;}
      connecting=false;render();
    }
    function selectPaths(paths,value) {paths.forEach(path=>{if(value)selected.add(path);else selected.delete(path);});}
    function invalidate(text) {
      if(busy&&pendingRequest){rememberRequest(pendingRequest.requestId,'uncertain');if(checkpoint){checkpoint.state='uncertain';persistCheckpoint();}}
      operation++;if(abort)abort.abort();abort=null;busy=false;proposal=null;progress='';
      message=text||'';error=false;
    }
    function pageContext(source) {
      const offers=[...(source.cards||[]),...(source.moreCards||[])];
      return [
        'Бренд: '+(source.brand||''),
        'Заголовок: '+(source.title||''),
        'Пропозиції: '+offers.map((item,index)=>(index+1)+'. '+(item.name||'Без назви')).join('; '),
        'Розділи: '+(source.sections||[]).map((item,index)=>(index+1)+'. '+(item.title||'Новий розділ')).join('; '),
        ...offers.map((item,index)=>'Адреса '+(index+1)+': '+(item.url||''))
      ].join('\n').slice(0,12000);
    }
    async function generate() {
      if(busy||proposal||connecting||status!=='ready'||options.getData().contentMode==='html')return;
      if(workflow==='new'&&(!stage||stageLinks!==brief.links+'\0'+brief.cardCount)){message='Підготуй сторінку з актуальних посилань.';error=true;render();return;}
      const language=brief.language==='other'?brief.otherLanguage.trim():brief.language;
      if(!language){message='Вкажи мову текстів.';error=true;render();return;}
      if(pendingRequest&&!checkpoint){message='Результат або витрати попереднього запиту невідомі. Повна чернетка запуску недоступна; нову генерацію заблоковано.';error=true;render();return;}
      if(checkpoint&&!checkpointMatches()){message='Чернетка або план змінилися. Відкинь збережений запуск перед новою генерацією.';error=true;render();return;}
      if(checkpoint&&['pending','uncertain'].includes(checkpoint.state)){message='Результат або витрати запиту невідомі; повтор автоматично не виконується. Спочатку звір результат.';error=true;render();return;}
      const startedRevision=options.getRevision(),token=++operation;
      abort=new AbortController();busy=true;message='';error=false;undo=null;const signal=abort.signal;
      try{
        if(checkpoint&&checkpoint.state!=='ready'&&checkpoint.state!=='complete'){await reconcile(true);if(proposal){busy=false;abort=null;render();return;}}
        if(!checkpoint){
          const source=clone(workflow==='new'?stage:options.getData()),plan=engine.makePlan(source,{mode,paths:[...selected],linkInsertions:pendingInsertions});
          if(!plan.targets.length)throw Error('Вибери хоча б одне поле для тексту.');
          checkpoint={version:1,prefix:'editor-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),base:stable(options.getData()),choice:stable(choice()),source,workflow,mode,paths:[...selected],insertions:clone(pendingInsertions),uiBrief:clone(brief),stageLinks,requestBrief:{topic:brief.topic.trim(),language,instructions:brief.instructions.trim(),context:pageContext(source),facts:engine.collectFacts(source)},targets:clone(plan.targets),updates:[],notes:[],next:0,state:'ready',errorCode:null};persistCheckpoint();
        }
        while(checkpoint.next<checkpoint.targets.length){
          if(token!==operation||startedRevision!==options.getRevision()||!checkpointMatches())return;
          const offset=checkpoint.next,batch=checkpoint.targets.slice(offset,offset+BATCH_SIZE),requestId=checkpoint.prefix+'-'+offset;
          progress='Пишу тексти: частина '+(Math.floor(offset/BATCH_SIZE)+1)+' з '+Math.ceil(checkpoint.targets.length/BATCH_SIZE)+'. Готово '+offset+' із '+checkpoint.targets.length+' полів.';
          checkpoint.state='pending';rememberRequest(requestId,'pending');persistCheckpoint();render();
          const response=await request('/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},signal,body:JSON.stringify({requestId,brief:checkpoint.requestBrief,targets:batch})});
          if(token!==operation||startedRevision!==options.getRevision())return;
          let result;try{result=await response.json();}catch{throw Error('Не вдалося прочитати відповідь. Спочатку звір результат.');}
          if(!response.ok){checkpoint.errorCode=typeof result.code==='string'?result.code:'GENERATION_FAILED';checkpoint.state=result.code==='AI_RESULT_UNCERTAIN'?'uncertain':'failed';if(checkpoint.state==='uncertain')rememberRequest(requestId,'uncertain');else rememberRequest(null);persistCheckpoint();throw Error(typeof result.error==='string'?result.error:result.error?.message||'Не вдалося написати тексти. Збережені частини залишаються.');}
          checkpoint.state='blocked';checkpoint.errorCode='AI_OUTPUT_INVALID';rememberRequest(null);persistCheckpoint();acceptBatch(result);
        }
        if(token!==operation||startedRevision!==options.getRevision())return;
        restoreProposal();busy=false;abort=null;progress='';message='Тексти готові. Розгорни поля, щоб переглянути результат.';render();void checkStatus();
      }catch(cause){
        if(token!==operation)return;busy=false;abort=null;progress='';proposal=null;
        if(pendingRequest){rememberRequest(pendingRequest.requestId,'uncertain');if(checkpoint)checkpoint.state='uncertain';}
        persistCheckpoint();message=pendingRequest?'Результат або витрати запиту невідомі; повтор автоматично не виконується. Збережені частини залишаються. ID: '+pendingRequest.requestId:(cause.name==='AbortError'?'Генерацію скасовано. Чернетка не змінена.':cause.message||'Не вдалося написати тексти.');error=cause.name!=='AbortError';render();void checkStatus();
      }
    }
    function apply() {
      if(!proposal||busy)return;
      if(proposal.revision!==options.getRevision()||proposal.base!==stable(options.getData())){invalidate('Чернетка змінилася. Вибери поля й створи тексти ще раз.');render();return;}
      const pending=proposal;
      const before=clone(options.getData());
      try {
        engine.validateUpdates(pending.plan,pending.updates);
        const result=engine.apply(pending.plan,pending.source,pending.updates);
        pending.source.language=engine.languageTag(pending.language);clearCheckpoint();
        proposal=null;operation++;selected.clear();pendingInsertions=[];message='Тексти застосовано. Їх можна редагувати у звичайних полях.';error=false;
        if(pending.workflow==='new'){workflow='current';stage=null;}
        options.replaceData(pending.source);
        undo={data:before,revision:options.getRevision()};
        if(result.conflicts)message='Застосовано '+result.applied+' полів. Поля, що змінилися під час роботи, збережено.';
        if(result.emptySkipped)message+=' Порожні відповіді пропущено: '+result.emptySkipped+'. Вставки для них не додано.';
        options.toast(message);render();
      } catch(cause){message=cause.message||'Не вдалося застосувати тексти.';error=true;render();}
    }
    element.addEventListener('input',event=>{
      const input=event.target.closest('[data-ai-input]');
      if(!input||busy||proposal)return;
      const name=input.dataset.aiInput;
      if(Object.prototype.hasOwnProperty.call(brief,name))brief[name]=input.value;
    });
    element.addEventListener('change',event=>{
      const input=event.target;
      if(busy||proposal)return;
      if(input.dataset.aiInput==='workflow') {
        workflow=input.value;pendingInsertions=[];selected.clear();message='';error=false;render();
      } else if(input.dataset.aiInput==='mode') {
        mode=input.value;message='';error=false;render();
      } else if(input.dataset.aiInput==='language') {brief.language=input.value;render();}
      else if(input.dataset.aiPath) {selectPaths([input.dataset.aiPath],input.checked);render();}
      else if(input.dataset.aiGroup) {
        const group=groups().find(item=>item.id===input.dataset.aiGroup);
        if(group)selectPaths(fieldPaths(group),input.checked);render();
      } else if(input.dataset.aiBucket) {
        const bucket=buckets(groups()).find(item=>item.id===input.dataset.aiBucket);
        if(bucket)selectPaths(bucket.groups.flatMap(fieldPaths),input.checked);render();
      }
    });
    element.addEventListener('toggle',event=>{
      const id=event.target.dataset.aiOpen;
      if(id){if(event.target.open)opened.add(id);else opened.delete(id);}
    },true);
    element.addEventListener('click',event=>{
      const button=event.target.closest('[data-ai-action]');
      if(!button||button.disabled)return;
      const action=button.dataset.aiAction;
      if(action==='builder-mode'){if(options.switchToBuilder)options.switchToBuilder();return;}
      if(options.getData().contentMode==='html')return;
      if(action==='status'){void checkStatus();return;}
      if(action==='connect') {
        const input=element.querySelector('[data-ai-key]');
        if(input){const apiKey=input.value.trim();input.value='';if(apiKey)void connect(apiKey);else{message='Встав ключ OpenAI API.';error=true;render();}}
        return;
      }
      if(action==='disconnect'){void connect('');return;}
      if(action==='cancel'){invalidate('Генерацію скасовано. Чернетка не змінена.');render();return;}
      if(action==='apply'){apply();return;}
      if(action==='forget-checkpoint'){if(busy||proposal)return;clearCheckpoint();message='Збережений запуск відкинуто. Новий запуск оплачуватиметься окремо.';error=false;render();return;}
      if(action==='recover'){if(busy||proposal||!checkpoint)return;void (async()=>{try{await reconcile(false);}catch(cause){message=cause.message;error=true;}render();})();return;}
      if(action==='discard'){clearCheckpoint();invalidate('Тексти відкинуто. Чернетка не змінена.');render();return;}
      if(busy||proposal)return;
      if(action==='generate'){void generate();return;}
      if(action==='add-link'){
        try{const source=workflow==='new'?stage:options.getData();if(!source)throw new Error('Спочатку підготуй сторінку.');const entry={id:'ai-link-'+Date.now().toString(36)+'-'+(++insertionSequence),fieldPath:brief.linkField,url:brief.linkUrl.trim(),anchor:brief.linkAnchor,count:Number(brief.linkCount)};engine.makePlan(source,{mode:'selected',paths:[entry.fieldPath],linkInsertions:pendingInsertions.concat(entry)});pendingInsertions.push(entry);selected.add(entry.fieldPath);const field=engine.listGroups(source).flatMap(group=>group.fields).find(field=>field.path===entry.fieldPath);if(field.currentValue.trim())mode='selected';brief.linkUrl='';brief.linkAnchor='';message='Вставку додано до плану. Поле вибрано для генерації.';error=false;}catch(cause){message=cause.message;error=true;}render();return;
      }
      if(action==='remove-link'){pendingInsertions=pendingInsertions.filter(item=>item.id!==button.dataset.aiLinkId);render();return;}
      if(action==='prepare') {
        try {
          stage=engine.createProject(options.getData(),brief.links,brief.cardCount.trim()?{cardCount:Number(brief.cardCount)}:undefined);stageLinks=brief.links+'\0'+brief.cardCount;pendingInsertions=[];mode='empty';selected.clear();
          engine.listGroups(stage).forEach(group=>group.fields.filter(field=>!String(field.currentValue||'').trim()).forEach(field=>selected.add(field.path)));
          message='Структуру підготовлено. Можна зняти вибір із непотрібних блоків.';error=false;
        } catch(cause){message=cause.message;error=true;}
      } else if(action==='all') {groups().forEach(group=>selectPaths(fieldPaths(group),true));}
      else if(action==='none')selected.clear();
      else if(action==='undo'&&undo) {
        if(undo.revision===options.getRevision()) {
          const previous=undo.data;undo=null;selected.clear();options.replaceData(previous);message='Останнє застосування скасовано.';error=false;options.toast(message);
        } else {undo=null;message='Після застосування чернетку вже змінено. Скасування недоступне.';error=true;}
      }
      render();
    });
    return {
      refresh(){render();if(status==='unknown'&&options.getData().contentMode!=='html')void checkStatus();},
      onProjectChange(){
        undo=null;pendingInsertions=[];
        if(workflow==='current')selected.clear();
        if(busy||proposal)invalidate('Чернетка змінилася. Попередній результат скасовано; вибери поля й створи тексти ще раз.');
        if(!element.hidden)render();
      }
    };
  }
  return {create};
});
