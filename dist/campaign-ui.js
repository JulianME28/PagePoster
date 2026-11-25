(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PagePosterCampaignUI = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var sequence = 0;
  var states = { verified: 'Перевірено й готово', verifying: 'Очікує перевірки', attention: 'Потребує уваги', queued: 'У черзі', running: 'Виконується', paused: 'Призупинено', review: 'Готово до перегляду', draft: 'Чернетка WordPress', published: 'Опубліковано', publish: 'Опубліковано', completed: 'Завершено', failed: 'Помилка', uncertain: 'Потребує звірки' };
  var stages = { verification: 'Перевірка опублікованого результату', verified: 'Перевірено й готово', generation: 'Створення текстів', publication: 'Запис у WordPress', saved: 'Збережено', launch: 'Запуск', queued: 'Очікує запуску', preparing: 'Підготовка', generating: 'Створення текстів', generated: 'Тексти готові', saving: 'Збереження', checking: 'Перевірка', precheck: 'Перевірка', publishing: 'Запис у WordPress', running: 'Виконується', review: 'Готово до перегляду', draft: 'Чернетка збережена', published: 'Опубліковано', completed: 'Завершено', failed: 'Помилка', uncertain: 'Потребує звірки', paused: 'Призупинено' };
  var errors = {CONTENT_DUPLICATE:'Згенерований текст повторює іншу сторінку. Відкрийте редактор і змініть його перед публікацією.',CONTENT_FACT_REVIEW_REQUIRED:'Перевірте факти в тексті: знайдено непідтверджене або суперечливе твердження. Відкрийте редактор і виправте матеріал.',URL_TOO_LONG:'Адреса довша за 4000 символів. Її збережено без обрізання; виправте адресу вручну.',AI_REQUEST_INVALID:'OpenAI не прийняв запит. Перевірте параметри тексту.',AI_AUTH_FAILED:'OpenAI не прийняв ключ. Оновіть його в налаштуваннях ШІ.',AI_ACCESS_DENIED:'Ключ OpenAI не має доступу до цієї дії. Перевірте права проєкту.',AI_MODEL_UNAVAILABLE:'Обрана модель недоступна для цього ключа. Перевірте налаштування ШІ.',AI_RATE_LIMITED:'OpenAI тимчасово обмежив запити. Продовжіть запуск пізніше.',AI_PROVIDER_UNAVAILABLE:'OpenAI тимчасово недоступний. Продовжіть запуск пізніше.',AI_NETWORK_ERROR:'Не вдалося з’єднатися з OpenAI. Перевірте підключення.',AI_TIMEOUT:'OpenAI не відповів вчасно. Перед повторенням звірте результат запиту.',AI_CANCELLED:'Запит ШІ зупинено. Завершені частини збережено.',AI_REFUSED:'OpenAI відмовив у генерації цього тексту. Змініть завдання або заповніть текст вручну.', VALIDATION: 'Перевірте заповнені поля та адреси.', SITE_NOT_READY: 'Спочатку перевірте доступ до вибраного сайту.', PROJECT_ARCHIVED: 'Проєкт в архіві. Поверніть його через налаштування.', CONTENT_QUALITY_REVIEW: 'Текст потребує перегляду: перевірте факти й мову в редакторі.', AI_DUPLICATE_CONTENT: 'Згенеровані тексти повторюються. Відкрийте сторінку для перегляду.', AI_BUDGET_EXCEEDED: 'Місячного бюджету ШІ недостатньо.', AI_RESULT_UNCERTAIN: 'Результат ШІ потребує звірки; новий платний запит не запускається.', CAPACITY_EXCEEDED: 'Досягнуто ліміт сторінок, включно з чергою.', PAGE_LIMIT: 'За один запуск можна створити до 20 сторінок.', BRIDGE_REQUIRED: 'Встановіть PagePoster Bridge і перевірте доступ до сайту.', CONFLICT: 'Дані змінилися. Оновіть стан і перевірте параметри.', not_configured: 'Підключіть OpenAI у налаштуваннях ШІ.', network_error: 'Не вдалося з’єднатися із сервером.' };
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function list(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return value == null ? '' : String(value); }
  function eligiblePath(path) { return !/^(cards|moreCards)\.\d+\.(name|bonus|features|note|payout|payoutNote)$/.test(path); }
  function insertionField(path) { return /^(promoBody|(?:sections|tiles|services|reviews)\.\d+\.body|faq\.\d+\.answer)$/.test(path); }
  function active(campaign) { return campaign && ['queued', 'running', 'paused', 'uncertain', 'verifying'].indexOf(campaign.state) >= 0; }
  function ready(site) { return !!site && site.enabled !== false && site.hasCredential === true && ['ok', 'ready'].indexOf(site.status) >= 0; }
  function validUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return false;
    try { var parsed = new URL(value); return ['http:', 'https:'].indexOf(parsed.protocol) >= 0 && !!parsed.hostname && !parsed.username && !parsed.password; } catch (_) { return false; }
  }
  function errorText(error) { return errors[error && (error.code || error.errorCode)] || 'Не вдалося виконати дію. Оновіть стан і повторіть спробу.'; }

  function create(options) {
    options = options || {};
    var root = options.element;
    if (!root || !root.ownerDocument || !options.project || !options.project.id || typeof options.request !== 'function') throw new TypeError('Campaign screen requires element, project and request.');
    var doc = root.ownerDocument, win = doc.defaultView, engine = win.PagePosterAI;
    var project = clone(options.project), sites = clone(list(options.sites));
    var fetcher = options.fetchImpl || (win.fetch && win.fetch.bind(win));
    var prefix = 'pp-campaign-' + (++sequence) + '-', storageKey = 'pageposter.campaign.v1:' + encodeURIComponent(project.id);
    var draft = { name: project.name || '', topics: '', source: 'new', links: '', cardCount: '10', language: project.language || '', country: project.country || '', instructions: '', status: 'review', mode: 'empty', varyDesign: true, linkField: '', linkUrl: '', linkAnchor: '', linkCount: '1' };
    var config = null, groups = [], fields = [], selected = new Set(), selectedSites = new Set(), added = [], existing = [];
    var needsPrepare = false, step = 'source';
    var draftStorageKey = 'pageposter.campaign.draft.v1:' + encodeURIComponent(project.id);
    var pending = null, campaigns = [], disposed = false, busy = false, loading = false, loaded = false, epoch = 0, loadSequence = 0, timer = null, polls = 0, inFlight = null;
    var aiStatus = 'unknown', aiChecked = false, message = '', bad = false, signature = '', notice, form, formFields, preparedArea, launchArea, history, statusArea;
    try {
      var draftSaved = JSON.parse(win.sessionStorage.getItem(draftStorageKey) || 'null');
      if (draftSaved && draftSaved.projectId === project.id && draftSaved.draft && typeof draftSaved.draft === 'object') {
        Object.keys(draft).forEach(function (key) {
          if (typeof draftSaved.draft[key] === typeof draft[key]) draft[key] = draftSaved.draft[key];
        });
        if (draftSaved.config && typeof draftSaved.config === 'object' && !Array.isArray(draftSaved.config)) config = clone(draftSaved.config);
        selected = new Set(list(draftSaved.selected)); selectedSites = new Set(list(draftSaved.siteIds));
        added = clone(list(draftSaved.added)); existing = clone(list(draftSaved.existing)); needsPrepare = draftSaved.needsPrepare === true;
      }
    } catch (_) {}
    try {
      var saved = JSON.parse(win.sessionStorage.getItem(storageKey) || 'null');
      if (saved && saved.projectId === project.id && saved.body && /^[a-f0-9-]{36}$/i.test(saved.body.idempotencyKey) && saved.body.config && Array.isArray(saved.body.topics) && Array.isArray(saved.body.siteIds) && Array.isArray(saved.body.paths) && Array.isArray(saved.body.linkInsertions) && ['empty', 'selected', 'manual'].indexOf(saved.body.mode) >= 0) {
        pending = saved;
        if (pending.state === 'submitting') pending.state = 'uncertain';
        var body = pending.body;
        draft.name = body.name; draft.topics = body.topics.join('\n'); draft.source = 'editor'; draft.status = body.status; draft.mode = body.mode; draft.varyDesign = body.varyDesign;
        draft.language = body.brief && body.brief.language || ''; draft.country = body.brief && body.brief.country || ''; draft.instructions = body.brief && body.brief.instructions || '';
        config = clone(body.config); needsPrepare = false; added = []; selectedSites = new Set(body.siteIds); selected = new Set(body.paths); existing = clone(body.linkInsertions);
      }
    } catch (_) {}
    function persistDraft() {
      if (disposed) return;
      try {
        win.sessionStorage.setItem(draftStorageKey, JSON.stringify({ projectId: project.id, draft: draft, config: config, selected: Array.from(selected), siteIds: Array.from(selectedSites), added: added, existing: existing, needsPrepare: needsPrepare }));
      } catch (_) {}
    }
    function save() {
      try { if (pending) win.sessionStorage.setItem(storageKey, JSON.stringify(pending)); else win.sessionStorage.removeItem(storageKey); return true; }
      catch (_) { return false; }
    }
    function el(tag, className, value) { var n = doc.createElement(tag); if (className) n.className = className; if (value !== undefined) n.textContent = text(value); return n; }
    function append(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
    function button(label, action, primary) { var n = el('button', primary ? 'lc-btn lc-primary' : 'lc-btn', label); n.type = 'button'; n.dataset.campaignAction = action; return n; }
    function field(parent, label, name, kind, value, limit) {
      var box = el('div', 'lc-field'), input = el(kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input'), title = el('label', '', label);
      input.name = name; input.id = prefix + name; title.htmlFor = input.id;
      if (input.tagName === 'INPUT') input.type = kind || 'text';
      if (limit && !/(?:url|image|brandUrl|footerBrandUrl|linkUrl|links)$/i.test(name)) input.maxLength = limit;
      append(box, title, input); parent.appendChild(box);
      if (value !== undefined) input.value = text(value);
      return input;
    }
    function option(select, value, label) { var n = el('option', '', label); n.value = value; select.appendChild(n); }
    function checkbox(parent, label, dataKey, value, checked, disabled) {
      var wrap = el('label', 'ai-check'), input = el('input'); input.type = 'checkbox'; input.dataset[dataKey] = value; input.checked = !!checked; input.disabled = !!disabled;
      append(wrap, input, el('span', '', label)); parent.appendChild(wrap); return input;
    }
    function isHTML() { return !!config && config.contentMode === 'html'; }
    function locked() { return project.archived===true || busy || !!pending || campaigns.some(active); }
    function topics() { return draft.topics.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
    function chosenSites() { return sites.filter(function (s) { return selectedSites.has(s.id) && ready(s); }).map(function (s) { return s.id; }); }
    function chosen() {
      if (!config || isHTML() || draft.mode === 'manual') return [];
      return fields.filter(function (f) { return selected.has(f.path) && (draft.mode === 'selected' || !text(f.currentValue).trim()); }).map(function (f) { return f.path; });
    }
    function rebuildFields(reset) {
      groups = !config || isHTML() || !engine ? [] : engine.listGroups(config).map(function (g) { return { id: g.id, label: g.label, fields: g.fields.filter(function (f) { return eligiblePath(f.path); }) }; }).filter(function (g) { return g.fields.length; });
      fields = groups.reduce(function (all, g) { return all.concat(g.fields); }, []);
      if (reset) selected = new Set(fields.filter(function (f) { return !text(f.currentValue).trim(); }).map(function (f) { return f.path; }));
      if (!draft.linkField || !fields.some(function (f) { return f.path === draft.linkField; })) draft.linkField = (fields.find(function (f) { return insertionField(f.path); }) || {}).path || '';
    }
    function notify(value, error) {
      message = value; bad = !!error;
      if (disposed || !notice) return;
      notice.textContent = value; notice.hidden = !value; notice.className = 'lc-notice' + (bad ? ' lc-error' : ''); notice.setAttribute('role', bad ? 'alert' : 'status');
    }
    function renderStatus() {
      statusArea.replaceChildren();
      var labels = { ready: 'OpenAI підключено. Оплачувані запити почнуться лише після запуску.', missing: 'OpenAI ще не підключено. Підключіть його або виберіть «Без ШІ».', unknown: 'Стан підключення OpenAI ще не перевірено.', unavailable: 'Не вдалося перевірити підключення OpenAI. Оновіть стан.' };
      statusArea.appendChild(el('p', 'lc-muted', labels[aiStatus]));
      if (aiStatus !== 'ready') statusArea.appendChild(button('Налаштувати підключення ШІ', 'connect'));
    }
    function renderFacts() {
      var facts = el('details', 'pp-campaign-facts');
      append(facts, el('summary', '', 'Пропозиції (' + (list(config.cards).length + list(config.moreCards).length) + '), бонуси та посилання — перевірити або змінити'));
      facts.appendChild(el('p', 'lc-muted', 'Назви, бонуси, оцінки, зображення та адреси зберігаються точно. ШІ не вигадує ці дані. Невідомі значення можна залишити порожніми.'));
      var brand = el('div', 'lc-form-grid');
      [['brand', 'Назва бренду'], ['brandImage', 'Зображення бренду'], ['brandUrl', 'Посилання бренду в шапці'], ['footerBrandUrl', 'Посилання бренду в підвалі']].forEach(function (pair) { field(brand, pair[1], 'fact:' + pair[0], 'text', config[pair[0]] || '', 4000); });
      facts.appendChild(brand);
      [['cards', 'Пропозиція'], ['moreCards', 'Додаткова пропозиція']].forEach(function (pair) {
        list(config[pair[0]]).forEach(function (offer, index) {
          var row = el('fieldset', 'lc-form-grid pp-campaign-offer'); row.appendChild(el('legend', '', pair[1] + ' ' + (index + 1)));
          [['name', 'Назва'], ['image', 'Адреса зображення'], ['bonus', 'Перевірений бонус або пропозиція'], ['rating', 'Перевірена оцінка'], ['url', 'Точна адреса переходу'], ['logoUrl', 'Адреса переходу з логотипа']].forEach(function (entry) { field(row, entry[1], 'fact:' + pair[0] + '.' + index + '.' + entry[0], entry[0] === 'bonus' ? 'textarea' : 'text', offer[entry[0]] || '', 4000); });
          facts.appendChild(row);
        });
      });
      list(config.navLinks).forEach(function (link, index) { var row = el('div', 'lc-form-grid'); field(row, 'Назва пункту меню ' + (index + 1), 'fact:navLinks.' + index + '.name', 'text', link.name || '', 200); field(row, 'Точна адреса меню ' + (index + 1), 'fact:navLinks.' + index + '.url', 'text', link.url || '', 4000); facts.appendChild(row); });
      preparedArea.appendChild(facts);
    }
    function renderTextFields() {
      var section = el('div', 'pp-campaign-texts'), mode = field(section, 'Як працювати з текстами', 'mode', 'select');
      option(mode, 'empty', 'Заповнити порожні тексти'); option(mode, 'selected', 'Змінити вибрані тексти'); option(mode, 'manual', 'Без ШІ — зберегти мої тексти');
      mode.value = draft.mode; mode.disabled = isHTML();
      section.appendChild(el('p', 'lc-muted', isHTML() ? 'Імпортований HTML збережеться без змін і без ШІ.' : 'Ручні тексти збережуться, якщо ви явно не виберете їх для зміни.'));
      if (!isHTML() && draft.mode !== 'manual') {
        section.appendChild(el('p', 'lc-muted', 'Текстових полів для ШІ: ' + chosen().length + '.'));
        if (draft.mode === 'selected') {
          var actions = el('div', 'lc-actions'); append(actions, button('Вибрати всі тексти', 'select-all'), button('Зняти вибір', 'select-none')); section.appendChild(actions);
          groups.forEach(function (group) {
            var details = el('details', 'ai-select-row'); details.appendChild(el('summary', '', group.label));
            group.fields.forEach(function (f) { var check = checkbox(details, f.label, 'campaignPath', f.path, selected.has(f.path), false); check.parentNode.appendChild(el('small', 'lc-muted', text(f.currentValue).replace(/\s+/g, ' ').slice(0, 100) || 'Порожнє поле')); });
            section.appendChild(details);
          });
        }
      }
      preparedArea.appendChild(section);
    }
    function renderLinks() {
      var section = el('details', 'pp-campaign-links'); section.appendChild(el('summary', '', 'Точні посилання всередині тексту'));
      existing.concat(added).forEach(function (entry) {
        var row = el('div', 'lc-placement'); row.dataset.campaignInsertion = entry.id;
        row.appendChild(el('p', '', entry.anchor + ' → ' + entry.url + ' · ' + entry.count + ' · ' + ((fields.find(function(f){return f.path===entry.fieldPath;})||{}).label||'Текстове поле')));
        if (added.indexOf(entry) >= 0) { var remove = button('Прибрати', 'remove-link'); remove.dataset.campaignId = entry.id; row.appendChild(remove); }
        section.appendChild(row);
      });
      if (!isHTML() && draft.mode !== 'manual') {
        var available = fields.filter(function (f) { return insertionField(f.path); });
        if (available.length) {
          var body = el('div', 'lc-form-grid'); body.appendChild(el('p', 'lc-muted', 'Вкажіть точні адресу, анкор і кількість. Для вставки в ручний текст виберіть його для зміни.'));
          var target = field(body, 'Текстове поле для посилання', 'linkField', 'select');
          available.forEach(function (f) { option(target, f.path, f.label); }); target.value = draft.linkField;
          field(body, 'Точна адреса URL', 'linkUrl', 'text', draft.linkUrl, 4000); field(body, 'Точний текст посилання', 'linkAnchor', 'text', draft.linkAnchor, 2000);
          var count = field(body, 'Кількість посилань у полі', 'linkCount', 'number', draft.linkCount); count.min = '1'; count.max = '10'; count.step = '1';
          body.appendChild(button('Додати точне посилання', 'add-link')); section.appendChild(body);
        }
      }
      preparedArea.appendChild(section);
    }
    function renderPrepared() {
      if (!config) { preparedArea.appendChild(el('p', 'lc-muted', 'Підготуйте основу, щоб перевірити пропозиції й посилання перед запуском.')); return; }
      preparedArea.appendChild(el('h4', '', '2. Перевірте основу сторінок'));
      if (!isHTML()) renderFacts();
      renderTextFields(); renderLinks();
      var vary = checkbox(preparedArea, 'Змінювати дизайн для кожної сторінки', 'campaignVary', 'true', draft.varyDesign && !isHTML(), isHTML()); vary.name = 'varyDesign';
      if (isHTML()) preparedArea.appendChild(el('p', 'lc-muted', 'Для імпортованого HTML дизайн залишається незмінним.'));
    }
    function total() { var count = chosenSites().length; return topics().length * (draft.status === 'review' ? Math.max(1, count) : count); }
    function renderLaunch() {
      launchArea.replaceChildren();
      var summary = el('p', 'pp-campaign-summary'); summary.dataset.campaignSummary = ''; summary.setAttribute('aria-live', 'polite');
      var siteCount = chosenSites().length;
      summary.textContent = topics().length + ' тем × ' + (siteCount || (draft.status === 'review' ? '1 сторінка без сайту' : '0 сайтів')) + (siteCount ? ' сайтів' : '') + ' = ' + total() + ' сторінок. Ліміт — 20.';
      launchArea.appendChild(summary);
      if (needsPrepare) launchArea.appendChild(el('p', 'lc-notice', 'Джерело даних змінилося. Натисніть «Підготувати основу» ще раз.'));
      if (draft.status === 'publish') launchArea.appendChild(el('p', 'lc-muted', 'Після цього запуску готові сторінки буде опубліковано на вибраних сайтах.'));
      if (pending && pending.state === 'uncertain' && !pending.campaignId) {
        launchArea.appendChild(el('p', 'lc-notice', 'Результат запуску невідомий. Параметри зафіксовано. Оновлення звірить стан без нового запиту на створення.'));
        var retry = button('Звірити й повторити той самий запуск', 'retry'); retry.disabled = busy || loading; launchArea.appendChild(retry);
      } else if (pending && pending.state === 'submitting') launchArea.appendChild(el('p', 'lc-muted', 'Надсилаємо один запуск…'));
      var launch = button('Запустити створення сторінок', 'launch', true); launch.type = 'submit'; launch.disabled = locked() || !loaded || !config || needsPrepare || !topics().length || total() < 1 || total() > 20 || (draft.mode !== 'manual' && !isHTML() && aiStatus === 'missing');
      launchArea.appendChild(launch);
    }
    function renderHistory() {
      history.replaceChildren(); history.appendChild(el('h4', '', 'Запуски та результати'));
      var refreshButton = button('Оновити стан', 'refresh'); refreshButton.disabled = loading || busy; history.appendChild(refreshButton);
      if(campaigns.length)history.appendChild(el('p','lc-muted','Запис у WordPress і перевірка результату — окремі стани.'));
      if (!campaigns.length) history.appendChild(el('p', 'lc-muted', loaded ? 'Запусків ще немає.' : 'Завантаження стану запусків…'));
      campaigns.forEach(function (campaign) {
        var row = el('article', 'lc-card pp-campaign-result'); row.dataset.campaignId = campaign.id;
        append(row, el('h4', '', campaign.name || 'Створення сторінок'), el('strong', '', states[campaign.state] || 'Невідомий стан'));
        var counts = campaign.counts || {}, parts = [];
        ['total', 'queued', 'running', 'review', 'published', 'draft', 'failed', 'uncertain', 'paused'].forEach(function (key) { if (counts[key]) parts.push((key === 'total' ? 'Усього' : states[key] || key) + ': ' + counts[key]); });
        if (parts.length) row.appendChild(el('p', 'lc-muted', parts.join(' · ')));
        if (['queued', 'running'].indexOf(campaign.state) >= 0) {
          var pause = button('Призупинити', 'pause'); pause.dataset.campaignId = campaign.id; pause.disabled = busy; row.appendChild(pause);
          row.appendChild(el('p', 'lc-muted', 'Поточний запис на сайт може завершитися після паузи.'));
        }
        if (campaign.state === 'paused') { var resume = button('Продовжити', 'resume'); resume.dataset.campaignId = campaign.id; resume.disabled = busy; row.appendChild(resume); }
        if (campaign.state === 'uncertain') row.appendChild(el('p', 'lc-muted', 'Потрібна звірка результату. Автоматичне повторення платних запитів вимкнено.'));
        list(campaign.items).forEach(function (item) {
          var stageLabel = stages[item.stage], stateLabel = states[item.state], terminal = ['review', 'draft', 'published', 'publish', 'completed', 'failed', 'uncertain'].indexOf(item.state) >= 0;
          var resultLabel = terminal && stateLabel ? stateLabel + (stageLabel && stageLabel !== stateLabel ? ' · ' + stageLabel : '') : stageLabel || stateLabel || 'Очікує';
          var itemRow = el('div', 'lc-row pp-campaign-item'); append(itemRow, el('strong', '', item.topic), el('span', '', resultLabel));
          var site = sites.find(function (s) { return s.id === item.siteId; }); if (site) itemRow.appendChild(el('small', 'lc-muted', site.name));
          if (item.fullUrl) {
            var link = el(validUrl(item.fullUrl) ? 'a' : 'span', 'lc-url', item.fullUrl);
            if (link.tagName === 'A') { link.setAttribute('href', item.fullUrl); link.target = '_blank'; link.rel = 'noopener noreferrer'; }
            itemRow.appendChild(link);
            var copy=button('Копіювати URL','copy-url');copy.dataset.campaignUrl=item.fullUrl;itemRow.appendChild(copy);
            var verification=item.verification||{state:'pending'};var verified=el('span','lc-badge'+(verification.state==='ok'?' lc-good':verification.state==='problem'?' lc-bad':''),verification.state==='ok'?'Перевірено й готово':verification.state==='problem'?'Проблема перевірки':verification.state==='unknown'?'Перевірка невідома':'Очікує перевірки');verified.title=verification.summary||'';itemRow.appendChild(verified);
          }
          if (item.errorCode) itemRow.appendChild(el('p', 'lc-error', errors[item.errorCode] || 'Не вдалося завершити цю сторінку. Відкрийте її для перегляду причини й подальших дій.'));
          if (item.pageId) { var open = button('Відкрити сторінку', 'open-page'); open.dataset.campaignPage = item.pageId; itemRow.appendChild(open); }
          row.appendChild(itemRow);
        });
        if(campaign.verification){var check=campaign.verification;row.appendChild(el('p','lc-muted',check.state==='ok'?'Усі опубліковані сторінки перевірено.':check.state==='problem'?'У перевірках опублікованих сторінок є проблеми.':'Перевірка опублікованих сторінок ще не підтверджена.'));}
        history.appendChild(row);
      });
    }
    function render() {
      if (disposed) return;
      var focused = root.contains(doc.activeElement) ? doc.activeElement : null, focusName = focused && focused.name, start = focused && focused.selectionStart, end = focused && focused.selectionEnd;
      root.replaceChildren(); root.classList.add('lc-workflow', 'pp-campaigns');
      append(root, el('h3', '', 'Автоматичне створення сторінок'), el('p', 'lc-muted', 'Підготуйте одну основу, введіть теми та виберіть сайти. Один запуск створить усі сторінки.'));
      notice = el('p'); root.appendChild(notice); notify(project.archived?'Проєкт в архіві. Поверніть його через налаштування перед новим запуском.':message, project.archived||bad); statusArea = el('div', 'pp-campaign-ai-status'); root.appendChild(statusArea); renderStatus();
      form = el('form'); form.dataset.campaignForm = ''; form.noValidate = true;
      var stepNav=el('nav','pp-campaign-steps');stepNav.setAttribute('aria-label','Кроки автоматичного запуску');[['source','1','Теми й адреси'],['content','2','Матеріал'],['launch','3','Сайти й запуск']].forEach(function(item){var b=button(item[1]+'. '+item[2],'step-'+item[0]);b.setAttribute('aria-pressed',String(step===item[0]));b.disabled=item[0]!=='source'&&!config;stepNav.appendChild(b);});root.appendChild(stepNav);
      formFields = el('fieldset', 'pp-campaign-fields'); formFields.disabled = locked(); formFields.appendChild(el('legend', '', 'Параметри створення'));
      var inputArea = el('div', 'lc-form-grid pp-campaign-step'); inputArea.tabIndex=-1;inputArea.hidden=step!=='source'; inputArea.dataset.campaignStep='source'; inputArea.appendChild(el('h4', 'lc-wide', '1. Теми та джерело даних'));
      field(inputArea, 'Назва запуску', 'name', 'text', draft.name, 200);
      var topicInput = field(inputArea, 'Теми сторінок — по одній у рядку', 'topics', 'textarea', draft.topics, 20000); topicInput.rows = 5;
      var source = field(inputArea, 'Основа сторінок', 'source', 'select'); option(source, 'new', 'Нові сторінки за посиланнями'); option(source, 'editor', 'Використати поточний редактор'); source.value = draft.source;
      var links = field(inputArea, 'Пропозиції — назва | точна URL-адреса, по одній у рядку', 'links', 'textarea', draft.links, 40000); links.placeholder = 'Назва | https://example.com/?ref=exact'; links.disabled = draft.source !== 'new'; links.rows = 4;
      var cards = field(inputArea, 'Кількість карток', 'cardCount', 'number', draft.cardCount); cards.min = '1'; cards.max = '20'; cards.step = '1'; cards.disabled = draft.source !== 'new';
      inputArea.appendChild(button('Підготувати основу', 'prepare'));
      inputArea.appendChild(el('p', 'lc-muted', 'Підготовка локальна й безкоштовна. Поточний редактор не зміниться.'));
      formFields.appendChild(inputArea);
      preparedArea = el('div', 'pp-campaign-prepared pp-campaign-step'); preparedArea.tabIndex=-1;preparedArea.hidden=step!=='content';preparedArea.dataset.campaignStep='content';formFields.appendChild(preparedArea);renderPrepared();preparedArea.appendChild(button('Далі: сайти й запуск','step-launch',true));
      var output = el('div', 'lc-form-grid pp-campaign-step');output.tabIndex=-1;output.hidden=step!=='launch';output.dataset.campaignStep='launch'; output.appendChild(el('h4', 'lc-wide', '3. Мова та результат'));
      field(output, 'Мова текстів', 'language', 'text', draft.language, 100); field(output, 'Країна або регіон', 'country', 'text', draft.country, 100); field(output, 'Побажання до текстів', 'instructions', 'textarea', draft.instructions, 6000);
      var mode = field(output, 'Результат запуску', 'status', 'select'); option(mode, 'review', 'Зберегти для перегляду'); option(mode, 'draft', 'Створити чернетки WordPress'); option(mode, 'publish', 'Опублікувати у WordPress'); mode.value = draft.status;
      var siteList = el('fieldset', 'pp-campaign-sites');siteList.hidden=step!=='launch'; siteList.appendChild(el('legend', '', 'Сайти для створення сторінок'));
      sites.forEach(function (site) { checkbox(siteList, site.name + (ready(site) ? '' : ' — спочатку перевірте доступ'), 'campaignSite', site.id, selectedSites.has(site.id), !ready(site)); });
      siteList.appendChild(el('p', 'lc-muted', 'Для перегляду можна не вибирати сайт. Для WordPress потрібні увімкнені сайти зі збереженим доступом та успішною перевіркою.'));
      append(formFields, output, siteList); launchArea = el('div', 'pp-campaign-launch');launchArea.hidden=step!=='launch'&&!pending; append(form, formFields, launchArea); root.appendChild(form); renderLaunch();
      history = el('section', 'pp-campaign-history'); root.appendChild(history); renderHistory();
      if (focusName) { var replacement = Array.from(root.querySelectorAll('[name]')).find(function (n) { return n.name === focusName; }); if (replacement && !replacement.disabled) { replacement.focus(); if (typeof start === 'number' && typeof replacement.setSelectionRange === 'function' && ['INPUT', 'TEXTAREA'].indexOf(replacement.tagName) >= 0) { try { replacement.setSelectionRange(start, end); } catch (_) {} } } }
    }
    function stop() { if (timer !== null) win.clearTimeout(timer); timer = null; }
    function visible() { return !root.hidden && !root.closest('[hidden]') && doc.visibilityState !== 'hidden'; }
    function schedule() {
      stop();
      if (disposed || busy || loading || inFlight || !campaigns.some(function (c) { return c.state === 'queued' || c.state === 'running'; }) || !visible()) return;
      timer = win.setTimeout(function () { timer = null; if (disposed || !visible()) return; polls++; refresh().catch(function () {}); }, polls === 0 ? 5000 : polls === 1 ? 10000 : 30000);
    }
    function changed() {
      // Timestamps can change on every server checkpoint; only actual work resets polling.
      var next = JSON.stringify(campaigns.map(function (campaign) {
        var counts = campaign.counts || {};
        return { id: campaign.id, state: campaign.state, counts: ['total', 'queued', 'running', 'review', 'published', 'draft', 'failed', 'uncertain', 'paused'].map(function (key) { return counts[key] || 0; }), items: list(campaign.items).map(function (item) { return [item.pageId || '', item.runId || '', item.state || '', item.stage || '', item.fullUrl || '', item.errorCode || '']; }).sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); }) };
      }).sort(function (a, b) { return a.id.localeCompare(b.id); }));
      if (next === signature) return;
      var previous = signature; signature = next; polls = 0;
      if ((previous || campaigns.length) && typeof options.onChanged === 'function') { try { options.onChanged({ projectId: project.id, campaigns: clone(campaigns) }); } catch (_) {} }
    }
    function accept(campaign) {
      if (!campaign || !campaign.id || campaign.projectId && campaign.projectId !== project.id) throw { code: 'invalid_response' };
      if (pending) {
        if (campaign.idempotencyKey !== pending.body.idempotencyKey && campaign.id !== pending.campaignId) throw { code: 'invalid_response' };
        pending.campaignId = campaign.id; pending.state = campaign.state;
        if (!active(campaign)) pending = null;
        save();
      }
      var index = campaigns.findIndex(function (c) { return c.id === campaign.id; });
      if (index < 0) campaigns.unshift(clone(campaign)); else campaigns[index] = clone(campaign);
    }
    async function connectionStatus(token) {
      if (aiChecked || !fetcher) return;
      aiChecked = true;
      try {
        var response = await fetcher('/api/ai/status', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('status');
        var result = await response.json();
        if (!disposed && token === epoch) aiStatus = result.configured === true ? 'ready' : 'missing';
      } catch (_) { if (!disposed && token === epoch) { aiStatus = 'unavailable'; aiChecked = false; } }
    }
    function refresh() {
      if (disposed) return Promise.resolve();
      if (inFlight) return inFlight;
      var request = loadCampaigns();
      var pendingRead = request.finally(function () {
        if (inFlight === pendingRead) inFlight = null;
        schedule();
      });
      inFlight = pendingRead;
      return pendingRead;
    }
    async function loadCampaigns() {
      if (disposed) return;
      var serial = ++loadSequence, token = epoch; loading = true; stop();
      renderHistory(); renderLaunch();
      try {
        var result = await Promise.all([options.request('/projects/' + encodeURIComponent(project.id) + '/campaigns', 'GET'), connectionStatus(token)]);
        if (disposed || token !== epoch || serial !== loadSequence) return;
        if (!result[0] || !Array.isArray(result[0].campaigns)) throw { code: 'invalid_response' };
        campaigns = result[0].campaigns.filter(function (c) { return c && typeof c.id === 'string' && (!c.projectId || c.projectId === project.id); }).map(clone);
        loaded = true;
        if (pending) {
          var found = campaigns.find(function (c) { return c.idempotencyKey === pending.body.idempotencyKey || pending.campaignId && c.id === pending.campaignId; });
          if (found) accept(found);
        }
        changed();
      } catch (error) { if (!disposed && token === epoch && serial === loadSequence) notify(errorText(error), true); throw error; }
      finally { if (!disposed && token === epoch && serial === loadSequence) { loading = false; render(); } }
    }
    function uuid() {
      if (win.crypto && typeof win.crypto.randomUUID === 'function') return win.crypto.randomUUID();
      if (!win.crypto || typeof win.crypto.getRandomValues !== 'function') throw new Error('Браузер не може створити безпечний ключ запуску.');
      var bytes = win.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    function payload() {
      if (needsPrepare) throw new Error('Джерело даних змінилося. Спочатку підготуйте основу ще раз.');
      if (!config) throw new Error('Спочатку підготуйте основу сторінок.');
      if (!topics().length) throw new Error('Додайте хоча б одну тему.');
      if (total() > 20) throw new Error('За один запуск можна створити до 20 сторінок. Зменште кількість тем або сайтів.');
      if (draft.status !== 'review' && !chosenSites().length) throw new Error('Виберіть хоча б один сайт з перевіреним доступом.');
      if (draft.mode !== 'manual' && !isHTML() && aiStatus === 'missing') throw new Error('Підключіть OpenAI або виберіть режим «Без ШІ».');
      var paths = chosen();
      if (added.some(function (entry) { return paths.indexOf(entry.fieldPath) < 0; })) throw new Error('Виберіть текстові поля для доданих посилань або приберіть вставки.');
      if (!isHTML() && engine) engine.makePlan(config, { mode: draft.mode === 'empty' ? 'empty' : 'selected', paths: paths, linkInsertions: added });
      return { idempotencyKey: uuid(), name: draft.name || project.name || 'Створення сторінок', topics: topics(), siteIds: chosenSites(), status: draft.status, config: clone(config), mode: isHTML() ? 'manual' : draft.mode, paths: paths, brief: { language: draft.language, country: draft.country, instructions: draft.instructions }, linkInsertions: draft.mode === 'manual' || isHTML() ? [] : clone(existing.concat(added)), varyDesign: !isHTML() && draft.varyDesign };
    }
    async function dispatch() {
      if (!pending || disposed) return;
      var token = epoch; busy = true; loadSequence++; loading = false; pending.state = 'submitting';
      if (!save()) { pending.state = 'uncertain'; busy = false; notify('Браузер не зміг зберегти ключ запуску. Запит не надіслано; перевірте сховище.', true); render(); return; }
      render();
      try {
        var result = await options.request('/projects/' + encodeURIComponent(project.id) + '/campaigns', 'POST', clone(pending.body));
        if (disposed || token !== epoch) return;
        accept(result && result.campaign); notify('Запуск прийнято. Сторінки та результати з’являться нижче.', false); changed();
      } catch (error) {
        if (disposed || token !== epoch) return;
        if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408) { pending = null; save(); notify(errorText(error), true); }
        else { pending.state = 'uncertain'; save(); notify('Сервер не підтвердив результат. Новий запуск заблоковано до звірки.', true); }
      } finally { if (!disposed && token === epoch) { busy = false; render(); schedule(); } }
    }
    async function submit(event) {
      event.preventDefault();
      if (disposed || locked() || !loaded) return;
      try {
        var body = payload(); pending = { projectId: project.id, state: 'submitting', body: clone(body) };
        if (!save()) { pending = null; throw new Error('Браузер не зміг зберегти ключ запуску. Перевірте доступ до сховища.'); }
        await dispatch();
      } catch (error) { if (!disposed) { notify(error.message || errorText(error), true); renderLaunch(); } }
    }
    async function prepare() {
      var token = epoch; busy = true; render();
      try {
        if (!topics().length) throw new Error('Додайте хоча б одну тему сторінки.');
        var snapshot;
        if (draft.source === 'editor') {
          if (typeof options.getEditorSnapshot !== 'function') throw new Error('Поточний редактор недоступний.');
          snapshot = await options.getEditorSnapshot();
          if (snapshot && snapshot.config && !snapshot.contentMode) snapshot = snapshot.config;
        } else {
          if (typeof options.createPageSnapshot !== 'function') throw new Error('Створення основи недоступне.');
          var count = Number(draft.cardCount);
          if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Кількість карток має бути від 1 до 20.');
          var created = await options.createPageSnapshot({ keyword: topics()[0], links: draft.links, cardCount: count }); snapshot = created && created.config;
        }
        if (disposed || token !== epoch) return;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Не вдалося підготувати основу сторінок.');
        if (snapshot.contentMode !== 'html' && (!engine || typeof engine.listGroups !== 'function')) throw new Error('Модуль текстів недоступний. Оновіть сторінку.');
        config = clone(snapshot); needsPrepare = false; step='content'; existing = clone(list(config.aiLinkInsertions)); added = [];
        draft.mode = isHTML() ? 'manual' : 'empty'; rebuildFields(true); persistDraft();
        notify('Основу підготовлено. Перевірте дані й оберіть результат запуску.', false);
      } catch (error) { if (!disposed && token === epoch) notify(error.message || errorText(error), true); }
      finally { if (!disposed && token === epoch) { busy = false; render(); if(step==='content')preparedArea.focus(); } }
    }
    async function action(event) {
      var control = event.target.closest('[data-campaign-action]');
      if (!control || !root.contains(control) || control.disabled || disposed) return;
      var name = control.dataset.campaignAction;
      if (name === 'launch') return;
      if(name.indexOf('step-')===0){var requested=name.slice(5);if(['source','content','launch'].indexOf(requested)<0||requested!=='source'&&!config)return;step=requested;render();root.querySelector('[data-campaign-step="'+step+'"]')?.focus();return;}
      if(name==='copy-url'){var url=control.dataset.campaignUrl;try{await win.navigator.clipboard.writeText(url);notify('Повну адресу скопійовано.',false);}catch(_){notify('Браузер не дозволяє копіювання. Виділіть адресу вручну.',true);}return;}

      if (name === 'connect') { persistDraft(); if (typeof options.openEditor === 'function') options.openEditor('ai'); return; }
      if (name === 'open-page') { if (typeof options.openPage === 'function') options.openPage(control.dataset.campaignPage); return; }
      if (busy) return;
      if (name === 'refresh') { aiChecked = false; try { await refresh(); } catch (_) {} return; }
      if (name === 'retry') {
        if (!pending || pending.state !== 'uncertain' || pending.campaignId) return;
        var token = epoch; busy = true; render();
        try { await refresh(); if (!disposed && token === epoch && pending && pending.state === 'uncertain' && !pending.campaignId) await dispatch(); }
        catch (_) { if (!disposed && token === epoch) notify('Стан не перевірено. Запит повторно не надсилався.', true); }
        finally { if (!disposed && token === epoch) { busy = false; render(); schedule(); } }
        return;
      }
      if (name === 'pause' || name === 'resume') {
        var campaign = campaigns.find(function (c) { return c.id === control.dataset.campaignId; });
        if (!campaign || name === 'pause' && ['queued', 'running'].indexOf(campaign.state) < 0 || name === 'resume' && campaign.state !== 'paused') return;
        var actionToken = epoch; busy = true; render();
        try { await options.request('/campaigns/' + encodeURIComponent(campaign.id) + '/' + name, 'POST', {}); if (!disposed && actionToken === epoch) await refresh(); }
        catch (error) { if (!disposed && actionToken === epoch) notify(errorText(error), true); }
        finally { if (!disposed && actionToken === epoch) { busy = false; render(); schedule(); } }
        return;
      }
      if (locked()) return;
      if (name === 'prepare') { await prepare(); return; }
      if (name === 'select-all') fields.forEach(function (f) { selected.add(f.path); });
      else if (name === 'select-none') selected.clear();
      else if (name === 'remove-link') added = added.filter(function (entry) { return entry.id !== control.dataset.campaignId; });
      else if (name === 'add-link') {
        try {
          var entry = { id: 'campaign-link-' + uuid(), fieldPath: draft.linkField, url: draft.linkUrl, anchor: draft.linkAnchor, count: Number(draft.linkCount) };
          if (!validUrl(entry.url)) throw new Error('Вкажіть точну повну URL-адресу без пробілів.');
          if (!fields.some(function (f) { return f.path === entry.fieldPath && insertionField(f.path); })) throw new Error('Виберіть доступне текстове поле.');
          if (draft.mode === 'empty' && fields.some(function (f) { return f.path === entry.fieldPath && text(f.currentValue).trim(); })) throw new Error('Це ручний текст. Спочатку виберіть режим «Змінити вибрані тексти» й позначте це поле.');
          engine.makePlan(config, { mode: 'selected', paths: [entry.fieldPath], linkInsertions: added.concat(entry) });
          added.push(entry); selected.add(entry.fieldPath); draft.linkUrl = ''; draft.linkAnchor = ''; notify('Точне посилання додано до плану.', false);
        } catch (error) { notify(error.message || 'Перевірте адресу, анкор і кількість.', true); return; }
      }
      persistDraft(); render();
    }
    function input(event) {
      if (disposed || locked()) return;
      var control = event.target;
      if (control.dataset.campaignSite) { if (ready(sites.find(function (s) { return s.id === control.dataset.campaignSite; }))) { if (control.checked) selectedSites.add(control.dataset.campaignSite); else selectedSites.delete(control.dataset.campaignSite); } persistDraft(); renderLaunch(); return; }
      if (control.dataset.campaignPath) { if (control.checked) selected.add(control.dataset.campaignPath); else selected.delete(control.dataset.campaignPath); persistDraft(); renderLaunch(); return; }
      if (control.name === 'varyDesign') { draft.varyDesign = control.checked; persistDraft(); return; }
      if (control.name && control.name.indexOf('fact:') === 0 && config) {
        var path = control.name.slice(5), match = /^(cards|moreCards|navLinks)\.(\d+)\.(name|image|bonus|rating|url|logoUrl)$/.exec(path);
        if (match && list(config[match[1]])[Number(match[2])]) config[match[1]][Number(match[2])][match[3]] = control.value;
        else if (['brand', 'brandImage', 'brandUrl', 'footerBrandUrl'].indexOf(path) >= 0) config[path] = control.value;
        rebuildFields(false); persistDraft(); return;
      }
      if (!Object.prototype.hasOwnProperty.call(draft, control.name)) return;
      if (config && ['source', 'links', 'cardCount'].indexOf(control.name) >= 0 && draft[control.name] !== control.value) needsPrepare = true;
      draft[control.name] = control.value; persistDraft();
      if (event.type === 'change' && ['source', 'mode', 'status'].indexOf(control.name) >= 0) render();
      else if (['topics', 'links', 'cardCount'].indexOf(control.name) >= 0) renderLaunch();
    }
    function visibility() { if (disposed) return; if (visible()) schedule(); else stop(); }
    rebuildFields(false);
    root.addEventListener('submit', submit); root.addEventListener('click', action); root.addEventListener('input', input); root.addEventListener('change', input); doc.addEventListener('visibilitychange', visibility);
    render();
    return { refresh: refresh, destroy: function () { if (disposed) return; persistDraft(); disposed = true; epoch++; stop(); root.removeEventListener('submit', submit); root.removeEventListener('click', action); root.removeEventListener('input', input); root.removeEventListener('change', input); doc.removeEventListener('visibilitychange', visibility); } };
  }
  return Object.freeze({ create: create });
}));
