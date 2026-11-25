(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PagePosterRuns = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var sequence = 0;
  var states = {queued:'У черзі',running:'Виконується',paused:'Призупинено',review:'Готово до перегляду',completed:'Завершено',failed:'Помилка',uncertain:'Потребує звірки'};
  var errors = {CONTENT_DUPLICATE:'Згенерований текст повторює іншу сторінку. Відкрийте редактор і змініть його перед публікацією.',CONTENT_FACT_REVIEW_REQUIRED:'Перевірте факти в тексті: знайдено непідтверджене або суперечливе твердження. Відкрийте редактор і виправте матеріал.',URL_TOO_LONG:'Адреса довша за 4000 символів. Її збережено без обрізання; виправте адресу вручну.',AI_REQUEST_INVALID:'OpenAI не прийняв запит. Перевірте параметри тексту.',AI_AUTH_FAILED:'OpenAI не прийняв ключ. Оновіть його в налаштуваннях ШІ.',AI_ACCESS_DENIED:'Ключ OpenAI не має доступу до цієї дії. Перевірте права проєкту.',AI_MODEL_UNAVAILABLE:'Обрана модель недоступна для цього ключа. Перевірте налаштування ШІ.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Продовжіть запуск пізніше.',AI_PROVIDER_UNAVAILABLE:'OpenAI тимчасово недоступний. Продовжіть запуск пізніше.',AI_NETWORK_ERROR:'Не вдалося з’єднатися з OpenAI. Перевірте підключення.',AI_TIMEOUT:'OpenAI не відповів вчасно. Перед повторенням звірте результат запиту.',AI_CANCELLED:'Запит ШІ зупинено. Завершені частини збережено.',AI_REFUSED:'OpenAI відмовив у генерації цього тексту. Змініть завдання або заповніть текст вручну.',CONFLICT:'Сторінку вже змінено. Оновіть сторінку перед новим запуском.',VALIDATION:'Перевірте заповнені поля.',SITE_NOT_READY:'Спочатку перевірте доступ до сайту.',AI_BUDGET_EXCEEDED:'Місячного бюджету ШІ недостатньо для цього запуску.',AI_RESULT_UNCERTAIN:'Результат запиту до ШІ потребує звірки. Новий платний запит не запускається.',GENERATION_ACTIVE:'Для цієї сторінки вже є активний запуск.',CAPACITY_EXCEEDED:'Досягнуто ліміт сторінок, включно з чергою.'};
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function list(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return value == null ? '' : String(value); }
  function insertionField(path) { return /^(promoBody|(?:sections|tiles|services|reviews)\.\d+\.body|faq\.\d+\.answer)$/.test(path); }
  function active(run) { return run && ['queued','running','paused','uncertain'].indexOf(run.state) >= 0; }

  function create(options) {
    options = options || {};
    var root = options.element;
    if (!root || !root.ownerDocument || !options.page || typeof options.request !== 'function') throw new TypeError('Run panel requires element, page and request.');
    var doc = root.ownerDocument, win = doc.defaultView, engine = options.core || win.PagePosterAI;
    var page = clone(options.page), sites = clone(list(options.sites)), config = page.config || {}, html = config.contentMode === 'html';
    if (!html && (!engine || typeof engine.listGroups !== 'function')) throw new TypeError('PagePosterAI is required.');
    var groups = html ? [] : engine.listGroups(config), fields = groups.reduce(function(all,g){return all.concat(g.fields);},[]);
    var prefix = 'pp-run-' + (++sequence) + '-', storageKey = 'pageposter.run.v1:' + encodeURIComponent(page.projectId || '') + ':' + encodeURIComponent(page.id);
    var draft = {topic:page.keyword || '',language:page.language || '',country:page.country || '',instructions:'',status:'review',siteId:page.siteId || '',mode:html?'manual':'empty',linkField:(fields.find(function(f){return insertionField(f.path);}) || {}).path || '',linkUrl:'',linkAnchor:'',linkCount:'1'};
    var selected = new Set(fields.filter(function(f){return !text(f.currentValue).trim();}).map(function(f){return f.path;})), added = [];
    var existing = clone(list(config.aiLinkInsertions)), pending = null, runs = [], disposed = false, busy = false, loading = false, loaded = false, stale = false, epoch = 0, loadSequence = 0, timer = null, polls = 0, message = '', bad = false, changed = '';
    var notice, form, formFields, fieldArea, linksArea, history, launchArea;
    try {
      var saved = JSON.parse(win.sessionStorage.getItem(storageKey) || 'null');
      if (saved && saved.pageId === page.id && saved.projectId === page.projectId && saved.body && Number.isInteger(saved.body.expectedRevision) && typeof saved.body.idempotencyKey === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.body.idempotencyKey) && Array.isArray(saved.body.paths) && Array.isArray(saved.body.linkInsertions)) {
        pending = saved; if (pending.state === 'submitting') pending.state = 'uncertain';
      }
    } catch (_) {}
    function save() { try { if (pending) win.sessionStorage.setItem(storageKey,JSON.stringify(pending)); else win.sessionStorage.removeItem(storageKey); return true; } catch (_) { return false; } }
    function el(tag, className, value) { var n=doc.createElement(tag);if(className)n.className=className;if(value!==undefined)n.textContent=text(value);return n; }
    function append(node) { for(var i=1;i<arguments.length;i++)if(arguments[i])node.appendChild(arguments[i]);return node; }
    function button(label, action, primary) {var n=el('button',primary?'lc-btn lc-primary':'lc-btn',label);n.type='button';n.dataset.runAction=action;return n;}
    function labelField(parent,label,name,kind,value,limit) {
      var box=el('div','lc-field'),control=el(kind==='textarea'?'textarea':kind==='select'?'select':'input'),id=prefix+name;
      control.name=name;control.id=id;if(control.tagName==='INPUT')control.type='text';if(limit)control.maxLength=limit;
      var title=el('label','',label);title.htmlFor=id;append(box,title,control);parent.appendChild(box);
      if(value!==undefined)control.value=text(value);return control;
    }
    function option(control,value,label,disabled) {var o=el('option','',label);o.value=value;o.disabled=!!disabled;control.appendChild(o);return o;}
    function ready(site) {return site && site.enabled!==false && ['ok','ready'].indexOf(site.status)>=0 && site.hasCredential!==false;}
    function lock() {return busy || !!pending || stale || !loaded || runs.some(active);}
    function eligible(f) {return draft.mode==='selected' || draft.mode==='empty' && !text(f.currentValue).trim();}
    function chosen() {return draft.mode==='manual' ? [] : fields.filter(function(f){return selected.has(f.path)&&eligible(f);}).map(function(f){return f.path;});}
    function notify(value,error) {message=value;bad=!!error;if(notice){notice.textContent=message;notice.hidden=!message;notice.className='lc-notice'+(bad?' lc-error':'');notice.setAttribute('role',bad?'alert':'status');}}
    function errorText(error) {return errors[error&&error.code] || 'Не вдалося виконати дію. Оновіть стан і повторіть спробу.';}
    function stop() {if(timer!==null)win.clearTimeout(timer);timer=null;}
    function schedule() {
      stop();if(disposed||polls>=60||!runs.some(function(r){return r.state==='queued'||r.state==='running';}))return;
      timer=win.setTimeout(function(){timer=null;if(disposed||root.hidden||root.closest('[hidden]')||doc.visibilityState==='hidden')return;polls++;refresh().catch(function(){});},5000);
    }
    function check(parent,label,path,checked,disabled) {
      var l=el('label','ai-check'),input=el('input');input.type='checkbox';input.dataset.runPath=path;input.checked=checked;input.disabled=disabled;
      append(l,input,el('span','',label));parent.appendChild(l);return input;
    }
    function renderFields() {
      fieldArea.replaceChildren();
      if(html){fieldArea.appendChild(el('p','lc-muted','Імпортований HTML піде далі без ШІ. Вміст і наявні посилання збережуться.'));return;}
      var mode=labelField(fieldArea,'Як працювати з текстами','mode','select');
      option(mode,'empty','Лише порожні поля');option(mode,'selected','Замінити вибрані тексти');option(mode,'manual','Без ШІ — використати збережені тексти');mode.value=draft.mode;
      if(draft.mode==='manual') {fieldArea.appendChild(el('p','lc-muted','Тексти та посилання залишаться збереженими.'));return;}
      var actions=el('div','lc-actions');append(actions,button('Вибрати всі доступні','select-all'),button('Зняти вибір','select-none'));fieldArea.appendChild(actions);
      fieldArea.appendChild(el('p','lc-muted','Вибрано полів: '+chosen().length+'. Решта ручних текстів збережеться.'));
      groups.forEach(function(group){
        var details=el('details','ai-select-row'),summary=el('summary','',group.label),wrap=el('div','ai-fields');
        details.dataset.runGroup=group.id;
        group.fields.forEach(function(f){
          var input=check(wrap,f.label,f.path,selected.has(f.path)&&eligible(f),!eligible(f));
          var preview=el('small','lc-muted',text(f.currentValue).replace(/\s+/g,' ').slice(0,120)||'Порожнє поле');input.parentNode.appendChild(preview);
        });
        append(details,summary,wrap);fieldArea.appendChild(details);
      });
    }
    function renderLinks() {
      linksArea.replaceChildren();
      if(existing.length) {
        linksArea.appendChild(el('h4','','Збережені точні посилання'));
        existing.forEach(function(item){var n=el('p','lc-muted',((fields.find(function(f){return f.path===item.fieldPath;})||{}).label||'Текстове поле')+' · '+item.anchor+' → '+item.url+' · '+(item.count||1));n.dataset.runInsertion=item.id;linksArea.appendChild(n);});
      }
      if(html || draft.mode==='manual')return;
      var available=fields.filter(function(f){return insertionField(f.path);});
      if(!available.length)return;
      var details=el('details'),summary=el('summary','','Додати посилання всередину тексту'),body=el('div','lc-form-grid');append(details,summary,body);linksArea.appendChild(details);
      body.appendChild(el('p','lc-muted','Адресу й анкор буде вставлено точно. Наявні посилання не змінюються.'));
      var target=labelField(body,'Поле для посилання','linkField','select');available.forEach(function(f){option(target,f.path,f.label);});target.value=draft.linkField;
      labelField(body,'Точна адреса URL','linkUrl','text',draft.linkUrl);
      labelField(body,'Точний текст посилання','linkAnchor','text',draft.linkAnchor,2000);
      var count=labelField(body,'Кількість у цьому полі','linkCount','text',draft.linkCount);count.type='number';count.min='1';count.max='10';
      body.appendChild(button('Додати посилання','add-link'));
      added.forEach(function(item){var row=el('div','lc-placement');row.dataset.runInsertion=item.id;append(row,el('p','',((fields.find(function(f){return f.path===item.fieldPath;})||{}).label||'Текстове поле')+' · '+item.anchor+' → '+item.url+' · '+item.count));var remove=button('Прибрати','remove-link');remove.dataset.runId=item.id;row.appendChild(remove);linksArea.appendChild(row);});
    }
    function renderLaunch() {
      launchArea.replaceChildren();
      if(pending){
        if(pending.state==='submitting')launchArea.appendChild(el('p','lc-muted','Надсилаємо запуск…'));
        else if(pending.state==='uncertain'&&!pending.runId) {
          launchArea.appendChild(el('p','lc-notice','Результат запуску невідомий. Форму зафіксовано; новий запуск заблокований.'));
          launchArea.appendChild(button('Перевірити й повторити той самий запит','retry'));
        } else launchArea.appendChild(el('p','lc-muted','Запуск: '+(states[pending.state]||'Прийнято')+'.'));
      } else if(runs.some(active))launchArea.appendChild(el('p','lc-muted','Для сторінки вже є активний запуск. Його стан показано нижче.'));
      else if(stale)launchArea.appendChild(el('p','lc-notice','Сторінку вже змінено. Закрийте панель і відкрийте актуальну версію.'));
      var submit=el('button','lc-btn lc-primary');submit.type='submit';submit.dataset.runSubmit='';
      submit.textContent=draft.status==='publish'?(chosen().length?'Згенерувати й опублікувати':'Опублікувати збережену сторінку'):draft.status==='draft'?(chosen().length?'Згенерувати й створити чернетку':'Створити чернетку WordPress'):(chosen().length?'Згенерувати для перегляду':'Підготувати для перегляду');
      submit.disabled=lock();launchArea.appendChild(submit);
      launchArea.querySelectorAll('[data-run-action]').forEach(function(b){b.disabled=busy||loading;});
    }
    function renderHistory() {
      history.replaceChildren();history.appendChild(el('h4','','Запуски сторінки'));
      var refreshButton=button(loading?'Оновлюємо…':'Оновити стан','refresh');refreshButton.disabled=loading||busy;history.appendChild(refreshButton);
      if(!runs.length)history.appendChild(el('p','lc-muted',loaded?'Запусків ще немає.':'Завантажте стан перед запуском.'));
      runs.forEach(function(run){
        var row=el('div','lc-row');row.dataset.runId=run.id;
        append(row,el('strong','',states[run.state]||'Невідомий стан'));
        if(run.result&&run.result.jobId)row.appendChild(el('p','lc-muted','Передано до завдання публікації. Остаточний результат дивіться у списку завдань.'));
        if(run.error&&errors[run.error.code])row.appendChild(el('p','lc-muted',errors[run.error.code]));
        if(run.state==='queued'||run.state==='running') {var pause=button('Призупинити','pause');pause.dataset.runId=run.id;pause.disabled=busy;row.appendChild(pause);}
        if(run.state==='paused'||run.state==='failed'&&run.retryable===true){var resume=button(run.state==='failed'?'Продовжити зі збереженої частини':'Продовжити','resume');resume.dataset.runId=run.id;resume.disabled=busy;row.appendChild(resume);}
        if(run.state==='failed'&&run.retryable===true)row.appendChild(el('p','lc-muted','Готові частини та ключі запитів збережено. Продовження повторить лише безпечно невдалу частину.'));
        if(run.state==='running')row.appendChild(el('small','lc-muted','Поточний запит може завершитися після паузи.'));
        if(run.state==='uncertain')row.appendChild(el('p','lc-muted','Автоматичне повторення вимкнено: спершу потрібна звірка результату.'));
        history.appendChild(row);
      });
    }
    function render() {
      if(disposed)return;
      root.replaceChildren();root.classList.add('lc-workflow','pp-runs');
      append(root,el('h3','','Генерація та публікація'),el('p','lc-muted',page.title||'Поточна сторінка'));
      notice=el('p');root.appendChild(notice);notify(message,bad);
      form=el('form');form.dataset.runForm='';formFields=el('fieldset','lc-form-grid');formFields.disabled=lock();formFields.appendChild(el('legend','','Параметри запуску'));
      labelField(formFields,'Ключове слово або тема','topic','text',draft.topic,1000);
      labelField(formFields,'Мова текстів','language','text',draft.language,100);
      labelField(formFields,'Країна або регіон','country','text',draft.country,100);
      labelField(formFields,'Побажання до текстів','instructions','textarea',draft.instructions,6000);
      var output=labelField(formFields,'Результат запуску','status','select');option(output,'review','Зберегти для перегляду');option(output,'draft','Чернетка WordPress');option(output,'publish','Опублікувати у WordPress');output.value=draft.status;
      var site=labelField(formFields,'Сайт для WordPress','siteId','select');option(site,'','Без сайту — лише перегляд');
      sites.forEach(function(s){option(site,s.id,s.name+(ready(s)?'':' — спочатку перевірте доступ'),!ready(s));});site.value=draft.siteId;
      fieldArea=el('div','pp-run-fields');formFields.appendChild(fieldArea);renderFields();
      linksArea=el('div','pp-run-links');formFields.appendChild(linksArea);renderLinks();
      launchArea=el('div','lc-actions');append(form,formFields,launchArea);root.appendChild(form);renderLaunch();
      history=el('section');root.appendChild(history);renderHistory();
    }
    function accept(run,response) {
      if(!run || typeof run.id!=='string' || !run.id || (run.pageId && run.pageId!==page.id))throw {code:'invalid_response'};
      if(pending) {if(run.idempotencyKey!==pending.body.idempotencyKey)throw {code:'invalid_response'};pending.state=run.state;pending.runId=run.id;if(run.state==='failed'||(['review','completed'].indexOf(run.state)>=0&&page.revision>pending.body.expectedRevision))pending=null;save();}
      var index=runs.findIndex(function(r){return r.id===run.id;});if(index<0)runs.unshift(clone(run));else runs[index]=clone(run);
      var signature=JSON.stringify([run.id,run.state,run.updatedAt,run.result]);
      if(signature!==changed){changed=signature;if(typeof options.onChanged==='function') {try{options.onChanged(response&&response.page?clone(response.page):null,{pageId:page.id,run:clone(run)});}catch(_){}}}
    }
    async function refresh() {
      if(disposed)return;
      var serial=++loadSequence,token=epoch;loading=true;renderHistory();renderLaunch();
      try {
        var result=await options.request('/pages/'+encodeURIComponent(page.id)+'/runs','GET');
        if(disposed||token!==epoch||serial!==loadSequence)return;
        if(!result||!Array.isArray(result.runs))throw {code:'invalid_response'};
        runs=result.runs.filter(function(r){return r&&typeof r.id==='string'&&(!r.pageId||r.pageId===page.id);}).map(clone);loaded=true;
        if(pending){var found=runs.find(function(r){return r.idempotencyKey===pending.body.idempotencyKey;});if(found)accept(found,result);}
      } catch(error){if(!disposed&&token===epoch)notify(errorText(error),true);throw error;}
      finally{if(!disposed&&token===epoch&&serial===loadSequence){loading=false;render();schedule();}}
    }
    function body() {
      var paths=chosen(),links=paths.length?existing.concat(added):[];
      if(draft.status!=='review'&&!ready(sites.find(function(s){return s.id===draft.siteId;})))throw new Error('Спочатку виберіть і перевірте доступ до сайту.');
      if(added.length&&!paths.length)throw new Error('Виберіть поля для доданих посилань або приберіть нові вставки.');
      if(!html) {
        var plan=engine.makePlan(config,{mode:'selected',paths:paths,linkInsertions:paths.length?added:[]});
        if(added.some(function(item){return !plan.targets.some(function(target){return target.fieldPath===item.fieldPath;});}))throw new Error('Виберіть усі поля для доданих посилань.');
      }
      var key;
      if(win.crypto&&typeof win.crypto.randomUUID==='function')key=win.crypto.randomUUID();
      else {
        if(!win.crypto||typeof win.crypto.getRandomValues!=='function')throw new Error('Браузер не може створити безпечний ключ запуску.');
        var bytes=win.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
        var hex=Array.from(bytes,function(b){return b.toString(16).padStart(2,'0');}).join('');key=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
      }
      return {expectedRevision:page.revision,idempotencyKey:key,status:draft.status,siteId:draft.siteId||null,paths:paths,brief:{topic:draft.topic,language:draft.language,country:draft.country,instructions:draft.instructions},linkInsertions:links};
    }
    async function dispatch() {
      var token=epoch;busy=true;pending.state='submitting';
      if(!save()){pending.state='uncertain';busy=false;notify('Браузер не зміг зберегти ключ запуску. Запит не надіслано; перевірте доступ до сховища.',true);render();return;}render();
      try {
        var result=await options.request('/pages/'+encodeURIComponent(page.id)+'/runs','POST',clone(pending.body));
        if(disposed||token!==epoch)return;
        accept(result&&result.run,result);notify('Запуск прийнято. Стан оновлюється нижче.',false);
      } catch(error) {
        if(disposed||token!==epoch)return;
        if(error&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&error.status!==408) {pending=null;stale=error.status===409;save();notify(errorText(error),true);}
        else {pending.state='uncertain';save();notify('Сервер не підтвердив результат. Повторення можливе лише з тим самим ключем.',true);}
      } finally{if(!disposed&&token===epoch){busy=false;render();schedule();}}
    }
    async function submit(event) {
      event.preventDefault();if(disposed||lock())return;
      try{var payload=body();pending={pageId:page.id,projectId:page.projectId,body:clone(payload),state:'submitting'};if(!save()){pending=null;throw new Error('Браузер не зміг зберегти ключ запуску. Перевірте доступ до сховища.');}await dispatch();}
      catch(error){notify(error.message||errorText(error),true);}
    }
    async function action(event) {
      var buttonNode=event.target.closest('[data-run-action]');if(!buttonNode||!root.contains(buttonNode)||buttonNode.disabled||disposed)return;
      var action=buttonNode.dataset.runAction;if(busy)return;
      if(action==='refresh'){try{await refresh();}catch(_){}return;}
      if(action==='retry') {
        if(!pending||pending.state!=='uncertain'||pending.runId)return;
        busy=true;render();
        try{await refresh();if(disposed)return;if(pending&&pending.state==='uncertain'&&!pending.runId)await dispatch();}
        catch(error){if(!disposed)notify('Стан не перевірено. Запит повторно не надсилався.',true);}
        finally{if(!disposed){busy=false;render();}}return;
      }
      if(action==='pause'||action==='resume') {
        var run=runs.find(function(r){return r.id===buttonNode.dataset.runId;});
        if(!run || (action==='pause'&&!['queued','running'].includes(run.state)) || (action==='resume'&&run.state!=='paused'&&!(run.state==='failed'&&run.retryable===true)))return;
        busy=true;render();var token=epoch;
        try{await options.request('/runs/'+encodeURIComponent(run.id)+'/'+action,'POST',{});if(disposed||token!==epoch)return;await refresh();}
        catch(error){if(!disposed&&token===epoch)notify(errorText(error),true);}
        finally{if(!disposed&&token===epoch){busy=false;render();}}return;
      }
      if(lock())return;
      if(action==='select-all')fields.filter(eligible).forEach(function(f){selected.add(f.path);});
      else if(action==='select-none')selected.clear();
      else if(action==='remove-link')added=added.filter(function(item){return item.id!==buttonNode.dataset.runId;});
      else if(action==='add-link') {
        try {
          var entry={id:'run-link-'+Date.now().toString(36)+'-'+(++sequence),fieldPath:draft.linkField,url:draft.linkUrl,anchor:draft.linkAnchor,count:Number(draft.linkCount)};
          engine.makePlan(config,{mode:'selected',paths:[entry.fieldPath],linkInsertions:added.concat(entry)});
          added.push(entry);selected.add(entry.fieldPath);if(fields.some(function(f){return f.path===entry.fieldPath&&text(f.currentValue).trim();}))draft.mode='selected';
          draft.linkUrl='';draft.linkAnchor='';notify('Точне посилання додано до плану.',false);
        }catch(error){notify(error.message||'Перевірте адресу й анкор.',true);return;}
      }
      render();
    }
    function input(event) {
      var control=event.target;if(lock())return;
      if(control.dataset.runPath) {if(control.checked)selected.add(control.dataset.runPath);else selected.delete(control.dataset.runPath);if(event.type==='change'){renderLaunch();var n=fieldArea.querySelector('p.lc-muted');if(n)n.textContent='Вибрано полів: '+chosen().length+'. Решта ручних текстів збережеться.';}return;}
      var name=control.name;if(!Object.prototype.hasOwnProperty.call(draft,name))return;draft[name]=control.value;
      if(event.type==='change'&&['mode','status','siteId'].indexOf(name)>=0)render();
    }
    root.addEventListener('submit',submit);root.addEventListener('click',action);root.addEventListener('input',input);root.addEventListener('change',input);
    render();
    return {refresh:refresh,destroy:function(){if(disposed)return;disposed=true;epoch++;stop();root.removeEventListener('submit',submit);root.removeEventListener('click',action);root.removeEventListener('input',input);root.removeEventListener('change',input);}};
  }
  return Object.freeze({create:create});
}));
