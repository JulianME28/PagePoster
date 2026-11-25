(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PagePosterLifecycleUI = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var instance = 0;
  var labels = {
    queued: 'У черзі', running: 'Виконується', completed: 'Завершено', failed: 'Помилка',
    paused: 'Призупинено', uncertain: 'Потребує звірки', saved: 'Збережено', local: 'Збережено у проєкті',
    draft: 'Чернетка WordPress', publish: 'Опубліковано', published: 'Опубліковано', monitored: 'Під наглядом',
    monitoring: 'Під наглядом', imported: 'Додано до реєстру', pending: 'Ще не перевірено', unknown: 'Невідомо',
    setup_required: 'Потрібне налаштування', active: 'Активний', inactive: 'Не активований', missing: 'Не встановлений', discovered: 'Знайдено, перевірка ще потрібна', ok: 'Гаразд', problem: 'Проблема', error: 'Помилка', blocked: 'Заблоковано', noindex: 'Noindex',
    review_required: 'Потрібна перевірка', review_needed: 'Потрібна перевірка', conflict: 'Конфлікт версій', rejected: 'Відхилено',
    not_applicable: 'Не застосовується', disabled: 'Вимкнено', enabled: 'Увімкнено', ready: 'Готово', verified: 'Перевірено й готово', verification_pending: 'Очікує перевірки', archived: 'В архіві', resolved: 'Усунено', open: 'Відкрита проблема'
  };
  var errors = {CONTENT_FACT_REVIEW_REQUIRED:'Перевірте факти в тексті: знайдено непідтверджене або суперечливе твердження. Відкрийте редактор і виправте матеріал.',URL_TOO_LONG:'Адреса довша за 4000 символів. Її збережено без обрізання; виправте адресу вручну.',AI_REQUEST_INVALID:'OpenAI не прийняв запит. Перевірте параметри тексту.',AI_AUTH_FAILED:'OpenAI не прийняв ключ. Оновіть його в налаштуваннях ШІ.',AI_ACCESS_DENIED:'Ключ OpenAI не має доступу до цієї дії. Перевірте права проєкту.',AI_MODEL_UNAVAILABLE:'Обрана модель недоступна для цього ключа. Перевірте налаштування ШІ.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Продовжіть запуск пізніше.',AI_PROVIDER_UNAVAILABLE:'OpenAI тимчасово недоступний. Продовжіть запуск пізніше.',AI_NETWORK_ERROR:'Не вдалося з’єднатися з OpenAI. Перевірте підключення.',AI_TIMEOUT:'OpenAI не відповів вчасно. Перед повторенням звірте результат запиту.',AI_CANCELLED:'Запит ШІ зупинено. Завершені частини збережено.',AI_REFUSED:'OpenAI відмовив у генерації цього тексту. Змініть завдання або заповніть текст вручну.',
    IMPORT_LINK_COLLISION:'У цьому HTML неможливо залишити кожну адресу лише один раз без зміни його структури. Відкрийте сторінку в редакторі для перегляду.', IMPORT_NOT_SUPPORTED:'Сторінку не можна під’єднати до керованого редагування. Перевірте попередження імпорту.', CONTENT_DUPLICATE:'Згенерований текст повторює іншу сторінку. Відкрийте матеріал у редакторі та змініть його перед публікацією.', BACKUP_PASSWORD_INVALID:'Пароль не відкриває цю копію або файл пошкоджений. Перевірте пароль і вибраний файл.', RECOVERY_BUSY:'Сервер зараз виконує операції. Дочекайтеся їх завершення та повторіть дію.', CLIPBOARD_UNAVAILABLE:'Браузер не дозволяє копіювання. Виділіть повну адресу й скопіюйте її вручну.', PROJECT_ARCHIVED:'Проєкт в архіві. Поверніть його через налаштування перед новим запуском.', CAPACITY_EXCEEDED:'Досягнуто ліміт сторінок, включно з чергою.',RESTORE_NOT_EMPTY:'Відновлення можливе лише у порожню базу.',BACKUP_SECRET:'Пароль знайдено в тексті сторінки. Приберіть його перед експортом.',PRECHECK_FAILED:'Свіжа перевірка не пройдена. Відкрийте результати перевірок сторінки.',
    RECOVERY_TOO_LARGE: 'Повна захищена копія завелика. Ліміт файлу — 150 МБ.', BACKUP_INVALID: 'Це не коректна резервна копія PagePoster.', BACKUP_TOO_LARGE: 'Файл завеликий для цього імпорту. Ліміт — 50 МБ.', DATABASE_NOT_EMPTY: 'Відновлення можливе лише в порожній робочий простір.',
    PAGE_LIMIT: 'Досягнуто ліміт сторінок для цього запуску.', pp_bridge_required: 'Встановіть та активуйте PagePoster Bridge, потім перевірте доступ.', pp_bridge_conflict: 'Сторінку WordPress уже змінено. Потрібна нова перевірка.', pp_bridge_uncertain: 'Результат запису ще не підтверджено. Виконайте звірку.', disabled: 'Сайт вимкнено. Увімкніть його у розділі «Сайти».',
    BRIDGE_REQUIRED: 'Встановіть і активуйте PagePoster Bridge на сайті, а потім перевірте доступ.', BRIDGE_UNSUPPORTED: 'Оновіть PagePoster Bridge та перевірте доступ.', SITE_NOT_READY: 'Спочатку перевірте доступ до сайту у розділі «Сайти».',
    bridge_required: 'Встановіть і активуйте PagePoster Bridge, а потім перевірте доступ.', review_needed: 'Потрібна перевірка поточного стану сторінки.',
    CONFLICT: 'Запис уже змінено. Оновіть список і повторно перевірте дані.', VALIDATION: 'Перевірте заповнені поля та адреси.',
    KEY_REQUIRED: 'На сервері не налаштовано шифрування доступів.', ENCRYPTION_UNAVAILABLE: 'На сервері не налаштовано шифрування доступів.', NOT_FOUND: 'Запис не знайдено.',
    auth_failed: 'Неправильні реквізити доступу до сайту.', forbidden: 'Недостатньо прав для цієї дії.',
    not_configured: 'Сервер ще не налаштовано.', credential_storage_unavailable: 'На сервері не налаштовано шифрування доступів.',
    conflict: 'Запис уже змінено. Оновіть список і повторно перевірте дані.', revision_conflict: 'Запис уже змінено. Оновіть список і повторно перевірте дані.',
    timeout: 'Сайт не відповів вчасно. Стан можна перевірити повторно.', network_error: 'Не вдалося з’єднатися із сервером.',
    invalid_url: 'Перевірте адресу: потрібне повне HTTPS-посилання.', invalid_input: 'Перевірте заповнені поля.',
    rate_limited: 'Забагато запитів. Спробуйте пізніше.', site_disabled: 'Перевірки цього сайту вимкнено.',
    page_missing: 'Сторінку не знайдено.', not_found: 'Запис не знайдено.'
  };
  function text(value) { return value == null ? '' : String(value); }
  function list(value) { return Array.isArray(value) ? value : []; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function safeUrl(value) {
    try { var u = new URL(text(value)); return u.protocol === 'https:' && !u.username && !u.password ? text(value) : ''; }
    catch (_) { return ''; }
  }
  function pageState(page) {
    var state = page.lifecycleState || page.state || 'saved';
    if (state === 'draft' && !page.remoteSnapshot) return page.fullUrl ? 'monitored' : 'local';
    return state;
  }
  function hasConfig(page) { return page.config && typeof page.config === 'object' && Object.keys(page.config).length > 0; }
  function nativeCheckStatusText(status) {
    var counted=Number.isSafeInteger(status?.attempt)&&Number.isSafeInteger(status?.limit)&&status.attempt>=1&&status.attempt<=status.limit&&status.limit<=3;
    if(status?.state==='problem')return 'Перевірка опублікованої сторінки виявила проблему. Наступна публікація чекає підтвердження.';
    if(status?.code==='NATIVE_CHECK_RETRIES_EXHAUSTED')return 'Не вдалося підтвердити перевірку після '+(counted?status.attempt:3)+' спроб. Можна запустити повторну перевірку сторінки.';
    if(status?.state==='unknown')return 'Перевірку опублікованої сторінки ще не підтверджено. Наступна публікація чекає звірки.';
    if(status?.state==='pending')return 'Запис підтверджено. Перевіряємо опубліковану сторінку та переходи.'+(counted?' Спроба '+status.attempt+' із '+status.limit+'.':'');
    if(status?.state==='ok')return 'Перевірку пройдено. Завершуємо підтвердження поточної сторінки.';
    return 'Запис підтверджено. Результат перевірки опублікованої сторінки ще не підтверджено.';
  }
  function nativeReason(capability) {var reasons={NATIVE_ACCESS_REQUIRED:'Потрібний звичайний логін WordPress для цієї сторінки.',NATIVE_BROWSER_REQUIRED:'Для заміни потрібна настільна версія PagePoster і звичайний логін WordPress.',NATIVE_SNAPSHOT_UNAVAILABLE:'Немає підтвердженої копії опублікованої сторінки. Заміна недоступна.',NATIVE_BINDING_UNAVAILABLE:'Не підтверджено прив’язку до цієї сторінки WordPress.',NATIVE_SOURCE_UNAVAILABLE:'Не підтверджено джерело сторінки. Заміна недоступна.',NATIVE_UPDATE_PENDING:'Попередня заміна ще не підтверджена. Спочатку звірте результат.',disabled:'Цей сайт вимкнено. Заміна недоступна.'};return reasons[capability&&capability.reason]||'Заміна для цієї сторінки зараз недоступна. Оновіть її стан.';}
  function statusText(value) { return labels[value] || text(value) || 'Ще не перевірено'; }
  function errorText(error) {
    var code = error && (error.code || error.errorCode);
    if(/^NATIVE_/.test(code||''))return nativeReason({reason:code});
    if (errors[code]) return errors[code];
    if (error && error.status === 409) return errors.conflict;
    if (error && (error.status === 401 || error.status === 403)) return 'Немає доступу до цієї дії. Перевірте підключення.';
    return 'Не вдалося виконати дію. Оновіть дані або повторіть спробу.';
  }
  function create(options) {
    options = options || {};
    var root = options.element;
    if (!root || !root.ownerDocument) throw new TypeError('Lifecycle UI requires an element.');
    var doc = root.ownerDocument, win = doc.defaultView, prefix = 'lc-' + (++instance) + '-';
    var fetcher = options.fetchImpl || (win.fetch && win.fetch.bind(win));
    var disposed = false, epoch = 0, loadId = 0, checksId = 0, timer = null, polls = 0;
    var status = null, projects = [], selected = '', tab = options.initialTab || 'pages', pages = [], sites = [], jobs = [], events = [], overview = null;
    var importPanel, recoveryDraft = null;
    var composerPanel, showArchived = false, batchDraft = null, batchSelection = new Set(), batchPlacements = [], batches = [], importDraft = null, extraLoad = 0;
    var search = '', filter = '', notice, layout, sidebar, projectList, workspace, content, rowList, checksPanel;
    var pendingControllers = new Set();
    var runPanel, runUI=null, campaignUI=null;
    var restorePanel, restoreDraft = null, restoreReadId = 0;
    var workflowPanel, flow = null, flowId = 0, launches = {}, launchStorageKey = 'pageposter.lifecycle.launches.v1';
    try { var stored = JSON.parse(win.sessionStorage.getItem(launchStorageKey) || '{}'); if (stored && typeof stored === 'object' && !Array.isArray(stored)) launches = stored;Object.keys(launches).forEach(function(key){if(launches[key] && launches[key].state==='submitting')launches[key].state='uncertain';}); } catch (_) {}
    root.classList.add('lc-root');

    function el(tag, className, value) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = text(value);
      return node;
    }
    function append(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
    function clear(node) {if(node)node.querySelectorAll('[name=nativePassword]').forEach(function(input){input.value='';});while (node && node.firstChild) node.removeChild(node.firstChild); }
    function button(label, action, id, primary) {
      var node = el('button', primary ? 'lc-btn lc-primary' : 'lc-btn', label);
      node.type = 'button';
      if (action) node.dataset.lcAction = action;
      if (id) node.dataset.lcId = id;
      return node;
    }
    function field(form, label, name, type, value, required) {
      var wrap = el('div', 'lc-field'), control = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
      var id = prefix + name + '-' + (++instance);
      control.id = id; control.name = name;
      if (control.tagName === 'INPUT') control.type = type || 'text';
      if (value !== undefined) control.value = text(value);
      if (required) control.required = true;
      if (type !== 'password') control.maxLength = type === 'textarea' ? 4000 : 2000;
      var labelNode = el('label', '', label); labelNode.htmlFor = id;
      append(wrap, labelNode, control); form.appendChild(wrap); return control;
    }
    function option(select, value, label) { var item = el('option', '', label); item.value = value; select.appendChild(item); }
    function message(value, bad) {
      if (disposed || !notice) return;
      notice.textContent = value;
      notice.className = 'lc-notice' + (bad ? ' lc-error' : '');
      notice.hidden = !value;
      notice.setAttribute('role', bad ? 'alert' : 'status');
    }
    function toast(value) { if (!disposed && typeof options.toast === 'function') options.toast(value); }
    function badge(state) {
      var node = el('span', 'lc-badge', statusText(state));
      if (['failed','error','problem','blocked','conflict','review_needed','review_required'].indexOf(state) >= 0) node.classList.add('lc-bad');
      if (['ok','ready','verified','resolved'].indexOf(state) >= 0) node.classList.add('lc-good');
      return node;
    }
    function fullLink(value) {
      var href = safeUrl(value), node = el(href ? 'a' : 'span', 'lc-url', value || 'Адресу ще не додано');
      if (href) { node.setAttribute('href', href); node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      return node;
    }
    function date(value) {
      if (!value) return '';
      var parsed = new Date(value);
      return isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('uk-UA');
    }
    async function request(path, method, payload) {
      if (!fetcher) throw { code: 'network_error' };
      var controller = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      if (controller) pendingControllers.add(controller);
      var init = { method: method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
      if (controller) init.signal = controller.signal;
      if (payload !== undefined) { init.headers['Content-Type'] = 'application/json'; init.headers['X-PagePoster-Request'] = '1'; init.body = JSON.stringify(payload); }
      try {
        var response = await fetcher((path.indexOf('/recovery/')===0?'/api':'/api/lifecycle') + path, init);
        var data;
        try { data = await response.json(); } catch (_) { throw { code: 'invalid_response', status: response.status }; }
        if (!response.ok) throw { code: data.code || data.errorCode, status: response.status };
        return data;
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        if (error && (error.code || error.status)) throw error;
        throw { code: 'network_error' };
      } finally { if (controller) pendingControllers.delete(controller); }
    }
    function stopPolling() { if (timer !== null) win.clearTimeout(timer); timer = null; }
    function visible() { return !disposed && !root.hidden && !root.closest('[hidden]') && doc.visibilityState !== 'hidden'; }
    function schedulePoll() {
      stopPolling();
      if (!selected || !status || !status.available || polls >= 60) return;
      timer = win.setTimeout(async function () {
        timer = null;
        if (!visible()) return;
        polls++;
        await loadProject(epoch, false);
      }, 5000);
    }
    function closeRuns(){if(runUI)runUI.destroy();runUI=null;if(runPanel){clear(runPanel);runPanel.hidden=true;}}
    function closeCampaigns(){if(campaignUI)campaignUI.destroy();campaignUI=null;}
    function shell() {
      closeCampaigns();closeRuns();clear(root);
      var head = el('div', 'lc-heading'), title = el('div');
      append(title, el('p', 'lc-eyebrow', 'PAGEPOSTER / РОБОЧИЙ ПРОСТІР'), el('h2', '', 'Проєкти та сторінки'), el('p', 'lc-muted', 'Зберігайте матеріали, підключайте свої сайти й перевіряйте готові сторінки.'));
      var actions=el('div','lc-actions'),backups=el('details','lc-backup-menu');backups.appendChild(el('summary','','Резервні копії'));
      var backupActions=el('div','lc-menu-actions');append(backupActions,button('Експорт матеріалів','backup'),button('Імпорт копії','restore-backup'),button('Захищена копія','recovery'));backups.appendChild(backupActions);append(actions,button('Оновити','refresh'),backups);
      append(head, title, actions); root.appendChild(head);
      notice = el('div', 'lc-notice'); notice.hidden = true; notice.setAttribute('aria-live', 'polite'); root.appendChild(notice);
      restoreDraft=null;recoveryDraft=null;restoreReadId++;restorePanel=el('section','lc-workflow lc-restore');restorePanel.hidden=true;root.appendChild(restorePanel);
      composerPanel=el('section','lc-workflow lc-composer');composerPanel.hidden=true;root.appendChild(composerPanel);
      runPanel=el('section','lc-workflow');runPanel.hidden=true;root.appendChild(runPanel);
      layout = el('div'); root.appendChild(layout);
    }
    function unavailable() {
      clear(layout); layout.className = '';
      var card = el('div', 'lc-empty lc-unavailable');
      append(card, el('h3', '', 'Для проєктів потрібен локальний сервер'), el('p', '', 'Запустіть локальний PagePoster через Start-PagePoster.cmd і відкрийте адресу, яку він покаже. Онлайн-версія або окремий HTML поки не мають цього серверного реєстру.'), el('p', 'lc-muted', 'Редактор і експорт HTML залишаються доступними. Ваші тексти тут не змінюються.'));
      var local=el('a','lc-btn lc-primary','Відкрити локальний PagePoster');local.href='http://127.0.0.1:4317/?workspace=projects';local.target='_blank';local.rel='noopener';card.appendChild(local);
      layout.appendChild(card);
      var backup = root.querySelector('[data-lc-action="backup"]'); if (backup) backup.disabled = true;var restore=root.querySelector('[data-lc-action="restore-backup"]');if(restore)restore.disabled=true;var recovery=root.querySelector('[data-lc-action="recovery"]');if(recovery)recovery.disabled=true;
    }
    function buildLayout() {
      clear(layout); layout.className = 'lc-layout';
      sidebar = el('aside', 'lc-sidebar'); sidebar.setAttribute('aria-label', 'Проєкти');
      append(sidebar, el('h3', '', 'Мої проєкти'));
      projectList = el('div', 'lc-project-list'); sidebar.appendChild(projectList);
      sidebar.appendChild(button('Показати архів', 'show-archived'));
      var details = el('details', 'lc-create'); details.open = !projects.length;
      append(details, el('summary', '', '+ Новий проєкт'));
      var form = el('form', 'lc-form'); form.dataset.lcForm = 'project';
      field(form, 'Назва проєкту', 'projectName', 'text', '', true);
      field(form, 'Опис / примітка', 'projectDescription', 'textarea');
      field(form,'Країна','projectCountry','text');
      var language = field(form, 'Мова', 'projectLanguage', 'select');
      [['uk','Українська'],['pl','Польська'],['en','Англійська'],['de','Німецька'],['other','Інша']].forEach(function (item) { option(language,item[0],item[1]); });
      var add = button('Створити проєкт', null, null, true); add.type = 'submit'; form.appendChild(add); details.appendChild(form); sidebar.appendChild(details);
      workspace = el('div', 'lc-workspace'); append(layout, sidebar, workspace); renderProjects(); renderWorkspace();
    }
    function renderProjects() {
      clear(projectList);
      if (!projects.length) projectList.appendChild(el('p', 'lc-muted', 'Створіть перший проєкт для збереження сторінок.'));
      projects.filter(function(p){return showArchived || !p.archived || p.id===selected;}).forEach(function (project) {
        var b = button((project.name || 'Без назви')+(project.archived?' · Архів':'')); b.className = 'lc-project'; b.dataset.lcProject = project.id;
        if (selected === project.id) b.setAttribute('aria-current','true');
        projectList.appendChild(b);
      });
    }
    function renderWorkspace() {
      closeCampaigns();clear(workspace);root.dataset.lcSelected=String(!!selected);
      if (!selected) {
        var welcome=el('section','lc-welcome');append(welcome,el('p','lc-eyebrow','ПОЧНІТЬ ІЗ ПРОЄКТУ'),el('h3','','Автоматично створюйте сторінки у WordPress'),el('p','lc-muted','Створіть перший проєкт у формі ліворуч. Далі вкажіть теми й посилання: тул сам згенерує сторінки та передасть їх у WordPress. Сайти можна підключити пізніше, а зараз зберігати результат для перегляду.'));
        var features=el('div','lc-start-grid');[['Сторінки та тексти','Тема, точні посилання, готовий HTML, ручне або ШІ-заповнення.'],['WordPress і публікація','Сайти, доступи, плагіни, чернетки та запуск публікації.'],['Моніторинг і зміни','Повні адреси, noindex, доступність, заміна посилань із підтвердженням та історія.']].forEach(function(item){var card=el('div','lc-card');append(card,el('h4','',item[0]),el('p','lc-muted',item[1]));features.appendChild(card);});welcome.appendChild(features);welcome.appendChild(button('Перейти до редактора','editor-html'));workspace.appendChild(welcome);return;
      }
      var project = projects.find(function (p) { return p.id === selected; });
      var head = el('div', 'lc-project-heading');
      var headingCopy=el('div','lc-project-title');append(headingCopy,el('h3','',project ? project.name : 'Проєкт'));
      if(project && project.description)headingCopy.appendChild(el('p','lc-muted',project.description));
      if(project && project.archived)headingCopy.appendChild(badge('archived'));head.appendChild(headingCopy);
      var createPages=tabButton('Створити сторінки','campaigns');createPages.className='lc-btn lc-primary';head.appendChild(createPages);workspace.appendChild(head);
      var nav = el('nav','lc-tabs'); nav.setAttribute('aria-label','Розділи проєкту');
      [['pages','Сторінки'],['sites','Сайти'],['settings','Налаштування']].forEach(function (item) {
        var b = button(item[1]); b.dataset.lcTab = item[0]; b.setAttribute('aria-pressed',String(tab === item[0])); nav.appendChild(b);
      }); workspace.appendChild(nav);
      content = el('div','lc-content'); content.setAttribute('aria-busy','false'); workspace.appendChild(content);
      if(['pages','sites','settings'].indexOf(tab)<0){var context=el('div','lc-context-nav');context.appendChild(tabButton('← До сторінок','pages'));content.appendChild(context);}
      if(tab==='settings')settingsView();else if(tab==='replacements')replacementBatchView();else if(tab==='campaigns')campaignView();else if(tab==='overview')overviewView();else if(tab==='monitor')monitorView();else if (tab === 'pages') pageView(); else if (tab === 'sites') siteView(); else listView();
    }
    function tabButton(label, destination) {var b=button(label);b.dataset.lcTab=destination;return b;}
    function secondaryTools() {
      var details=el('details','lc-secondary-tools');details.appendChild(el('summary','','Журнал і детальні перевірки'));
      var actions=el('div','lc-menu-actions');[['monitor','Усі перевірки'],['jobs','Завдання сервера'],['history','Історія змін'],['overview','Зведення проєкту']].forEach(function(item){actions.appendChild(tabButton(item[1],item[0]));});details.appendChild(actions);return details;
    }
    function checkMap(pageId) {var row=overview&&list(overview.pages).find(function(p){return p.pageId===pageId;});return row?list(row.checks):[];}
    function campaignView() {
      if(!win.PagePosterCampaignUI){content.appendChild(el('p','lc-error-text','Оновіть PagePoster: модуль автоматичного запуску не завантажено.'));return;}
      var container=el('section');content.appendChild(container);
      var token=epoch;
      campaignUI=win.PagePosterCampaignUI.create({element:container,project:projects.find(function(p){return p.id===selected;}),sites:sites,request:request,fetchImpl:fetcher,getEditorSnapshot:options.getEditorSnapshot,createPageSnapshot:options.createPageSnapshot,openEditor:options.openEditor,
        onChanged:function(){if(!disposed&&epoch===token){polls=0;loadProject(token,false);}},
        openPage:async function(id){try{var result=await request('/pages/'+encodeURIComponent(id));if(!disposed&&epoch===token&&options.openEditorSnapshot)await options.openEditorSnapshot(result.page.config);}catch(error){message(errorText(error),true);}}
      });
      campaignUI.refresh().catch(function(error){if(!disposed&&epoch===token)message(errorText(error),true);});
    }
    function verification(page) {
      var row=overview&&list(overview.pages).find(function(p){return p.pageId===page.id;});
      return row&&row.verification || page.verification || {state:'pending',summary:'Свіжої повної перевірки ще немає.'};
    }
    function verificationBadge(page) {var result=verification(page),node=badge(result.state==='ok'?'verified':result.state==='pending'?'verification_pending':result.state);node.dataset.lcVerification=result.state;node.title=result.summary||'';return node;}
    function overviewView() {
      var readySites=sites.filter(siteReady),verified=pages.filter(function(p){return verification(p).state==='ok';}),issues=pages.filter(function(p){return verification(p).state==='problem';});
      var pending=pages.filter(function(p){return p.fullUrl&&verification(p).state!=='ok';});
      var next=!readySites.length?{title:'Підключити WordPress',text:'Додайте свій сайт і перевірте доступ. Поки сайт не готовий, матеріали можна зберігати для перегляду.',label:'Підключити сайт',tab:'sites'}:!pages.length?{title:'Підготуйте перші сторінки',text:'Додайте теми й точні посилання. Перевірте матеріал, оберіть сайти та чернетку або публікацію.',label:'Підготувати запуск',tab:'campaigns'}:issues.length?{title:'Перевірте знайдені проблеми',text:'Відкрийте докази й причини. Публікація та підтверджений результат показуються окремо.',label:'Відкрити перевірки',tab:'monitor'}:pending.length?{title:'Перевірте опубліковані сторінки',text:'Є сторінки, для яких повна перевірка ще не підтверджена. Відкрийте результати або запустіть перевірку зараз.',label:'Перевірити результат',tab:'monitor'}:{title:'Продовжіть роботу зі сторінками',text:'Створюйте нові матеріали або перевірте стан уже опублікованих. Повні адреси й історія зберігаються в проєкті.',label:'Підготувати запуск',tab:'campaigns'};
      var automationCard=el('section','lc-automation-banner');append(automationCard,el('p','lc-eyebrow','НАСТУПНИЙ КРОК'),el('h3','',next.title),el('p','lc-muted',next.text),tabButton(next.label,next.tab));content.appendChild(automationCard);
      var metrics=el('div','lc-metrics');
      [['Сторінок у проєкті',pages.length],['Сайтів з доступом',readySites.length],['Перевірено й готово',overview?verified.length:'—'],['Потребують уваги',overview?issues.length:'—']].forEach(function(item){var card=el('div','lc-metric');append(card,el('strong','',item[1]),el('span','',item[0]));metrics.appendChild(card);});content.appendChild(metrics);
      var activity=el('section','lc-card');append(activity,el('h3','','Останні сторінки'));
      if(!pages.length)append(activity,el('p','lc-muted','У проєкті ще немає матеріалів. Почніть із тем та посилань або використайте готовий HTML.'),button('Створити сторінку вручну','new-page'),button('Відкрити готовий HTML','editor-html'));
      pages.slice().reverse().slice(0,5).forEach(function(page){var row=el('div','lc-check-row');append(row,el('strong','',page.title||'Без назви'),badge(pageState(page)));if(page.fullUrl)append(row,verificationBadge(page),fullLink(page.fullUrl));activity.appendChild(row);});activity.appendChild(button('Створити сторінку вручну','new-page'));content.appendChild(activity);
      var runs=list(overview&&overview.runs).filter(function(r){return ['queued','running','paused','uncertain','failed','review'].includes(r.state);});
      if(runs.length){var recent=el('section','lc-card');recent.appendChild(el('h3','','Активні запуски'));runs.slice(0,8).forEach(function(r){var page=pages.find(function(p){return p.id===r.pageId;});var row=el('div','lc-check-row');append(row,el('strong','',page?page.title:'Сторінка'),badge(r.state==='review'?'review_required':r.state),button('Відкрити запуск','automation-page',r.pageId));recent.appendChild(row);});content.appendChild(recent);}
      content.appendChild(el('p','lc-muted lc-verification-note','Сторінка без результатів ще не перевірена. Опубліковано — запис у WordPress завершився. Перевірено й готово — пройдені всі обов’язкові перевірки опублікованого результату.'));
    }
    function settingsView() {
      var project=projects.find(function(p){return p.id===selected;});if(!project)return;
      append(content,el('h3','','Налаштування проєкту'),el('p','lc-muted','Основні дані та правила перевірок для цього проєкту. Зміни зберігаються після натискання кнопки.'));
      content.appendChild(el('p','lc-runtime',status.monitoring && status.monitoring.enabled!==false?'Сервер працює. Моніторинг триває, поки цей комп’ютер увімкнений і PagePoster запущений.':'Фонові перевірки недоступні. Перевірте налаштування сервера.'));
      var form=el('form','lc-form lc-form-grid');form.dataset.lcForm='project-settings';form.dataset.revision=project.revision;
      field(form,'Назва проєкту','settingsName','text',project.name,true);field(form,'Відповідальний / примітка','settingsResponsible','text',project.responsible||'');field(form,'Опис','settingsDescription','textarea',project.description||'');
      field(form,'Мова','settingsLanguage','text',project.language||'uk');field(form,'Країна','settingsCountry','text',project.country||'');field(form,'Теги, через кому','settingsTags','text',list(project.tags).join(', '));
      form.appendChild(el('h4','lc-wide','Моніторинг'));
      var policy=Object.assign({enabled:true,pageIntervalMinutes:360,siteIntervalMinutes:1440,retryMinutes:5,retentionDays:30},project.monitoringPolicy||{});
      var enabled=field(form,'Фонові перевірки','monitoringEnabled','select');option(enabled,'true','Увімкнено');option(enabled,'false','Призупинено');enabled.value=String(policy.enabled!==false);
      [['pageIntervalMinutes','Сторінки — інтервал у хвилинах',15,10080],['siteIntervalMinutes','Доступ до сайтів — інтервал у хвилинах',60,43200],['retryMinutes','Повтор після тимчасової помилки — хвилини',1,60],['retentionDays','Зберігати докази — дні',1,365]].forEach(function(item){var input=field(form,item[1],item[0],'number',policy[item[0]],true);input.min=item[2];input.max=item[3];input.step=1;});
      var save=button('Зберегти налаштування',null,null,true);save.type='submit';form.appendChild(save);content.appendChild(form);
      var archive=el('section','lc-settings-archive');append(archive,el('h4','',project.archived?'Проєкт в архіві':'Архів проєкту'),el('p','lc-muted','Архів зберігає матеріали й історію. Публікації у WordPress не видаляються.'),button(project.archived?'Повернути з архіву':'Архівувати проєкт','archive-project',project.id));content.appendChild(archive);content.appendChild(secondaryTools());
    }
    async function updateProjectSettings(form,token) {
      var payload={name:value(form,'settingsName').trim(),description:value(form,'settingsDescription').trim(),language:value(form,'settingsLanguage').trim(),country:value(form,'settingsCountry').trim(),responsible:value(form,'settingsResponsible').trim(),tags:value(form,'settingsTags').split(',').map(function(t){return t.trim();}).filter(Boolean),expectedRevision:Number(form.dataset.revision),monitoringPolicy:{enabled:value(form,'monitoringEnabled')==='true'}};
      ['pageIntervalMinutes','siteIntervalMinutes','retryMinutes','retentionDays'].forEach(function(key){payload.monitoringPolicy[key]=Number(value(form,key));});
      var result=await request('/projects/'+encodeURIComponent(selected),'PATCH',payload);if(disposed||token!==epoch)return;
      if(!result.project)throw{code:'invalid_response'};projects=projects.map(function(p){return p.id===selected?result.project:p;});renderProjects();renderWorkspace();message('Налаштування збережено.');
    }
    function replacementBatchView() {
      append(content,el('h3','','Пакетна заміна посилань'),el('p','lc-muted','Виберіть керовані сторінки, позначте конкретні кнопки або текстові посилання й перевірте одне точне порівняння. Зміни почнуться тільки після підтвердження.'));
      var host=el('section','lc-batch');content.appendChild(host);
      if(batchDraft){renderBatch(host);return;}
      if(batchPlacements.length){
        var form=el('form','lc-form');form.dataset.lcForm='replacement-batch';
        batchPlacements.forEach(function(entry){var group=el('details','lc-batch-page');group.open=true;group.appendChild(el('summary','',entry.page.title||'Без назви'));group.appendChild(fullLink(entry.page.fullUrl));
          entry.placements.forEach(function(place){var row=el('fieldset','lc-placement');row.dataset.batchPage=entry.page.id;row.dataset.batchPlacement=place.id;row.appendChild(el('legend','',place.label||place.role||place.id));var check=field(row,'Замінити це місце','batchSelected','checkbox');check.value=place.id;append(row,el('p','lc-exact-url',place.url),el('p','lc-muted','Анкор: '+text(place.anchor)));field(row,'Нова повна адреса','batchUrl','text',place.url).removeAttribute('maxlength');if(place.anchorEditable===true)field(row,'Точний анкор','batchAnchor','text',place.anchor);group.appendChild(row);});form.appendChild(group);});
        var prepare=button('Показати точні зміни пакета',null,null,true);prepare.type='submit';append(form,prepare,button('Обрати інші сторінки','reset-batch'));host.appendChild(form);
      }else{
        var eligible=pages.filter(function(p){return p.wpId&&p.fullUrl&&(p.replacement||p.remoteSnapshot);});
        if(!eligible.length)append(host,el('div','lc-empty','Керованих публікацій ще немає. Опублікуйте матеріал або імпортуйте сторінку WordPress із прив’язками посилань.'),tabButton('Перейти до сторінок','pages'));
        eligible.forEach(function(page){var row=el('label','lc-batch-select');var input=el('input');input.type='checkbox';input.dataset.batchSelect=page.id;input.checked=batchSelection.has(page.id);input.disabled=page.replacement&&page.replacement.available===false;append(row,input,el('span','',page.title||'Без назви'),el('small','lc-url',page.fullUrl));host.appendChild(row);if(input.disabled)append(host,el('p','lc-muted',nativeReason(page.replacement)),button(page.replacement.accessRequired?'Підключити доступ':'Переглянути стан','batch-page-access',page.id));});
        if(eligible.length)host.appendChild(button('Обрати місця посилань','load-batch',null,true));
      }
      var history=el('details','lc-create');append(history,el('summary','','Попередні пакети заміни'),button('Завантажити історію пакетів','batch-history'));content.appendChild(history);
    }
    function renderBatch(host) {
      var batch=batchDraft;append(host,el('h4','','Точне порівняння'),badge(batch.state));
      list(batch.items).forEach(function(item){var page=pages.find(function(p){return p.id===item.pageId;}),card=el('article','lc-card');append(card,el('h4','',item.title||(page&&page.title)||'Сторінка'),fullLink(item.fullUrl||(page&&page.fullUrl)));if(item.state||item.jobState)card.appendChild(badge(item.jobState||item.state));
        list(item.diff).forEach(function(diff){var row=el('div','lc-diff');row.appendChild(el('h4','',diff.label||diff.id));[['Було',diff.before],['Буде',diff.after]].forEach(function(part){var box=el('div','lc-diff-side');append(box,el('strong','',part[0]),el('p','lc-exact-url',part[1]&&part[1].url),el('p','lc-muted','Анкор: '+text(part[1]&&part[1].anchor)));row.appendChild(box);});card.appendChild(row);});
        if(item.errorCode)card.appendChild(el('p','lc-error-text',errorText({code:item.errorCode})));host.appendChild(card);});
      if(batch.state==='pending'&&!batch.confirming)append(host,el('p','lc-muted','Підтвердження стосується лише цього списку місць і версій. Зміни на сайті або в проєкті зупинять застарілий пакет.'),button('Підтверджую всі показані заміни','confirm-batch',batch.id,true),button('Скасувати перегляд','reset-batch'));
      else append(host,el('p','lc-muted',batch.confirming?'Результат підтвердження ще невідомий. Оновіть стан пакета; новий запис не запускається.':'Стан кожної сторінки зберігається окремо. Завершений запис потребує перевірки опублікованого результату.'),button('Оновити стан пакета','refresh-batch',batch.id),batch.confirming?null:button('Інший пакет','reset-batch'));
    }
    async function loadBatchPlacements(token) {
      var selectedPages=pages.filter(function(p){return batchSelection.has(p.id)&&p.wpId&&(p.replacement||p.remoteSnapshot);});if(!selectedPages.length){message('Позначте хоча б одну керовану сторінку.',true);return;}
      var serial=++extraLoad;var results=await Promise.all(selectedPages.map(async function(page){var result=await request('/pages/'+encodeURIComponent(page.id)+'/placements');if(result.pageRevision!==page.revision)throw{code:'CONFLICT'};if(result.replacement&&result.replacement.available===false)throw{code:result.replacement.reason||'CONFLICT'};return {page:clone(page),placements:list(result.placements),replacement:result.replacement};}));
      if(disposed||token!==epoch||serial!==extraLoad||tab!=='replacements')return;batchPlacements=results;clear(content);replacementBatchView();
    }
    async function prepareBatch(form,token) {
      var items=[];batchPlacements.forEach(function(entry){var changes=[];Array.from(form.querySelectorAll('[data-batch-page]')).filter(function(row){return row.dataset.batchPage===entry.page.id&&row.querySelector('[name=batchSelected]').checked;}).forEach(function(row){var place=entry.placements.find(function(p){return p.id===row.dataset.batchPlacement;}),url=row.querySelector('[name=batchUrl]').value;try{var parsed=new URL(url);if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password||/\s/.test(url))throw 0;}catch(_){throw{code:'invalid_url'};}var change={id:place.id,url:url,expectedUrl:place.url,expectedAnchor:place.anchor};if(place.binding!==undefined)change.expectedBinding=place.binding;var anchor=row.querySelector('[name=batchAnchor]');if(anchor)change.anchor=anchor.value;changes.push(change);});if(changes.length)items.push({pageId:entry.page.id,expectedRevision:entry.page.revision,changes:changes});});
      if(!items.length){message('Позначте конкретні місця посилань для заміни.',true);return;}
      var serial=++extraLoad,result=await request('/projects/'+encodeURIComponent(selected)+'/replacement-batches','POST',{items:items});if(disposed||token!==epoch||serial!==extraLoad||tab!=='replacements')return;if(!result.batch||!result.batch.confirmationHash)throw{code:'invalid_response'};batchDraft=result.batch;clear(content);replacementBatchView();
    }
    function monitorView() {
      content.appendChild(el('h3','','Стан кожної сторінки'));
      var incidents=list(overview&&overview.incidents);if(incidents.length){var ledger=el('details','lc-incident-ledger');ledger.open=incidents.some(function(i){return i.state!=='resolved';});ledger.appendChild(el('summary','','Журнал проблем · '+incidents.filter(function(i){return i.state!=='resolved';}).length+' поточних'));incidents.forEach(function(item){var row=el('div','lc-check-row'),page=pages.find(function(p){return p.id===item.pageId;});append(row,el('strong','',page?page.title:'Перевірка проєкту'),badge(item.state==='resolved'?'resolved':'open'),el('span','lc-meta',date(item.updatedAt||item.lastSeenAt||item.openedAt)));var evidence=typeof item.evidence==='string'?item.evidence:item.evidence&&(item.evidence.summary||item.evidence.message);if(item.summary||evidence)row.appendChild(el('p','lc-muted',item.summary||evidence));if(page)row.appendChild(button('Перевірити зараз','check-page',page.id));ledger.appendChild(row);});content.appendChild(ledger);}

      content.appendChild(el('p','lc-muted','Це результати останніх перевірок, а не підтвердження індексації Google. Невідомий стан не означає видалення.'));
      if(!overview)content.appendChild(el('p','lc-error-text','Не вдалося завантажити зведення. Оновіть дані або перезапустіть локальний сервер після оновлення.'));
      if(!pages.length)content.appendChild(el('p','lc-empty','Додайте сторінку в проєкт — тут з’являться її перевірки.'));
      pages.forEach(function(page){var card=el('article','lc-card');append(card,el('h4','',page.title),fullLink(page.fullUrl));var checks=checkMap(page.id),grid=el('div','lc-health');
        [['public','Відкриття'],['wp_access','Доступ до редагування'],['wp_status','Стан у WordPress'],['noindex','Noindex'],['robots','Robots.txt'],['content','Наш контент'],['wp_content','Зміни контенту'],['links','Посилання'],['live_browser','Вигляд на сайті']].forEach(function(item){var c=checks.find(function(c){return c.kind===item[0];});var cell=el('div','lc-health-item');append(cell,el('span','',item[1]),badge(c?c.state:'pending'));if(c)cell.appendChild(el('small','lc-meta',date(c.checkedAt)));grid.appendChild(cell);});card.appendChild(grid);
        if(page.fullUrl)card.appendChild(verificationBadge(page));
        if(page.fullUrl){var actions=el('div','lc-actions');append(actions,button('Перевірити зараз','check-page',page.id));card.appendChild(actions);}content.appendChild(card);
      });
    }
    function showComposer() {
      clear(composerPanel);composerPanel.hidden=false;
      var head=el('div','lc-card-head');append(head,el('h3','','Нова сторінка в цьому проєкті'),button('Закрити','close-composer'));composerPanel.appendChild(head);
      composerPanel.appendChild(el('p','lc-muted','Крок 1: тема та адреси → Крок 2: тексти й точні анкори → Крок 3: перегляд, чернетка або публікація. Поточна чернетка редактора зберігається.'));
      var form=el('form','lc-form');form.dataset.lcForm='new-page';
      field(form,'Тема / ключова фраза','newKeyword','text','',true);
      var links=field(form,'Адреси пропозицій — одна на рядок. Можна: Назва | https://...','newLinks','textarea','',true);links.maxLength=20000;
      var count=field(form,'Кількість карток (від кількості адрес до 20)','newCardCount','number','10',true);count.min='1';count.max='20';count.step='1';
      var next=button('Підготувати та перейти до текстів',null,null,true);next.type='submit';form.appendChild(next);composerPanel.appendChild(form);
      composerPanel.appendChild(el('p','lc-muted','Цей крок не викликає ШІ та нічого не публікує. Бонуси, оцінки й логотипи можна додати в редакторі; вони не вигадуються.'));
      composerPanel.scrollIntoView?.({block:'start'});form.querySelector('input').focus();
    }
    async function createPage(form,token) {
      if(!selected||!options.createPageSnapshot)throw{code:'not_configured'};
      var project=projects.find(function(p){return p.id===selected;})||{};
      var input={keyword:value(form,'newKeyword').trim(),links:value(form,'newLinks').trim(),cardCount:Number(value(form,'newCardCount')),language:project.language,country:project.country};
      var snapshot;try{snapshot=await options.createPageSnapshot(input);}catch(error){message(error.message||'Перевірте адреси та кількість карток.',true);return;}
      if(disposed||token!==epoch)return;
      var result=await request('/projects/'+encodeURIComponent(selected)+'/pages','POST',{title:snapshot.title,keyword:input.keyword,config:snapshot.config,uniqueUrls:list(snapshot.uniqueUrls)});
      if(disposed||token!==epoch)return;composerPanel.hidden=true;clear(composerPanel);tab='pages';await loadProject(token,true);
      if(disposed||token!==epoch)return;toast('Сторінку збережено. Оберіть тексти для ШІ або відкрийте її в редакторі.');
      var launch=result.page&&root.querySelector('[data-lc-action="automation-page"][data-lc-id="'+result.page.id+'"]');if(launch)launch.click();
    }
    function pageView() {
      var tools=el('div','lc-page-tools'),manual=el('details','lc-manual-tools');manual.appendChild(el('summary','','Ручні дії'));
      var manualActions=el('div','lc-menu-actions');append(manualActions,button('Створити сторінку вручну','new-page'),button('Зберегти поточну сторінку','save-new'));manual.appendChild(manualActions);append(tools,tabButton('Заміна посилань','replacements'),manual);content.appendChild(tools);
      content.appendChild(el('p','lc-muted','Усі сторінки проєкту: повні адреси, стан публікації та результати перевірок.'));
      if(!sites.length){var setup=el('div','lc-setup-note');append(setup,el('span','','Для публікації підключіть WordPress. Матеріали можна підготувати вже зараз.'),tabButton('Підключити сайт','sites'));content.appendChild(setup);}
      content.appendChild(secondaryTools());
      var filters = el('div','lc-filters');
      field(filters,'Пошук сторінок','pageSearch','search',search);
      var stateSelect = field(filters,'Стан','pageState','select');
      option(stateSelect,'','Усі стани');
      var states = Array.from(new Set(pages.map(pageState)));
      states.forEach(function (state) { option(stateSelect,state,statusText(state)); }); stateSelect.value = filter;
      filters.hidden=!pages.length;content.appendChild(filters);
      rowList = el('div','lc-records'); content.appendChild(rowList); renderPageRows();
      var details = el('details','lc-create lc-register'); append(details,el('summary','','+ Додати URL готової сторінки для перевірок'));
      var form = el('form','lc-form lc-form-grid'); form.dataset.lcForm = 'monitor-page';
      field(form,'Назва сторінки','monitorTitle','text','',true);
      field(form,'Повний HTTPS URL','monitorUrl','url','',true);
      var select = field(form,'Сайт із цього проєкту','monitorSite','select'); option(select,'','Оберіть сайт');
      sites.forEach(function(site){option(select,site.id,site.name || site.baseUrl);}); select.required = true;
      var wpId=field(form,'WordPress ID (необов’язково)','monitorWpId','number');wpId.min='1';wpId.step='1';
      var add = button('Додати до реєстру',null,null,true);add.type='submit'; form.appendChild(add);
      details.appendChild(form);details.appendChild(el('p','lc-muted','Тул лише додасть адресу до проєкту. Вміст уже опублікованої сторінки не змінюється.'));content.appendChild(details);
      renderImportForm();
      checksPanel=el('div','lc-checks');checksPanel.hidden=true;content.appendChild(checksPanel);
      workflowPanel=el('section','lc-workflow');workflowPanel.hidden=true;workflowPanel.setAttribute('aria-label','Дії зі збереженою сторінкою');content.appendChild(workflowPanel);renderFlow();
    }
    function renderImportForm() {
      var details=el('details','lc-create lc-import');details.open=!!importDraft;details.appendChild(el('summary','','Імпорт існуючої сторінки WordPress'));
      details.appendChild(el('p','lc-muted','Прочитайте поточну версію сторінки, перевірте метадані й підтвердьте керовану прив’язку. Сам імпорт не переписує публічний вміст.'));
      var form=el('form','lc-form lc-form-grid');form.dataset.lcForm='import-preview';
      var site=field(form,'Сайт WordPress','importSite','select');option(site,'','Оберіть сайт');sites.forEach(function(s){option(site,s.id,(s.name||s.baseUrl)+(siteReady(s)?'':' — перевірте доступ'));site.lastChild.disabled=!siteReady(s);});site.required=true;
      var wpId=field(form,'WordPress ID сторінки або запису','importWpId','number','',true);wpId.min=1;wpId.step=1;
      var type=field(form,'Тип матеріалу','importWpType','select');option(type,'page','Сторінка');option(type,'post','Запис');
      var preview=button('Прочитати й переглянути',null,null,true);preview.type='submit';preview.disabled=!sites.some(siteReady);form.appendChild(preview);details.appendChild(form);
      if(!sites.some(siteReady))append(details,el('p','lc-muted','Спочатку підключіть сайт і перевірте доступ.'),tabButton('Підключити WordPress','sites'));
      importPanel=el('div','lc-import-preview');importPanel.setAttribute('aria-live','polite');details.appendChild(importPanel);content.appendChild(details);renderImportPreview();
    }
    function renderImportPreview() {
      if(!importPanel)return;var form=importPanel.parentNode.querySelector('[data-lc-form=import-preview]');if(form)Array.from(form.elements).forEach(function(control){control.disabled=!!(importDraft&&(importDraft.confirming||importDraft.job))||(control.type==='submit'&&!sites.some(siteReady));});clear(importPanel);if(!importDraft)return;var preview=importDraft;
      append(importPanel,el('h4','',preview.title||'Імпорт сторінки'),fullLink(preview.fullUrl),el('p','lc-meta',(preview.wpType==='post'?'Запис':'Сторінка')+' · WP ID: '+preview.wpId));
      if(preview.summary)importPanel.appendChild(el('p','lc-muted',preview.summary));
      if(preview.contentHash){var hash=el('details');append(hash,el('summary','','Дані збереженого знімка'),el('p','lc-exact-url',preview.contentHash));importPanel.appendChild(hash);}
      list(preview.warnings).forEach(function(warning){importPanel.appendChild(el('p','lc-notice lc-error',typeof warning==='string'?warning:warning.message||warning.summary||'Перевірте сумісність цієї сторінки перед імпортом.'));});
      if(preview.job){append(importPanel,badge(preview.job.state||'queued'),el('p','lc-muted','Прив’язку передано до черги. Перевірте її результат у завданнях; готовність сторінки ще не підтверджена.'),tabButton('Відкрити завдання','jobs'),button('Імпортувати іншу сторінку','reset-import'));return;}
      if(preview.confirming){append(importPanel,el('p','lc-notice','Результат підтвердження ще невідомий. Оновіть стан завдань. Повторний запит не надсилається автоматично.'),tabButton('Перевірити завдання','jobs'));return;}
      if(preview.canAdopt===true)append(importPanel,el('p','lc-muted','Підтверджую прив’язку саме цієї прочитаної версії. Подальші зміни посилань потребуватимуть окремого точного порівняння.'),button('Підтверджую керований імпорт','confirm-import',preview.id,true));
      else importPanel.appendChild(el('p','lc-error-text','Керована прив’язка цієї версії недоступна. Усуньте зазначені причини й прочитайте сторінку знову.'));
    }
    async function previewImport(form,token) {
      var site=sites.find(function(s){return s.id===value(form,'importSite');});if(!siteReady(site))throw{code:'SITE_NOT_READY'};
      var serial=++extraLoad;importDraft=null;renderImportPreview();var result=await request('/projects/'+encodeURIComponent(selected)+'/imports/preview','POST',{siteId:site.id,wpId:Number(value(form,'importWpId')),wpType:value(form,'importWpType')});
      if(disposed||token!==epoch||serial!==extraLoad||tab!=='pages')return;if(!result.preview||!result.preview.id||!result.preview.confirmationHash)throw{code:'invalid_response'};importDraft=result.preview;renderImportPreview();
    }
    function renderPageRows() {
      if (!rowList || tab !== 'pages') return;
      clear(rowList);
      var filters=content.querySelector('.lc-filters');if(filters)filters.hidden=!pages.length;
      var stateSelect = content.querySelector('[name=pageState]');
      if (stateSelect) { clear(stateSelect); option(stateSelect,'','Усі стани'); Array.from(new Set(pages.map(pageState))).forEach(function(state){option(stateSelect,state,statusText(state));}); stateSelect.value=filter; }
      var query = search.toLocaleLowerCase('uk-UA');
      var shown = pages.filter(function (page) {
        return (!query || [page.title,page.fullUrl,page.keyword].join(' ').toLocaleLowerCase('uk-UA').indexOf(query)>=0) && (!filter || filter === pageState(page));
      });
      if(!shown.length){var empty=el('div','lc-empty');append(empty,el('h4','',pages.length?'Нічого не знайдено':'Тут будуть ваші сторінки'),el('p','lc-muted',pages.length?'Змініть пошук або фільтр.':'Натисніть «Створити сторінки», додайте теми й посилання та виберіть сайти. Тул згенерує матеріали, створить сторінки й покаже результат тут.'));rowList.appendChild(empty);}
      shown.forEach(function (page) {
        var card = el('article','lc-card'), head = el('div','lc-card-head');
        append(head,el('h4','',page.title || 'Без назви'),badge(pageState(page)));card.appendChild(head);
        if (page.fullUrl) {var address=el('div','lc-address');append(address,fullLink(page.fullUrl),button('Копіювати URL','copy-url',page.id));card.appendChild(address);card.appendChild(verificationBadge(page));}
        if (page.keyword) card.appendChild(el('p','lc-muted','Ключ: '+page.keyword));
        var meta = [page.wpId ? 'WP ID: '+page.wpId : '', date(page.updatedAt || page.createdAt)].filter(Boolean).join(' · ');
        if (meta) card.appendChild(el('p','lc-meta',meta));
        var actions=el('div','lc-actions');
        if (hasConfig(page)) append(actions,button('Відкрити в редакторі','open-page',page.id),button('Оновити з редактора','update-page',page.id));
        if (page.fullUrl) append(actions,button('Перевірити','check-page',page.id),button('Результати перевірок','page-checks',page.id));
        if(status.automation && !page.wpId && hasConfig(page) && win.PagePosterRuns)actions.appendChild(button('Автоматичний запуск','automation-page',page.id));
        if(status.publication) {
          if(hasConfig(page)&&(!page.wpId || publishLaunch(page) || pendingPageLaunch(page.id))) actions.appendChild(button(page.wpId?'Стан надсилання':'Надіслати у WordPress','publish-page',page.id,true));
          if(page.wpId && page.fullUrl) append(actions,button('Замінити посилання','replace-links',page.id),button('Відкотити версію','rollback-page',page.id));
        }
        card.appendChild(actions);rowList.appendChild(card);
      });
    }
    function siteView() {
      rowList=el('div','lc-records');content.appendChild(rowList);renderSiteRows();
      var details=el('details','lc-create');details.open=!sites.length;details.appendChild(el('summary','','+ Підключити свій WordPress'));
      var form=el('form','lc-form');form.dataset.lcForm='site';form.autocomplete='off';
      var set=el('fieldset','lc-form-grid');set.disabled=!status.credentialStorage;
      field(set,'Назва сайту','siteName','text','',true);field(set,'HTTPS-адреса WordPress','siteUrl','url','',true);
      var username=field(set,'Ім’я користувача WordPress','siteUsername','text','',true);username.autocomplete='username';
      var password=field(set,'Пароль застосунку WordPress','sitePassword','password','',true);password.autocomplete='new-password';password.maxLength=512;
      var add=button('Зберегти підключення',null,null,true);add.type='submit';set.appendChild(add);form.appendChild(set);details.appendChild(form);
      details.appendChild(el('p','lc-muted',status.credentialStorage ? 'Потрібен пароль застосунку з профілю WordPress, а не звичайний пароль входу. Доступи шифруються на сервері. Вони не входять до експорту матеріалів; повна захищена копія включає їх.' : 'На сервері ще не налаштовано шифрування доступів. Додавання реквізитів вимкнено до налаштування сервера.'));
      content.appendChild(details);var shared=el('div','lc-shared-sites');shared.appendChild(button('Вибрати вже підключений сайт','existing-sites'));content.appendChild(shared);installationGuide();
    }
    function renderSiteRows() {
      if (!rowList || tab !== 'sites') return;
      clear(rowList);
      if (!sites.length) rowList.appendChild(el('div','lc-empty','Сайтів ще немає. Додайте свій WordPress нижче.'));
      sites.forEach(function (site) {
        var card=el('article','lc-card'),head=el('div','lc-card-head');
        append(head,el('h4','',site.name || 'WordPress'),badge(site.enabled === false ? 'disabled' : 'enabled'));card.appendChild(head);card.appendChild(fullLink(site.baseUrl || site.exactBaseUrl));
        card.appendChild(el('p','lc-muted',site.hasCredential ? 'Доступ збережено на сервері.' : 'Реквізити доступу відсутні.'));
        var check=site.check || site.lastCheck;
        if (check) card.appendChild(el('p','lc-meta','Доступ: '+statusText(check.state || check.status)+' '+date(check.checkedAt)));
        else if (site.status || site.lastCheckedAt) card.appendChild(el('p','lc-meta','Доступ: '+statusText(site.status)+' '+date(site.lastCheckedAt)));
        if(site.plugins) [['bridge','PagePoster Bridge'],['cleanLinks','PagePoster Clean Links']].forEach(function(entry){var plugin=site.plugins[entry[0]];if(!plugin)return;card.appendChild(el('p','lc-meta',entry[1]+': '+statusText(plugin.state)+(plugin.version?' · '+plugin.version:'')+(plugin.requiredVersion&&plugin.compatible!==true?' · потрібна '+plugin.requiredVersion:'')+(plugin.compatible===true?' · версія сумісна':'')));});
        if(site.bootstrap){var setup={ready:'Доступ, сумісність і цілісність плагінів перевірено.',checksum_required:'Файли плагінів не збігаються з комплектом PagePoster. Перевстановіть обидва ZIP із тулу та повторіть перевірку.',verification_required:'Не вдалося завершити перевірку плагінів. Перевірте підключення й натисніть «Перевірити доступ».',bootstrap_required:'Встановіть та активуйте плагіни PagePoster через адмінку WordPress, потім перевірте доступ.',update_required:'Оновіть PagePoster Bridge та Clean Links до потрібних версій, потім перевірте доступ.',bridge_detected:'Потрібні версії плагінів знайдено. Можливість запису буде перевірено перед надсиланням сторінки.'};if(setup[site.bootstrap.state])card.appendChild(el('p','lc-muted',setup[site.bootstrap.state]));}
        var actions=el('div','lc-actions');var checkBtn=button('Перевірити доступ','check-site',site.id);checkBtn.disabled=site.enabled===false;
        append(actions,checkBtn,button(site.enabled===false?'Увімкнути перевірки':'Вимкнути перевірки','toggle-site',site.id));card.appendChild(actions);rowList.appendChild(card);
      });
    }
    function listView() { rowList=el('div','lc-records');content.appendChild(rowList);renderListRows(); }
    function renderListRows() {
      if (!rowList || (tab!=='jobs' && tab!=='history')) return;
      clear(rowList);
      var rows=(tab==='jobs'?jobs:events).slice().reverse();
      if (!rows.length) rowList.appendChild(el('div','lc-empty',tab==='jobs'?'Завдань ще немає. Перевірка сайту або сторінки з’явиться тут.':'Історія поки порожня.'));
      rows.forEach(function (item) {
        var card=el('article','lc-card'),head=el('div','lc-card-head');
        var kinds={site_check:'Перевірка доступу до сайту',page_check:'Перевірка сторінки',check_site:'Перевірка доступу до сайту',check_page:'Перевірка сторінки',monitor_page:'Перевірка сторінки',publish:'Надсилання у WordPress',replace:'Зміна збереженої сторінки',rollback:'Відкат версії',import:'Керований імпорт сторінки',adopt:'Прив’язка існуючої сторінки',import_adopt:'Прив’язка існуючої сторінки'};
        var kind=item.type || item.kind || item.operation || item.action;
        append(head,el('h4','',kinds[kind] || kind || (tab==='jobs'?'Завдання':'Подія')),badge(item.state || item.status || item.result && item.result.state));card.appendChild(head);
        var site=sites.find(function(s){return s.id===(item.siteId || item.entityId);}),page=pages.find(function(p){return p.id===(item.pageId || item.entityId);});
        if (site || page) card.appendChild(el('p','lc-muted',[site&&site.name,page&&page.title].filter(Boolean).join(' · ')));
        if (page&&page.fullUrl) card.appendChild(fullLink(page.fullUrl));
        var code=item.errorCode || item.code || (item.error && typeof item.error==='object' && item.error.code);
        if (item.state==='failed' || item.error || code) card.appendChild(el('p','lc-error-text',errors[code] || 'Завдання завершилося з помилкою. Перевірте підключення та спробуйте ще раз.'));
        else if (item.message) card.appendChild(el('p','lc-muted',item.message));
        if(tab==='jobs' && item.state==='paused')card.appendChild(button('Продовжити завдання','resume-job',item.id));
        if(tab==='jobs' && ['queued','running'].indexOf(item.state)>=0) { card.appendChild(button(item.state==='queued'?'Призупинити завдання':'Зупинити подальше виконання','pause-job',item.id)); if(item.state==='running' && (item.effect==='write' || ['publish','replace'].indexOf(kind)>=0))card.appendChild(el('p','lc-muted','Запис уже виконується і може завершитися. Призупинення не гарантує скасування: після нього потрібна звірка результату.')); }
        if(tab==='jobs' && item.state==='uncertain') {var nativeJob=item.payload?.mode==='native-update'||item.mode==='native-update';append(card,el('p','lc-muted',item.retryable===true&&!nativeJob?'Bridge підтвердив: цей запит не був зареєстрований. Повтор збереже той самий ідентифікатор та ще раз перевірить результат перед надсиланням.':'Результат запису невідомий. Звірка читає стан WordPress і не надсилає сторінку повторно.'),button('Звірити результат','reconcile-job',item.id));if(item.retryable===true&&!nativeJob)card.appendChild(button('Повторити той самий запит','retry-job',item.id)); }
        card.appendChild(el('p','lc-meta',date(item.updatedAt || item.completedAt || item.createdAt || item.time)));rowList.appendChild(card);
      });
    }
    async function loadProject(token, rebuild) {
      var id=selected, serial=++loadId;
      if (!id) return;
      if (content) content.setAttribute('aria-busy','true');
      try {
        var base='/projects/'+encodeURIComponent(id);
        var data=await Promise.all([request(base+'/pages'),request(base+'/sites'),request(base+'/jobs'),request(base+'/events'),request(base+'/overview').catch(function(){return null;})]);
        if (disposed || token!==epoch || selected!==id || serial!==loadId) return;
        pages=list(data[0].pages);sites=list(data[1].sites);jobs=list(data[2].jobs);events=list(data[3].events);overview=data[4];syncLaunches(true);
        if (rebuild) renderWorkspace();
        else if(tab==='campaigns'){/* The campaign module refreshes results without replacing the working form. */}else if (tab==='pages') { renderPageRows();syncFlow(); } else if(tab==='sites')renderSiteRows();else if(tab==='overview'){var expanded=content.querySelector('details[open]');clear(content);overviewView();if(expanded)content.querySelector('details').open=true;}else if(tab==='monitor'){clear(content);monitorView();}else if(tab==='jobs'||tab==='history')renderListRows();
        return true;
      } catch(error) { if (!disposed && token===epoch && serial===loadId) message(errorText(error),true); }
      finally { if (!disposed && token===epoch && serial===loadId) { if(content)content.setAttribute('aria-busy','false');schedulePoll(); } }
    }
    async function refresh() {
      if(disposed)return;
      var token=++epoch;checksId++;stopPolling();polls=0;shell();message('З’єднуємося із сервером…');
      try {
        var result=await request('/status');if(disposed||token!==epoch)return;status=result;
        if(!status.available){message('');unavailable();return;}
        var data=await request('/projects');if(disposed||token!==epoch)return;projects=list(data.projects);
        if(!projects.some(function(p){return p.id===selected;}))selected=options.selectFirstProject&&projects.length?projects[0].id:'';
        message('');buildLayout();if(selected)await loadProject(token,true);
      } catch(error) { if(!disposed&&token===epoch){status={available:false};message('Сервер проєктів недоступний.',true);unavailable();} }
    }
    async function selectProject(id) {
      composerPanel.hidden=true;clear(composerPanel);overview=null;batchDraft=null;batchPlacements=[];batchSelection.clear();importDraft=null;extraLoad++;selected=id;epoch++;checksId++;flowId++;flow=null;polls=0;pages=[];sites=[];jobs=[];events=[];search='';filter='';stopPolling();message('');renderProjects();renderWorkspace();await loadProject(epoch,true);
    }
    async function mutate(control, operation) {
      if(control.disabled)return;
      var token=epoch;control.disabled=true;message('');
      try { await operation(token); }
      catch(error){if(!disposed&&token===epoch)message(errorText(error),true);}
      finally{if(!disposed&&control.isConnected)control.disabled=false;}
    }
    async function savePage(pageId, token) {
      if(!selected || typeof options.getEditorSnapshot!=='function')return;
      var snapshot=await options.getEditorSnapshot();
      if(disposed||token!==epoch)return;
      if(!snapshot || !snapshot.config)throw{code:'invalid_input'};
      var payload={title:snapshot.title || snapshot.config.title || 'Без назви',keyword:snapshot.config.keyword || '',config:clone(snapshot.config),html:text(snapshot.html),uniqueUrls:list(snapshot.uniqueUrls).slice()};
      var id=selected;
      if(pageId){var page=pages.find(function(p){return p.id===pageId;});if(!page)throw{code:'not_found'};payload.expectedRevision=page.revision;await request('/pages/'+encodeURIComponent(pageId),'PATCH',payload);}
      else await request('/projects/'+encodeURIComponent(id)+'/pages','POST',payload);
      if(disposed||token!==epoch)return;
      toast(pageId?'Копію сторінки оновлено у проєкті.':'Копію сторінки збережено у проєкті.');await loadProject(token,false);
    }
    async function showChecks(pageId) {
      var token=epoch,serial=++checksId;
      if(checksPanel){checksPanel.hidden=false;clear(checksPanel);checksPanel.appendChild(el('p','lc-muted','Завантаження перевірок…'));}
      try {
        var data=await request('/pages/'+encodeURIComponent(pageId)+'/checks');
        if(disposed||token!==epoch||serial!==checksId||tab!=='pages')return;
        clear(checksPanel);append(checksPanel,el('h4','','Результати перевірок'));
        var rows=list(data.checks);
        if(!rows.length)checksPanel.appendChild(el('p','lc-muted','Перевірок ще немає. Натисніть «Перевірити».'));
        var checkKinds={public:'Публічна доступність',content:'Вміст сторінки',wp_access:'Доступ WordPress',wp_status:'Стан WordPress',wp_content:'Зміни вихідного тексту',layout:'Вигляд згенерованого HTML',live_browser:'Вигляд опублікованої сторінки',noindex:'Індексація',robots:'Дозвіл обходу',links:'Вихідні посилання'};
        rows.slice().reverse().forEach(function(check){var row=el('div','lc-check-row');append(row,el('strong','',checkKinds[check.kind] || check.kind || check.type || 'Перевірка'),badge(check.state || check.status),el('span','lc-meta',date(check.checkedAt || check.createdAt)));var detail=check.message || (typeof check.evidence==='string'?check.evidence:check.evidence && (check.evidence.summary || check.evidence.message || check.evidence.detail || check.evidence.limitation));if(detail)row.appendChild(el('p','lc-muted',detail));list(check.evidence && check.evidence.screenshots).forEach(function(shot){var expected='/api/lifecycle/pages/'+pageId+'/screenshots/';if(typeof shot.url==='string'&&shot.url.indexOf(expected)===0&&/^pageposter-[a-f0-9-]+-(desktop|mobile)\.png$/.test(shot.url.slice(expected.length))){var link=el('a','lc-btn',shot.name==='mobile'?'Знімок телефону':'Знімок комп’ютера');link.href=shot.url;link.target='_blank';link.rel='noopener';row.appendChild(link);}});checksPanel.appendChild(row);});
      }catch(error){if(!disposed&&token===epoch&&serial===checksId)message(errorText(error),true);}
    }

    function saveLaunches() { try { win.sessionStorage.setItem(launchStorageKey,JSON.stringify(launches));return true; } catch (_) {return false;} }
    function newKey() {
      if(win.crypto && typeof win.crypto.randomUUID==='function')return win.crypto.randomUUID();
      if(!win.crypto || !win.crypto.getRandomValues)throw{code:'not_configured'};
      var b=new Uint8Array(16);win.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
      var hex=Array.from(b).map(function(n){return n.toString(16).padStart(2,'0');}).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    }
    function activeState(state) { return ['submitting','queued','running','uncertain','paused','review_needed','conflict','waiting_manual','checking'].indexOf(state)>=0; }
    function acceptJob(job) {
      if(!job || !job.id)return;
      var at=jobs.findIndex(function(item){return item.id===job.id;});if(at<0)jobs.push(job);else jobs[at]=job;
      syncLaunches();
    }
    function syncLaunches(fromServer) {
      Object.keys(launches).forEach(function(key){var launch=launches[key];if(!launch || typeof launch!=='object')return;var job=jobs.find(function(item){return item.idempotencyKey===launch.idempotencyKey || launch.jobId && item.id===launch.jobId;});if(job){launch.jobId=job.id;launch.state=job.state;launch.canReplay=false;}else if(fromServer && !launch.native && launch.projectId===selected && launch.state==='uncertain' && !launch.jobId){launch.canReplay=true;}});
      if(Object.keys(launches).length)saveLaunches();
    }
    function pendingPageLaunch(pageId) {
      var pending=Object.keys(launches).map(function(key){return launches[key];}).find(function(launch){return launch && launch.pageId===pageId && activeState(launch.state);});if(pending)return pending;
      var job=jobs.find(function(item){return item.pageId===pageId && (item.effect==='write' || ['publish','replace'].indexOf(item.type)>=0) && activeState(item.state);});return job?{pageId:pageId,state:job.state,jobId:job.id,idempotencyKey:job.idempotencyKey}:null;
    }
    function nativeResumePending(pageId) {return Object.keys(launches).some(function(key){var launch=launches[key];return launch?.native&&launch.pageId===pageId&&launch.resumePending===true;});}
    function nativeCheckPending(pageId) {return Object.keys(launches).some(function(key){var launch=launches[key];return launch?.native&&launch.pageId===pageId&&launch.checkPending===true;});}
    function publishLaunch(page) {
      var launch=launches['publish:'+page.id];
      if(launch && (activeState(launch.state)||launch.expectedRevision===page.revision))return launch;
      var job=jobs.find(function(item){return item.type==='publish' && item.pageId===page.id && activeState(item.state);});
      return job ? {pageId:page.id,state:job.state,jobId:job.id,idempotencyKey:job.idempotencyKey} : null;
    }
    function installAsset(key){var source=win.PagePosterDownloads;return source&&source[key]&&typeof source[key].base64==='string'?source[key]:null;}
    function installationGuide() {
      var box=el('details','lc-create lc-install');box.open=!sites.length;box.appendChild(el('summary','','Один раз: підготувати WordPress'));
      var steps=el('ol','lc-install-steps');
      append(steps,el('li','','Зайдіть у звичайну адмінку свого WordPress. Відкрийте «Плагіни → Додати → Завантажити ZIP».'),el('li','','Встановіть та активуйте PagePoster Bridge: він приймає збережені сторінки й захищає від повторного запису.'),el('li','','PagePoster Clean Links прибирає зайві посилання теми лише на сторінках PagePoster. Кнопки та бренд залишаються робочими.'),el('li','','Поверніться сюди, додайте пароль застосунку й натисніть «Перевірити доступ». Встановлення ZIP не відбувається автоматично.'));
      box.appendChild(steps);var actions=el('div','lc-actions');
      if(installAsset('bridge'))actions.appendChild(button('Завантажити PagePoster Bridge ZIP','download-bridge'));
      if(installAsset('cleanLinks'))actions.appendChild(button('Завантажити Clean Links ZIP','download-clean-links'));
      box.appendChild(actions);box.appendChild(el('p','lc-muted','Пароль застосунку працює для API. Він не замінює звичайний вхід в адмінку для першого встановлення плагіна.'));content.appendChild(box);
    }
    function downloadPlugin(key) {
      var asset=installAsset(key);if(!asset)throw{code:'not_configured'};
      var binary=win.atob(asset.base64),bytes=new Uint8Array(binary.length);for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      var url=win.URL.createObjectURL(new win.Blob([bytes],{type:'application/zip'})),link=el('a');link.href=url;link.download=asset.filename || (key==='bridge'?'pageposter-bridge.zip':'pageposter-clean-links.zip');doc.body.appendChild(link);link.click();link.remove();win.setTimeout(function(){win.URL.revokeObjectURL(url);},1000);
    }
    function siteReady(site) {
      var check=site && (site.check || site.lastCheck),state=check && (check.state || check.status) || site && site.status;
      return !!site && site.enabled!==false && site.hasCredential && ['ok','ready'].indexOf(state)>=0;
    }
    function flowPage(){return flow && pages.find(function(page){return page.id===flow.pageId;});}
    function syncFlow() {
      if(!flow || tab!=='pages')return;
      var page=flowPage();if(flow.state==='dispatched' || flow.state==='uncertain'){renderFlow();return;}if(!page || page.revision!==flow.pageRevision){flow.state='conflict';renderFlow();return;}
      updatePublishReadiness();
    }
    async function openFlow(kind,pageId) {
      if(!status || !status.publication)return;
      var page=pages.find(function(item){return item.id===pageId;});if(!page || kind==='publish'&&!hasConfig(page))return;
      var token=epoch,serial=++flowId;flow={kind:kind,pageId:pageId,pageRevision:page.revision,state:kind==='publish'?'editing':'loading'};renderFlow();
      if(kind==='publish')return;
      try{
        var full=await request('/pages/'+encodeURIComponent(pageId));if(disposed||token!==epoch||serial!==flowId)return;if(full.page){page=full.page;pages=pages.map(function(item){return item.id===pageId?page:item;});flow.pageRevision=page.revision;flow.replacement=page.replacement;}
        var pending=pendingPageLaunch(pageId);if(pending&&!pending.native&&flow.replacement?.mode!=='native')return;
        var data=await request('/pages/'+encodeURIComponent(pageId)+(kind==='rollback'?'/rollback-versions':'/placements'));if(disposed||token!==epoch||serial!==flowId)return;if(data.pageRevision!==page.revision)throw{code:'CONFLICT'};flow.replacement=data.replacement||flow.replacement;if(kind==='rollback')flow.versions=list(data.versions);else flow.placements=list(data.placements);flow.state='editing';
        if(flow.replacement?.mode==='native'){await readNativeFlow(token,serial);return;}renderFlow();
      }
      catch(error){if(!disposed&&token===epoch&&serial===flowId){flow.state='conflict';flow.error=errorText(error);renderFlow();}}
    }
    function renderNativeComparison(comparison,uncertain) {
      if(!comparison)return;var box=el('section','lc-diff');box.dataset.nativeComparison='true';box.appendChild(el('h4','',uncertain?'Порівняння стану WordPress':'WordPress змінився — запис зупинено'));
      [['Погоджено',comparison.expected],['Зараз у WordPress',comparison.actual],['Підготовлено',comparison.proposed]].forEach(function(part){if(!part[1])return;box.appendChild(el('strong','',part[0]));[['title','Заголовок'],['status','Стан'],['contentHash','Хеш вмісту']].forEach(function(field){if(typeof part[1][field[0]]==='string')box.appendChild(el('p','lc-exact-url',field[1]+': '+part[1][field[0]]));});});workflowPanel.appendChild(box);
    }
    async function readNativeFlow(token,serial,reconcile) {
      var current=flow;if(!current)return;var pending=pendingPageLaunch(current.pageId),jobId=current.nativeUpdate?.jobId||current.replacement?.jobId||pending?.jobId;
      if(reconcile&&jobId){var checked=await request('/jobs/'+encodeURIComponent(jobId)+'/reconcile','POST',{});if(disposed||token!==epoch||serial!==flowId)return;if(checked.job)acceptJob(checked.job);}
      var result;try{result=await request('/pages/'+encodeURIComponent(current.pageId)+'/replacement-status');}catch(error){if(!disposed&&token===epoch&&serial===flowId&&flow===current){flow.nativeStatusUnknown=true;renderFlow();}throw error;}if(disposed||token!==epoch||serial!==flowId||flow!==current)return;
      flow.replacement=result.replacement||flow.replacement;flow.nativeUpdate=result.update||null;flow.nativeStatusUnknown=false;
      var pendingChecks=Object.values(launches).filter(function(launch){return launch.native&&launch.pageId===current.pageId&&launch.checkPending&&launch.checkJobId;});
      if(pendingChecks.length&&result.update?.state!=='completed'){
        var checkStates;try{var checks=await request('/projects/'+encodeURIComponent(flowPage()?.projectId||selected)+'/jobs');checkStates=list(checks.jobs).filter(function(job){return job.pageId===current.pageId&&job.type==='page_check';}).map(function(job){return {id:job.id,state:job.state};});}catch(error){if(!disposed&&token===epoch&&serial===flowId&&flow===current){flow.nativeStatusUnknown=true;renderFlow();}throw error;}if(disposed||token!==epoch||serial!==flowId||flow!==current)return;
        pendingChecks.forEach(function(launch){var job=checkStates.find(function(job){return job.id===launch.checkJobId;});if(job&&['completed','failed','uncertain'].includes(job.state)){launch.checkPending=false;launch.checkJobId=null;}});
      }
      Object.keys(launches).forEach(function(key){var launch=launches[key];if(!launch.native||launch.pageId!==current.pageId)return;if(result.update){launch.jobId=result.update.jobId||launch.jobId;launch.state=result.update.state;launch.canReplay=false;if(result.update.state!=='waiting_manual')launch.resumePending=false;if(result.update.state==='completed'){flow.nativeCompletedNotice=true;delete launches[key];}else if(result.update.state==='failed'&&!['dispatching','published'].includes(result.update.phase))delete launches[key];}});saveLaunches();
      if(result.update?.state==='completed'&&current.completedUpdateId!==result.update.id){try{await refreshNativeFlow(token,serial,result.update.id);}catch(error){if(!disposed&&token===epoch&&serial===flowId&&flow===current){flow.nativeStatusUnknown=true;renderFlow();}throw error;}}
      renderFlow();
    }
    async function refreshNativeFlow(token,serial,updateId) {
      var current=flow,prior=flowPage(),result=await request('/pages/'+encodeURIComponent(current.pageId));if(disposed||token!==epoch||serial!==flowId||flow!==current)return;var page=result.page;
      if(page?.id!==current.pageId||page.projectId!==prior.projectId||page.wpId!==prior.wpId||page.fullUrl!==prior.fullUrl||!Number.isSafeInteger(page.revision))throw{code:'CONFLICT'};
      var data=await request('/pages/'+encodeURIComponent(page.id)+'/placements');if(disposed||token!==epoch||serial!==flowId||flow!==current)return;
      if(data.pageRevision!==page.revision||data.replacement?.mode!=='native'||!Array.isArray(data.placements))throw{code:'CONFLICT'};
      var versions;if(current.kind==='rollback'){versions=await request('/pages/'+encodeURIComponent(page.id)+'/rollback-versions');if(disposed||token!==epoch||serial!==flowId||flow!==current)return;if(versions.pageRevision!==page.revision)throw{code:'CONFLICT'};}
      pages=pages.map(function(item){return item.id===page.id?page:item;});current.pageRevision=page.revision;current.placements=data.placements;current.replacement=data.replacement;current.completedUpdateId=updateId;current.nativeCompletedNotice=false;current.proposal=null;current.launchKey=null;current.state='editing';if(versions)current.versions=list(versions.versions);
    }
    async function resumeNativeFlow(token,serial) {
      var current=flow,page=flowPage(),update=current?.nativeUpdate,pending=page&&pendingPageLaunch(page.id);
      if(!current||!page||current.nativeStatusUnknown||update?.state!=='waiting_manual'||update.canResume!==true||!['queued','prepared'].includes(update.phase)||!update.jobId||nativeResumePending(page.id))return;
      var key='native-resume:'+update.jobId,prior=launches[key],launch={...prior,pageId:page.id,projectId:selected,jobId:update.jobId,state:'submitting',native:true,resumePending:true};launches[key]=launch;
      if(!saveLaunches()){if(prior)launches[key]=prior;else delete launches[key];throw{code:'NATIVE_CONFIRM_STORAGE_UNAVAILABLE'};}renderFlow();
      try{var result=await request('/jobs/'+encodeURIComponent(update.jobId)+'/native-resume','POST',{});if(result.job?.id!==update.jobId||result.job.state!=='queued')throw{code:'invalid_response'};launch.resumePending=false;launch.state='queued';saveLaunches();if(disposed||token!==epoch||serial!==flowId)return;flow.nativeUpdate={...update,state:'queued',canResume:false};acceptJob(result.job);await readNativeFlow(token,serial);}
      catch(error){if(launch.resumePending)launch.state='uncertain';saveLaunches();if(!disposed&&token===epoch&&serial===flowId){flow.nativeStatusUnknown=true;renderFlow();}throw error;}
    }
    async function checkNativeFlow(token,serial) {
      var current=flow,page=flowPage();if(!current||!page||current.nativeStatusUnknown||current.nativeUpdate?.state!=='checking'||nativeCheckPending(page.id))return;
      var key='native-check:'+page.id,prior=launches[key],launch={...prior,pageId:page.id,projectId:page.projectId||selected,jobId:current.nativeUpdate.jobId,state:'checking',native:true,checkPending:true,checkJobId:null};launches[key]=launch;
      if(!saveLaunches()){if(prior)launches[key]=prior;else delete launches[key];throw{code:'NATIVE_CONFIRM_STORAGE_UNAVAILABLE'};}renderFlow();
      try{var result=await request('/pages/'+encodeURIComponent(page.id)+'/check','POST',{});if(!result.job?.id||result.job.type!=='page_check'||result.job.pageId!==page.id)throw{code:'invalid_response'};launch.checkJobId=result.job.id;saveLaunches();if(disposed||token!==epoch||serial!==flowId)return;acceptJob(result.job);await readNativeFlow(token,serial);}
      catch(error){saveLaunches();if(!disposed&&token===epoch&&serial===flowId){flow.nativeStatusUnknown=true;renderFlow();}throw error;}
    }
    function renderNativeGate(page) {
      if(!flow.replacement)return false;var capability=flow.replacement;if(capability.mode!=='native'){if(capability.available===false){workflowPanel.appendChild(el('p','lc-muted',nativeReason(capability)));return true;}return false;}
      var update=flow.nativeUpdate,pending=pendingPageLaunch(page.id);
      if(pending||capability.jobId||flow.nativeStatusUnknown||update&&['queued','running','uncertain','checking','waiting_manual'].includes(update.state)){
        var manualReady=!flow.nativeStatusUnknown&&update?.state==='waiting_manual'&&update.canResume===true&&['queued','prepared'].includes(update.phase)&&update.jobId&&!nativeResumePending(page.id);
        var note=el('p','lc-muted',manualReady?'Запис ще не надсилався. Завершіть CAPTCHA або вхід у відкритому вікні WordPress, потім підтвердьте продовження.':'Результат заміни ще не підтверджено. Повторний запис заблоковано; звірка лише читає WordPress.');note.dataset.nativeUpdateState=update?.state||pending?.state||'uncertain';workflowPanel.appendChild(note);
        if(update?.state==='checking'){var checkStatus=el('p','lc-muted',nativeCheckStatusText(update.checkStatus));checkStatus.dataset.nativeCheckStatus='true';workflowPanel.appendChild(checkStatus);}
        if(update?.state==='checking'&&!flow.nativeStatusUnknown&&!nativeCheckPending(page.id)){var check=button('Перевірити сторінку','native-update-check',page.id);check.dataset.nativeCheck='true';workflowPanel.appendChild(check);}
        workflowPanel.appendChild(button('Оновити стан','native-update-status',page.id));if(manualReady){var resume=button('Продовжити після CAPTCHA','native-update-resume',page.id);resume.dataset.nativeResume='true';workflowPanel.appendChild(resume);}if((update?.jobId||capability.jobId||pending?.jobId)&&(!update||update.state==='uncertain')){var reconcile=button('Звірити','native-update-reconcile',page.id);reconcile.dataset.nativeReconcile='true';workflowPanel.appendChild(reconcile);}renderNativeComparison(update?.comparison,true);return true;
      }
      if(update?.comparison){renderNativeComparison(update.comparison);workflowPanel.appendChild(el('p','lc-muted','Віддалені правки збережено. Перед новими змінами потрібна актуальна підтверджена копія.'));return true;}
      if(update?.state==='completed'&&flow.nativeCompletedNotice){workflowPanel.appendChild(el('p','lc-muted','Зміну та опублікований результат підтверджено. Для наступної заміни відкрийте актуальні дані сторінки.'));return true;}
      if(update?.state==='completed'&&flow.completedUpdateId===update.id)workflowPanel.appendChild(el('p','lc-muted','Поточну версію підтверджено. Дані для наступної заміни оновлено.'));
      if(capability.available===false){workflowPanel.appendChild(el('p','lc-muted',nativeReason(capability)));if(capability.accessRequired){var form=el('form','lc-form');form.dataset.lcForm='native-access';form.dataset.nativeAccess='true';var username=field(form,'Логін WordPress','nativeUsername','text','',true),password=field(form,'Пароль WordPress','nativePassword','password','',true);username.autocomplete='username';password.autocomplete='current-password';var submit=button('Зберегти доступ і продовжити',null,null,true);submit.type='submit';form.appendChild(submit);workflowPanel.appendChild(form);}return true;}
      return false;
    }
    function renderFlow() {
      if(!workflowPanel || tab!=='pages')return;clear(workflowPanel);workflowPanel.hidden=!flow;if(!flow)return;
      var page=flowPage();if(!page)return;
      if(['dispatched','uncertain'].indexOf(flow.state)<0 && page.revision!==flow.pageRevision&&!flow.nativeUpdate)flow.state='conflict';
      var heading=el('div','lc-card-head');append(heading,el('h3','',flow.kind==='publish'?'Надіслати у WordPress':flow.kind==='rollback'?'Відкотити збережену версію':'Заміна конкретних посилань'),button('Закрити','close-flow'));workflowPanel.appendChild(heading);
      append(workflowPanel,el('p','lc-flow-title',page.title || 'Без назви'),el('p','lc-muted','Збережена версія: '+flow.pageRevision));if(page.fullUrl)workflowPanel.appendChild(fullLink(page.fullUrl));
      if(flow.state!=='loading'&&renderNativeGate(page))return;
      var pending=pendingPageLaunch(page.id);if(pending){renderDispatch(pending);return;}
      if(flow.state==='loading'){workflowPanel.appendChild(el('p','lc-muted',flow.kind==='rollback'?'Завантажуємо попередні записані версії…':'Завантажуємо місця посилань зі збереженої версії…'));return;}
      if(flow.state==='conflict'){workflowPanel.appendChild(el('p','lc-error-text',flow.error || errors.CONFLICT));workflowPanel.appendChild(el('p','lc-muted','Оновіть дані й відкрийте дію знову. Старе підтвердження більше не діє.'));return;}
      var launch=flow.launchKey && launches[flow.launchKey] || (flow.kind==='publish'?publishLaunch(page):flow.proposal && launches['proposal:'+flow.proposal.id]);
      if(launch){renderDispatch(launch);return;}
      if(flow.kind==='publish'){if(page.wpId){workflowPanel.appendChild(el('p','lc-muted','Цю сторінку вже записано у WordPress. Повторне створення вимкнено. Посилання можна змінити окремою підтвердженою дією.'));return;}renderPublishForm(page);return;}
      if(flow.proposal){renderProposal(flow.proposal);return;}
      if(flow.kind==='rollback')renderRollbackForm();else renderReplacementForm();
    }
    function renderDispatch(launch) {
      var state=launch.state || 'uncertain';workflowPanel.appendChild(badge(state==='submitting'?'queued':state));
      append(workflowPanel,el('p','lc-muted',state==='uncertain'||state==='submitting'?'Відправлення вже розпочато. Результат ще не підтверджено; повторний запис заблокований. Оновіть стан завдань і за потреби звірте результат.':'Сервер прийняв завдання. Його стан показано нижче; ця дія не надсилається повторно.'),button('Оновити стан завдання','refresh-launch'));
      if(launch.state==='uncertain' && !launch.jobId && launch.canReplay && replayRequest(launch)){var key=Object.keys(launches).find(function(k){return launches[k]===launch;});if(key){workflowPanel.appendChild(el('p','lc-muted','Після оновлення серверного завдання з цим ключем не знайдено. Ви можете вручну повторити той самий запит: ключ, сторінка та зміни залишаться тими самими.'));workflowPanel.appendChild(button('Повторити той самий запит','retry-launch',key));}}
      if(launch.jobId)workflowPanel.appendChild(el('p','lc-meta','Завдання: '+launch.jobId));
      if(launch.state==='uncertain' && launch.jobId)workflowPanel.appendChild(button('Звірити результат','reconcile-job',launch.jobId));
      var job=jobs.find(function(item){return item.id===launch.jobId;});if(job && (job.error || job.state==='failed'))workflowPanel.appendChild(el('p','lc-error-text',errorText(job.error || job)));
    }
    function renderPublishForm(page) {
      var form=el('form','lc-form lc-form-grid');form.dataset.lcForm='publish';
      var select=field(form,'Сайт для цієї сторінки','publishSite','select');sites.forEach(function(site){option(select,site.id,(site.name || site.baseUrl)+(siteReady(site)?'':' — спочатку перевірте доступ'));var item=select.lastChild;item.disabled=!siteReady(site);});
      var preferred=sites.find(function(site){return site.id===page.siteId && siteReady(site);}) || sites.find(siteReady);if(preferred)select.value=preferred.id;else select.value='';select.required=true;
      var mode=field(form,'Що зробити у WordPress','publishMode','select');option(mode,'draft','Зберегти чернетку');option(mode,'publish','Опублікувати одразу');
      var explain=el('p','lc-muted lc-wide','Надсилається збережена копія сторінки. «Опублікувати одразу» відкриє її відвідувачам без додаткового підтвердження.');form.appendChild(explain);
      var readiness=el('p','lc-muted lc-wide');readiness.dataset.lcReadiness='true';form.appendChild(readiness);
      var submit=button('Надіслати вибраним способом',null,null,true);submit.type='submit';form.appendChild(submit);workflowPanel.appendChild(form);updatePublishReadiness();
    }
    function updatePublishReadiness() {
      var form=workflowPanel && workflowPanel.querySelector('[data-lc-form="publish"]');if(!form)return;
      var site=sites.find(function(item){return item.id===value(form,'publishSite');}),mode=value(form,'publishMode'),ready=siteReady(site),capability=site && site.capabilities && (mode==='publish'?site.capabilities.publish:site.capabilities.create);
      var submit=form.querySelector('button[type="submit"]');submit.disabled=!ready || capability===false;
      form.querySelector('[data-lc-readiness]').textContent=!ready?'Потрібен увімкнений сайт із збереженим доступом та успішною перевіркою. Перейдіть у «Сайти», встановіть Bridge і перевірте підключення.':capability===false?'У цього користувача WordPress немає прав для вибраної дії.':'Доступ перевірено. Перед записом сервер також перевірить Bridge, права та актуальність версії.';
    }
    function renderReplacementForm() {
      var placements=list(flow.placements);if(!placements.length){workflowPanel.appendChild(el('p','lc-muted','У цій збереженій сторінці немає підтримуваних місць для точкової заміни.'));return;}
      var native=flow.replacement?.mode==='native';workflowPanel.appendChild(el('p','lc-muted',native?'Одна адреса об’єднує всі її кнопки й посилання. Зміняться всі переходи групи; анкори, дизайн, WP ID та адреса сторінки зберігаються.':'Позначте лише потрібні місця. Однакова поточна адреса у кнопці, логотипі та бренді — це окремі рядки. Текст, дизайн і непозначені посилання зберігаються.'));
      var form=el('form','lc-form');form.dataset.lcForm='replacement';
      placements.forEach(function(place,index){
        var row=el('fieldset','lc-placement');row.dataset.lcPlacement=place.id;var legend=el('legend','',place.label || place.role || place.id);row.appendChild(legend);
        var check=field(row,'Змінити це місце','replacementSelected','checkbox');check.value=place.id;
        append(row,el('p','lc-muted','Зараз: '+place.url),el('p','lc-meta','Анкор: '+text(place.anchor)));
        var url=field(row,'Нова повна адреса','replacementUrl','url',place.url);url.maxLength=10000;
        if(native){row.appendChild(el('p','lc-muted',place.memberCount+' переходів · '+place.nativeCount+' прямих href'));list(place.members).forEach(function(member){row.appendChild(el('p','lc-muted','Анкор: '+member.anchor));});}
        if(!native&&place.anchorEditable===true)field(row,'Новий точний анкор (можна залишити попередній)','replacementAnchor','text',place.anchor);
        else row.appendChild(el('p','lc-muted','Анкор цього місця зберігається, щоб не змінити спільний текст або вкладену розмітку.'));
        form.appendChild(row);
      });
      var submit=button('Показати точні зміни',null,null,true);submit.type='submit';form.appendChild(submit);workflowPanel.appendChild(form);
    }
    function renderRollbackForm() {
      var versions=list(flow.versions);workflowPanel.appendChild(el('p','lc-muted','Відкат поверне вміст, заголовок і стан вибраної записаної версії. Нові ручні зміни у WordPress заблокують відкат: спочатку потрібно звірити сторінку.'));
      if(!versions.length){workflowPanel.appendChild(el('p','lc-muted','Попередніх записаних версій для відкату ще немає.'));return;}
      var form=el('form','lc-form');form.dataset.lcForm='rollback';var select=field(form,'Яку попередню версію відновити','rollbackVersion','select');select.required=true;
      versions.forEach(function(version){option(select,version.id,'Версія '+version.revision+' · '+(version.title || 'Без назви')+' · '+statusText(version.status)+' · '+date(version.createdAt));});
      var submit=button('Показати зміни відкату',null,null,true);submit.type='submit';form.appendChild(submit);workflowPanel.appendChild(form);
    }
    function renderProposal(proposal) {
      var rollback=['rollback','native-rollback'].includes(proposal.kind);workflowPanel.appendChild(el('h4','',rollback?'Перевірте версію перед відкатом':'Перевірте перед заміною'));
      workflowPanel.appendChild(el('p','lc-muted',rollback?'Відновиться наведена версія цієї сторінки. Перевірте заголовок, стан і повний код. Нові ручні зміни на сайті зупинять запис.':'Зміниться лише наведений список у цій сторінці. Після підтвердження сервер перевірить версію ще раз.'));
      var diff=el('div','lc-diffs');list(proposal.diff).forEach(function(item){var row=el('article','lc-diff');row.appendChild(el('h4','',item.label || item.id));[['Було',item.before],['Буде',item.after]].forEach(function(part){var box=el('div','lc-diff-side'),value=text(part[1] && part[1].anchor);box.appendChild(el('strong','',part[0]));
        if(part[1] && part[1].url)box.appendChild(el('p','lc-exact-url',part[1].url));
        if(rollback){box.appendChild(el('p','lc-muted','Текст / значення'));if(/content|html/i.test(item.id || '') || value.length>500){var details=el('details');append(details,el('summary','','Показати повний код / текст'),el('pre','lc-exact-url',value));box.appendChild(details);}else box.appendChild(el('p','lc-exact-url',value));}
        else box.appendChild(el('p','lc-muted','Анкор: '+value));row.appendChild(box);});diff.appendChild(row);});workflowPanel.appendChild(diff);
      if(proposal.state==='pending' && list(proposal.diff).length)workflowPanel.appendChild(button(rollback?'Підтверджую відкат цієї версії':'Підтверджую ці заміни','confirm-proposal',proposal.id,true));
      else workflowPanel.appendChild(el('p','lc-error-text','Ця пропозиція більше не очікує підтвердження. Оновіть сторінку.'));
    }
    async function launchPublication(form,token) {
      var page=flowPage(),serial=flowId;if(!page || flow.kind!=='publish' || page.revision!==flow.pageRevision)throw{code:'CONFLICT'};
      if(publishLaunch(page) || pendingPageLaunch(page.id))return;
      var siteId=value(form,'publishSite'),mode=value(form,'publishMode'),site=sites.find(function(item){return item.id===siteId;});if(!siteReady(site) || ['draft','publish'].indexOf(mode)<0)throw{code:'SITE_NOT_READY'};
      var key='publish:'+page.id,payload={siteId:siteId,mode:mode,expectedRevision:page.revision,idempotencyKey:newKey()},launch={pageId:page.id,projectId:selected,expectedRevision:page.revision,siteId:siteId,mode:mode,idempotencyKey:payload.idempotencyKey,state:'submitting'};
      launches[key]=launch;saveLaunches();flow.launchKey=key;flow.state='dispatched';renderFlow();
      try{var result=await request('/pages/'+encodeURIComponent(page.id)+'/publish','POST',payload);if(!result.job || !result.job.id)throw{code:'invalid_response'};launch.jobId=result.job.id;launch.state=result.job.state || 'queued';saveLaunches();if(disposed||token!==epoch)return;acceptJob(result.job);if(serial===flowId)renderFlow();polls=0;await loadProject(token,false);}
      catch(error){if(error.status && error.status<500 && error.status!==408){delete launches[key];saveLaunches();if(!disposed&&token===epoch&&serial===flowId){flow.state=error.status===409?'conflict':'editing';flow.error=errorText(error);renderFlow();message(errorText(error),true);}}else{launch.state='uncertain';saveLaunches();if(!disposed&&token===epoch&&serial===flowId)renderFlow();}}
    }
    async function prepareReplacement(form,token) {
      var page=flowPage(),serial=flowId;if(!page || flow.kind!=='replacement' || flow.state!=='editing' || pendingPageLaunch(page.id) || page.revision!==flow.pageRevision)throw{code:'CONFLICT'};
      var changes=[];Array.from(form.querySelectorAll('[data-lc-placement]')).forEach(function(row){if(!row.querySelector('[name="replacementSelected"]').checked)return;var place=flow.placements.find(function(item){return item.id===row.dataset.lcPlacement;}),url=row.querySelector('[name="replacementUrl"]').value;
        try{var parsed=new URL(url);if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password||/\s/.test(url))throw 0;}catch(_){throw{code:'invalid_url'};}
        var change={id:place.id,url:url,expectedUrl:place.url,expectedAnchor:place.anchor};if(place.binding!==undefined)change.expectedBinding=place.binding;var anchor=row.querySelector('[name="replacementAnchor"]');if(anchor && place.anchorEditable===true)change.anchor=anchor.value;changes.push(change);
      });if(!changes.length)throw{code:'VALIDATION'};
      var result=await request('/pages/'+encodeURIComponent(page.id)+'/proposals','POST',{expectedRevision:flow.pageRevision,changes:changes});if(disposed||token!==epoch||serial!==flowId)return;
      if(!result.proposal || result.proposal.pageId!==page.id || result.proposal.expectedPageRevision!==flow.pageRevision)throw{code:'CONFLICT'};
      flow.proposal=result.proposal;flow.state='review';renderFlow();
    }
    async function prepareRollback(form,token) {
      var page=flowPage(),serial=flowId;if(!page || flow.kind!=='rollback' || flow.state!=='editing' || pendingPageLaunch(page.id) || page.revision!==flow.pageRevision)throw{code:'CONFLICT'};
      var versionId=value(form,'rollbackVersion');if(!list(flow.versions).some(function(version){return version.id===versionId;}))throw{code:'VALIDATION'};
      var result=await request('/pages/'+encodeURIComponent(page.id)+'/rollback-proposals','POST',{expectedRevision:flow.pageRevision,versionId:versionId});if(disposed||token!==epoch||serial!==flowId)return;
      if(!result.proposal || !['rollback','native-rollback'].includes(result.proposal.kind) || result.proposal.pageId!==page.id || result.proposal.expectedPageRevision!==flow.pageRevision)throw{code:'CONFLICT'};
      flow.proposal=result.proposal;flow.state='review';renderFlow();
    }
    async function confirmProposal(token) {
      var current=flow,page=flowPage(),serial=flowId,proposal=current && current.proposal;
      if(!proposal || proposal.state!=='pending' || current.state!=='review' || !page || pendingPageLaunch(page.id) || page.revision!==current.pageRevision || proposal.expectedPageRevision!==page.revision)throw{code:'CONFLICT'};
      var key='proposal:'+proposal.id;if(launches[key])return;
      var native=current.replacement?.mode==='native',launch={pageId:page.id,projectId:selected,proposalId:proposal.id,expectedRevision:proposal.revision,idempotencyKey:key,state:'submitting',...(native?{native:true}:{})};launches[key]=launch;if(!saveLaunches()&&native){delete launches[key];throw{code:'NATIVE_CONFIRM_STORAGE_UNAVAILABLE'};}flow.launchKey=key;flow.state='dispatched';renderFlow();
      try{var result=await request('/proposals/'+encodeURIComponent(proposal.id)+'/confirm','POST',{expectedRevision:proposal.revision,confirmed:true});if(!result.job || !result.job.id)throw{code:'invalid_response'};launch.jobId=result.job.id;launch.state=result.job.state || 'queued';saveLaunches();if(disposed||token!==epoch)return;acceptJob(result.job);if(native&&serial===flowId)await readNativeFlow(token,serial);else if(serial===flowId)renderFlow();polls=0;await loadProject(token,false);}
      catch(error){if(error.status && error.status<500 && error.status!==408){delete launches[key];saveLaunches();if(!disposed&&token===epoch&&serial===flowId){flow.state='conflict';flow.error=errorText(error);renderFlow();}}else{launch.state='uncertain';saveLaunches();if(!disposed&&token===epoch&&serial===flowId){renderFlow();if(native)try{await readNativeFlow(token,serial);}catch{}}}}
    }


    function replayRequest(launch) {
      if(!launch || !Number.isSafeInteger(launch.expectedRevision))return null;
      if(launch.proposalId && /^[a-zA-Z0-9-]+$/.test(launch.proposalId) && launch.idempotencyKey==='proposal:'+launch.proposalId)return {path:'/proposals/'+encodeURIComponent(launch.proposalId)+'/confirm',body:{expectedRevision:launch.expectedRevision,confirmed:true}};
      if(/^[a-zA-Z0-9-]+$/.test(launch.pageId || '') && /^[a-zA-Z0-9-]+$/.test(launch.siteId || '') && ['draft','publish'].indexOf(launch.mode)>=0 && /^[a-f0-9-]{36}$/i.test(launch.idempotencyKey || ''))return {path:'/pages/'+encodeURIComponent(launch.pageId)+'/publish',body:{siteId:launch.siteId,mode:launch.mode,expectedRevision:launch.expectedRevision,idempotencyKey:launch.idempotencyKey}};
      return null;
    }
    async function retryLaunch(key,token) {
      var launch=launches[key],serial=flowId;if(!launch || launch.projectId!==selected || launch.state!=='uncertain' || launch.jobId || !launch.canReplay)return;
      launch.canReplay=false;var fresh=await loadProject(token,false);if(!fresh || disposed || token!==epoch)return;
      launch=launches[key];if(!launch || launch.state!=='uncertain' || launch.jobId || !launch.canReplay){renderFlow();return;}
      var replay=replayRequest(launch);if(!replay)throw{code:'VALIDATION'};launch.state='submitting';launch.canReplay=false;saveLaunches();renderFlow();
      try{var data=await request(replay.path,'POST',replay.body);if(!data.job || !data.job.id)throw{code:'invalid_response'};launch.jobId=data.job.id;launch.state=data.job.state || 'queued';saveLaunches();if(disposed||token!==epoch)return;acceptJob(data.job);if(serial===flowId)renderFlow();await loadProject(token,false);}
      catch(error){if(error.status && error.status<500 && error.status!==408){delete launches[key];saveLaunches();if(!disposed&&token===epoch&&serial===flowId && flow){flow.state='conflict';flow.error=errorText(error);renderFlow();}}else{launch.state='uncertain';launch.canReplay=false;saveLaunches();if(!disposed&&token===epoch&&serial===flowId)renderFlow();}}
    }
    function showRecovery() {
      recoveryDraft=null;restoreDraft=null;restoreReadId++;clear(restorePanel);restorePanel.hidden=false;
      var head=el('div','lc-card-head');append(head,el('h3','','Повна захищена копія'),button('Закрити','close-restore'));restorePanel.appendChild(head);
      restorePanel.appendChild(el('p','lc-muted','Зашифрована копія включає матеріали, доступи, історію, черги та докази перевірок. Збережіть файл і пароль окремо: пароль не зберігається в браузері. Для перенесення лише матеріалів використайте звичайний експорт.'));
      var exportForm=el('form','lc-form lc-form-grid');exportForm.dataset.lcForm='recovery-export';var password=field(exportForm,'Пароль копії — щонайменше 12 символів','exportPassphrase','password','',true);password.minLength=12;password.maxLength=256;password.autocomplete='new-password';var download=button('Створити й завантажити',null,null,true);download.type='submit';exportForm.appendChild(download);restorePanel.appendChild(exportForm);
      var details=el('details','lc-create');details.appendChild(el('summary','','Відновити повну захищену копію'));details.appendChild(el('p','lc-muted','Відновлення можливе лише в порожню базу. Після нього потрібен перезапуск сервера; автоматичні завдання залишаться призупиненими до ручного продовження.'));
      var form=el('form','lc-form lc-form-grid');form.dataset.lcForm='recovery-inspect';var file=field(form,'Файл захищеної копії','recoveryFile','file',undefined,true);file.accept='.json,application/json';var pass=field(form,'Пароль цієї копії','importPassphrase','password','',true);pass.minLength=12;pass.maxLength=256;pass.autocomplete='off';var inspect=button('Перевірити копію перед відновленням',null,null,true);inspect.type='submit';form.appendChild(inspect);details.appendChild(form);var review=el('section','lc-recovery-review');review.setAttribute('aria-live','polite');details.appendChild(review);restorePanel.appendChild(details);
    }
    function downloadJSON(data,filename) {var url=win.URL.createObjectURL(new win.Blob([JSON.stringify(data,null,2)],{type:'application/json'})),link=el('a');link.href=url;link.download=filename;doc.body.appendChild(link);link.click();link.remove();win.setTimeout(function(){win.URL.revokeObjectURL(url);},1000);}
    async function exportRecovery(form,token) {var passphrase=value(form,'exportPassphrase');if(passphrase.length<12)throw{code:'VALIDATION'};try{var archive=await request('/recovery/export','POST',{passphrase:passphrase});if(disposed||token!==epoch)return;downloadJSON(archive,'PagePoster-full-encrypted-backup.json');message('Повну захищену копію завантажено. Збережіть пароль окремо.');}finally{form.elements.namedItem('exportPassphrase').value='';}}
    async function inspectRecovery(form,token) {
      recoveryDraft=null;var serial=++restoreReadId,passphrase=value(form,'importPassphrase'),file=form.elements.namedItem('recoveryFile').files[0],review=restorePanel.querySelector('.lc-recovery-review');clear(review);if(!file||passphrase.length<12)throw{code:'VALIDATION'};if(file.size>150*1024*1024)throw{code:'RECOVERY_TOO_LARGE'};
      var raw=typeof file.text==='function'?await file.text():await new Promise(function(resolve,reject){var reader=new win.FileReader();reader.onload=function(){resolve(reader.result);};reader.onerror=function(){reject({code:'BACKUP_INVALID'});};reader.readAsText(file);});var backup;try{backup=JSON.parse(raw);}catch(_){throw{code:'BACKUP_INVALID'};}
      try{var result=await request('/recovery/inspect','POST',{passphrase:passphrase,backup:backup});if(disposed||token!==epoch||serial!==restoreReadId)return;if(!result.summary)throw{code:'invalid_response'};var summary=result.summary;
        append(review,el('h4','','Перевірте склад копії'),el('p','lc-muted',[['Проєктів',summary.projects],['Сторінок',summary.pages],['Сайтів',summary.sites],['Запусків',summary.runs],['Завдань',summary.jobs],['Файлів',summary.files]].map(function(item){return item[0]+': '+(item[1]==null?'—':item[1]);}).join(' · ')),el('p','lc-meta',date(summary.createdAt)));
        if(result.canRestore===true&&!projects.length){recoveryDraft={backup:backup,passphrase:passphrase};append(review,el('p','lc-muted','Підтвердження відновить цю копію в порожню базу. Потрібен перезапуск; автоматичні завдання не відновляться самостійно.'),button('Підтверджую повне відновлення','confirm-recovery',null,true));}
        else review.appendChild(el('p','lc-error-text',projects.length?errors.RESTORE_NOT_EMPTY:errorText({code:result.reason||'RECOVERY_BUSY'})));
      }finally{form.elements.namedItem('importPassphrase').value='';}
    }
    async function restoreRecovery(token) {if(!recoveryDraft||projects.length)throw{code:'RESTORE_NOT_EMPTY'};var payload={passphrase:recoveryDraft.passphrase,backup:recoveryDraft.backup,confirmed:true};recoveryDraft=null;var result=await request('/recovery/restore','POST',payload);if(disposed||token!==epoch)return;if(result.restored!==true)throw{code:'invalid_response'};clear(restorePanel);append(restorePanel,el('h3','','Копію відновлено — перезапустіть сервер'),el('p','lc-muted','Сайти вимкнені, запуски й публікації призупинено. Невідомі результати потребують звірки. Після перезапуску перевірте доступи й незавершені операції перед ручним продовженням.'),button('Закрити','close-restore'));}
    function showRestore() {
      if(!status || !status.available)return;restoreReadId++;restoreDraft=null;clear(restorePanel);restorePanel.hidden=false;
      var head=el('div','lc-card-head');append(head,el('h3','','Відновити резервну копію'),button('Закрити','close-restore'));restorePanel.appendChild(head);
      restorePanel.appendChild(el('p','lc-muted','Відновлення працює лише в порожній робочий простір і не замінює наявні проєкти. Сайти будуть вимкнені, паролі не відновлюються, старі завдання не запускаються. Доступи й перевірки потрібно налаштувати заново.'));
      var input=field(restorePanel,'JSON-файл резервної копії PagePoster','backupFile','file');input.accept='.json,application/json';input.disabled=projects.length>0;
      if(projects.length)restorePanel.appendChild(el('p','lc-error-text','У цьому просторі вже є проєкти. Для відновлення потрібен порожній серверний реєстр.'));
      var review=el('div','lc-restore-review');review.setAttribute('aria-live','polite');restorePanel.appendChild(review);
    }
    async function readBackup(file) {
      var serial=++restoreReadId,token=epoch;restoreDraft=null;var review=restorePanel.querySelector('.lc-restore-review');if(!review)return;clear(review);if(!file)return;
      try{if(projects.length)throw{code:'DATABASE_NOT_EMPTY'};if(file.size>49990000)throw{code:'BACKUP_TOO_LARGE'};
        var raw=typeof file.text==='function'?await file.text():await new Promise(function(resolve,reject){var reader=new win.FileReader();reader.onload=function(){resolve(reader.result);};reader.onerror=function(){reject({code:'BACKUP_INVALID'});};reader.readAsText(file);});
        if(disposed||token!==epoch||serial!==restoreReadId)return;var backup;try{backup=JSON.parse(raw);}catch(_){throw{code:'BACKUP_INVALID'};}
        if(!backup || backup.kind!=='pageposter-lifecycle-backup' || [1,2].indexOf(backup.schemaVersion)<0 || !['projects','sites','pages'].every(function(key){return Array.isArray(backup[key]);}))throw{code:'BACKUP_INVALID'};
        restoreDraft=backup;append(review,el('h4','','Перевірте вміст копії'),el('p','lc-muted','Проєктів: '+backup.projects.length+' · Сайтів: '+backup.sites.length+' · Сторінок: '+backup.pages.length),el('p','lc-muted','Файл залишається лише в пам’яті цієї вкладки до підтвердження. Сервер перевірить його структуру перед відновленням.'),button('Відновити ці проєкти','confirm-restore',null,true));
      }catch(error){if(!disposed&&token===epoch&&serial===restoreReadId){restoreDraft=null;clear(review);review.appendChild(el('p','lc-error-text',errorText(error)));}}
    }
    async function restoreBackup(token) {
      if(!restoreDraft)throw{code:'BACKUP_INVALID'};if(projects.length)throw{code:'DATABASE_NOT_EMPTY'};
      var data=await request('/backup/restore','POST',{backup:restoreDraft});if(disposed||token!==epoch)return;
      restoreDraft=null;restoreReadId++;clear(restorePanel);restorePanel.hidden=true;toast('Резервну копію відновлено. Сайти вимкнені; підключіть їх заново.');await refresh();
    }

    async function downloadBackup() {
      var token=epoch,data=await request('/backup');if(disposed||token!==epoch)return;
      var blob=new win.Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=win.URL.createObjectURL(blob);
      var link=el('a');link.href=url;link.download='PagePoster-projects-backup.json';doc.body.appendChild(link);link.click();link.remove();win.setTimeout(function(){win.URL.revokeObjectURL(url);},1000);toast('Резервну копію без паролів завантажено.');
    }
    function onClick(event) {
      var control=event.target.closest('button');if(!control||!root.contains(control)||control.disabled)return;
      if(control.dataset.lcProject){closeRuns();selectProject(control.dataset.lcProject);return;}
      if(control.dataset.lcTab){tab=control.dataset.lcTab;checksId++;extraLoad++;renderWorkspace();return;}
      var action=control.dataset.lcAction,id=control.dataset.lcId;
      if(action==='reset-import'){importDraft=null;renderImportPreview();return;}
      if(action==='reset-batch'){batchDraft=null;batchPlacements=[];clear(content);replacementBatchView();return;}
      if(action==='show-archived'){showArchived=!showArchived;control.textContent=showArchived?'Сховати архів':'Показати архів';renderProjects();return;}
      if(action==='new-page'){showComposer();return;}
      if(action==='close-composer'){composerPanel.hidden=true;clear(composerPanel);return;}
      if(action==='editor-ai'||action==='editor-html'){if(options.openEditor)options.openEditor(action==='editor-ai'?'ai':'html');return;}
      if(action==='close-runs'){closeRuns();return;}
      if(action==='automation-page'){var page=pages.find(function(p){return p.id===id;});if(!page||!win.PagePosterRuns)return;closeRuns();runPanel.hidden=false;append(runPanel,button('Закрити запуск','close-runs'));var container=el('div');runPanel.appendChild(container);var project=projects.find(function(p){return p.id===selected;})||{};runUI=win.PagePosterRuns.create({element:container,page:Object.assign({language:project.language,country:project.country},page),sites:sites,request:request,onChanged:function(){polls=0;loadProject(epoch,false);}});runUI.refresh().catch(function(error){message(errorText(error),true);});runPanel.scrollIntoView?.({block:'start'});return;}
      if(action==='refresh'){refresh();return;}
      if(action==='recovery'){showRecovery();return;}
      if(action==='restore-backup'){showRestore();return;}
      if(action==='close-restore'){restoreReadId++;restoreDraft=null;recoveryDraft=null;restorePanel.hidden=true;clear(restorePanel);return;}
      if(action==='page-checks'){showChecks(id);return;}
      if(action==='batch-page-access'){tab='pages';renderWorkspace();openFlow('replacement',id);return;}
      if(action==='publish-page'||action==='replace-links'||action==='rollback-page'){openFlow(action==='publish-page'?'publish':action==='rollback-page'?'rollback':'replacement',id);return;}
      if(action==='close-flow'){flow=null;flowId++;renderFlow();return;}
      if(!action)return;
      mutate(control,async function(token){
        if(action==='native-update-status'||action==='native-update-reconcile'){await readNativeFlow(token,flowId,action==='native-update-reconcile');return;}
        if(action==='native-update-resume'){await resumeNativeFlow(token,flowId);return;}
        if(action==='native-update-check'){await checkNativeFlow(token,flowId);return;}
        if(action==='confirm-recovery'){await restoreRecovery(token);return;}
        if(action==='backup'){await downloadBackup();return;}
        if(action==='confirm-import'){var preview=importDraft;if(!preview||preview.id!==id||!preview.canAdopt||preview.confirming)return;preview.confirming=true;renderImportPreview();try{var result=await request('/imports/'+encodeURIComponent(id)+'/confirm','POST',{expectedRevision:preview.revision,confirmationHash:preview.confirmationHash,confirmed:true});if(disposed||token!==epoch)return;if(!result.job||!result.job.id)throw{code:'invalid_response'};preview.confirming=false;preview.job=result.job;acceptJob(result.job);if(tab==='pages')renderImportPreview();await loadProject(token,false);}catch(error){if(!disposed&&token===epoch&&error.status&&error.status<500){preview.confirming=false;preview.canAdopt=false;preview.warnings=[errorText(error)];renderImportPreview();}throw error;}return;}

        if(action==='load-batch'){await loadBatchPlacements(token);return;}
        if(action==='batch-history'){var serial=++extraLoad,result=await request('/projects/'+encodeURIComponent(selected)+'/replacement-batches');if(disposed||token!==epoch||serial!==extraLoad||tab!=='replacements')return;var parent=control.parentNode;batches=list(result.batches);batches.forEach(function(b){parent.appendChild(button((date(b.createdAt)||'Пакет')+' · '+statusText(b.state),'open-batch',b.id));});if(!batches.length)parent.appendChild(el('p','lc-muted','Пакетів ще немає.'));control.remove();return;}
        if(action==='open-batch'||action==='refresh-batch'){var serial=++extraLoad,result=await request('/replacement-batches/'+encodeURIComponent(id));if(disposed||token!==epoch||serial!==extraLoad||tab!=='replacements')return;if(!result.batch)throw{code:'invalid_response'};batchDraft=result.batch;clear(content);replacementBatchView();return;}
        if(action==='confirm-batch'){var batch=batchDraft;if(!batch||batch.id!==id||batch.state!=='pending'||batch.confirming)return;batch.confirming=true;clear(content);replacementBatchView();try{var result=await request('/replacement-batches/'+encodeURIComponent(id)+'/confirm','POST',{expectedRevision:batch.revision,confirmationHash:batch.confirmationHash,confirmed:true});if(disposed||token!==epoch||tab!=='replacements')return;if(!result.batch)throw{code:'invalid_response'};batchDraft=result.batch;clear(content);replacementBatchView();}catch(error){if(disposed||token!==epoch)return;if(error.status&&error.status<500){batch.confirming=false;batch.state='conflict';clear(content);replacementBatchView();}throw error;}return;}

        if(action==='copy-url'){var page=pages.find(function(p){return p.id===id;});if(page&&page.fullUrl){if(!win.navigator.clipboard||!win.navigator.clipboard.writeText)throw{code:'CLIPBOARD_UNAVAILABLE'};await win.navigator.clipboard.writeText(page.fullUrl);message('Повну адресу скопійовано.');}return;}
        if(action==='archive-project'){var project=projects.find(function(p){return p.id===selected;});var result=await request('/projects/'+encodeURIComponent(selected),'PATCH',{archived:!project.archived,expectedRevision:project.revision});if(disposed||token!==epoch)return;if(!result.project)throw{code:'invalid_response'};projects=projects.map(function(p){return p.id===selected?result.project:p;});renderProjects();renderWorkspace();message(result.project.archived?'Проєкт перенесено в архів.':'Проєкт повернуто з архіву.');return;}
        if(action==='existing-sites'){var result=await request('/sites');if(disposed||token!==epoch||tab!=='sites')return;var area=content.querySelector('.lc-shared-sites');clear(area);var available=list(result.sites).filter(function(s){return !sites.some(function(own){return own.id===s.id;});});area.appendChild(el('h4','','Уже підключені сайти'));if(!available.length)area.appendChild(el('p','lc-muted','Інших підключених сайтів поки немає.'));available.forEach(function(site){area.appendChild(button('Додати «'+(site.name||site.baseUrl)+'» до проєкту','link-site',site.id));});return;}
        if(action==='link-site'){await request('/projects/'+encodeURIComponent(selected)+'/sites/link','POST',{siteId:id});if(disposed||token!==epoch)return;await loadProject(token,true);message('Сайт додано до проєкту зі збереженим підключенням.');return;}

        if(action==='download-bridge'||action==='download-clean-links'){downloadPlugin(action==='download-bridge'?'bridge':'cleanLinks');return;}
        if(action==='refresh-launch'){await loadProject(token,false);if(!disposed && token===epoch)renderFlow();return;}
        if(action==='confirm-proposal'){await confirmProposal(token);return;}
        if(action==='retry-launch'){await retryLaunch(id,token);return;}
        if(action==='confirm-restore'){await restoreBackup(token);return;}
        if(action==='reconcile-job'||action==='retry-job'||action==='pause-job'||action==='resume-job'){var result=await request('/jobs/'+encodeURIComponent(id)+(action==='reconcile-job'?'/reconcile':action==='retry-job'?'/retry':action==='resume-job'?'/resume':'/pause'),'POST',{});if(disposed||token!==epoch)return;if(result.job)acceptJob(result.job);await loadProject(token,false);return;}
        if(action==='save-new'||action==='update-page'){await savePage(action==='update-page'?id:null,token);return;}
        if(action==='open-page'){
          var data=await request('/pages/'+encodeURIComponent(id));if(disposed||token!==epoch)return;
          if(data.page&&hasConfig(data.page)&&typeof options.openEditorSnapshot==='function')await options.openEditorSnapshot(clone(data.page.config));return;
        }
        if(action==='check-site'||action==='check-page'){
          await request('/'+(action==='check-site'?'sites':'pages')+'/'+encodeURIComponent(id)+'/check','POST',{});
          if(disposed||token!==epoch)return;polls=0;toast('Перевірку додано до серверної черги.');await loadProject(token,false);return;
        }
        if(action==='toggle-site'){
          var site=sites.find(function(s){return s.id===id;});if(!site)throw{code:'not_found'};
          await request('/sites/'+encodeURIComponent(id),'PATCH',{enabled:site.enabled===false,expectedRevision:site.revision});
          if(!disposed&&token===epoch)await loadProject(token,false);
        }
      });
    }
    function value(form,name){var control=form.elements.namedItem(name);return control?control.value:'';}
    function onSubmit(event) {
      var form=event.target.closest('form[data-lc-form]');if(!form||!root.contains(form))return;event.preventDefault();
      if(!form.checkValidity()){form.reportValidity();return;}
      var submit=form.querySelector('button[type="submit"]');if(!submit||submit.disabled||form.querySelector('fieldset:disabled'))return;
      mutate(submit,async function(token){
        var kind=form.dataset.lcForm;
        if(kind==='native-access'){var current=flow,serial=flowId,page=flowPage();if(!current||!page||current.replacement?.mode!=='native'||!current.replacement.accessRequired)throw{code:'CONFLICT'};var access={expectedRevision:current.pageRevision,username:value(form,'nativeUsername').trim(),password:value(form,'nativePassword')};form.elements.nativePassword.value='';form.elements.nativeUsername.value='';try{await request('/pages/'+encodeURIComponent(page.id)+'/native-access','POST',access);}finally{access.password='';}if(!disposed&&token===epoch&&serial===flowId)await openFlow(current.kind,page.id);return;}
        if(kind==='recovery-export'){await exportRecovery(form,token);return;}
        if(kind==='recovery-inspect'){await inspectRecovery(form,token);return;}
        if(kind==='import-preview'){await previewImport(form,token);return;}
        if(kind==='replacement-batch'){await prepareBatch(form,token);return;}
        if(kind==='project-settings'){await updateProjectSettings(form,token);return;}
        if(kind==='new-page'){await createPage(form,token);return;}
        if(kind==='publish'){await launchPublication(form,token);return;}
        if(kind==='replacement'){await prepareReplacement(form,token);return;}
        if(kind==='rollback'){await prepareRollback(form,token);return;}
        if(kind==='project'){
          var data=await request('/projects','POST',{name:value(form,'projectName').trim(),description:value(form,'projectDescription').trim(),language:value(form,'projectLanguage'),country:value(form,'projectCountry')});
          if(disposed||token!==epoch)return;projects.push(data.project);form.reset();form.closest('details').open=false;selected=data.project.id;pages=[];sites=[];jobs=[];events=[];overview=null;tab='pages';epoch++;renderProjects();renderWorkspace();await loadProject(epoch,true);return;
        }
        if(!selected)return;
        if(kind==='site'){
          var url=value(form,'siteUrl').trim();if(!safeUrl(url))throw{code:'invalid_url'};
          await request('/projects/'+encodeURIComponent(selected)+'/sites','POST',{name:value(form,'siteName').trim(),baseUrl:url,username:value(form,'siteUsername').trim(),applicationPassword:value(form,'sitePassword')});
          form.elements.namedItem('sitePassword').value='';
          if(disposed||token!==epoch)return;form.reset();toast('Підключення збережено. Тепер можна перевірити доступ.');await loadProject(token,false);return;
        }
        if(kind==='monitor-page'){
          var fullUrl=value(form,'monitorUrl').trim();if(!safeUrl(fullUrl))throw{code:'invalid_url'};
          var payload={title:value(form,'monitorTitle').trim(),siteId:value(form,'monitorSite'),fullUrl:fullUrl,wpType:'page'};
          var wpId=value(form,'monitorWpId');if(wpId)payload.wpId=Number(wpId);
          await request('/projects/'+encodeURIComponent(selected)+'/pages','POST',payload);
          if(disposed||token!==epoch)return;form.reset();toast('Готову адресу додано до реєстру.');await loadProject(token,false);
        }
      });
    }
    function onInput(event){if(['recoveryFile','importPassphrase'].indexOf(event.target.name)>=0){restoreReadId++;recoveryDraft=null;var review=restorePanel&&restorePanel.querySelector('.lc-recovery-review');if(review)clear(review);return;}if(['importSite','importWpId','importWpType'].indexOf(event.target.name)>=0&&importDraft&&!importDraft.confirming&&!importDraft.job){extraLoad++;importDraft=null;renderImportPreview();return;}if(event.target.dataset.batchSelect){if(event.target.checked)batchSelection.add(event.target.dataset.batchSelect);else batchSelection.delete(event.target.dataset.batchSelect);return;}if(event.target.name==='backupFile' && event.type==='change'){readBackup(event.target.files && event.target.files[0]);return;}if(event.target.name==='publishSite'||event.target.name==='publishMode')updatePublishReadiness();if(event.target.name==='pageSearch'){search=event.target.value;renderPageRows();}if(event.target.name==='pageState'){filter=event.target.value;renderPageRows();}}
    function onVisibility(){if(visible()){polls=0;schedulePoll();}else stopPolling();}
    root.addEventListener('click',onClick);root.addEventListener('submit',onSubmit);root.addEventListener('input',onInput);root.addEventListener('change',onInput);doc.addEventListener('visibilitychange',onVisibility);
    shell();message('Відкрийте проєкти для підключення до сервера.');
    return {refresh:refresh,destroy:function(){if(disposed)return;closeCampaigns();closeRuns();disposed=true;epoch++;checksId++;stopPolling();pendingControllers.forEach(function(c){c.abort();});pendingControllers.clear();root.removeEventListener('click',onClick);root.removeEventListener('submit',onSubmit);root.removeEventListener('input',onInput);root.removeEventListener('change',onInput);doc.removeEventListener('visibilitychange',onVisibility);}};
  }
  return {create:create};
});
