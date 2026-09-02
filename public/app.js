const statusMeta = {
  assigned: { label: 'Задано', short: 'Задано' },
  known: { label: 'Известно, что задано', short: 'Будет позже' },
  unknown: { label: 'О ДЗ неизвестно', short: 'Нет информации' },
  none: { label: 'Нет ДЗ', short: 'Нет ДЗ' }
};

const coordinateColors = ['#7c5cff', '#3c8dff', '#f59e45', '#45ad7d', '#df665d', '#9b5de5'];
const fallbackState = {
  meta: { className: '9 В', updatedAt: new Date().toISOString(), term: '' },
  homework: [], schedule: [], scheduleChanges: [], bellSchedule: [], supplies: { 'current-student': [] },
  coordinates: { subjects: [], teachers: [] }, proposals: []
};

let appState = fallbackState;
let supplyState = [];
let currentUser = null;
let activeHomeworkFilter = 'all';
let activeMap = 'subjects';
let currentRole = 'student';
let weekOffset = 0;
let dragState = null;
let deferredInstall;
const supplySaveTimers = new Map();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setSyncState(mode, label) {
  const element = $('#sync-state');
  element.className = `sync-state ${mode}`;
  $('.sync-text', element).textContent = label;
}

function formatUpdated(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'время неизвестно';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function subjectsFromSchedule() {
  return [...new Set(appState.schedule.flatMap(day => day.lessons))];
}

function homeworkItems() {
  return subjectsFromSchedule().map((subject, index) => appState.homework.find(item => item.subject === subject) || {
    id: `subject-${index}`,
    subject,
    teacher: '',
    dueLabel: '',
    status: 'unknown',
    task: 'Информация о домашнем задании пока не добавлена',
    icon: subject.slice(0, 1).toUpperCase(),
    accent: ['violet', 'blue', 'orange', 'green'][index % 4]
  });
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultSchoolDate() {
  const date = new Date();
  if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return dateKey(date);
}

function mondayFor(offset = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  const fromMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - fromMonday + offset * 7);
  return date;
}

function scheduleDate(index, offset = weekOffset) {
  const date = mondayFor(offset);
  date.setDate(date.getDate() + index);
  return date;
}

function bellFor(day, lessonIndex) {
  if (day === 'Сб') return null;
  return (appState.bellSchedule || []).find(item => Number(item.lesson) === lessonIndex + 1) || null;
}

function renderMeta() {
  $('#class-name').textContent = appState.meta.className || 'Класс';
  $('#class-term').textContent = appState.meta.term || `${appState.schedule.length} учебных дней`;
  const now = new Date();
  $('#today-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  $('#welcome-title').innerHTML = `${greetingFor(now)}, ${escapeHtml(currentUser?.displayName || 'ученик')}! <span>👋</span>`;
}

function greetingFor(date) {
  const hour = date.getHours();
  if (hour < 6) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

async function loadState({ quiet = false } = {}) {
  try {
    const [fresh, supplies] = await Promise.all([request('/api/state'), request('/api/supplies')]);
    appState = fresh;
    supplyState = supplies.items || [];
    localStorage.setItem('alegieri-state', JSON.stringify(fresh));
    localStorage.setItem(`alegieri-supplies-${currentUser.id}`, JSON.stringify(supplyState));
    setSyncState('online', `Обновлено ${formatUpdated(fresh.meta.updatedAt)}`);
  } catch (error) {
    if (error.status === 401) { showAuth(); return; }
    const cached = localStorage.getItem('alegieri-state');
    appState = cached ? JSON.parse(cached) : fallbackState;
    const cachedSupplies = localStorage.getItem(`alegieri-supplies-${currentUser?.id}`);
    supplyState = cachedSupplies ? JSON.parse(cachedSupplies) : [];
    setSyncState('offline', cached ? `Офлайн · копия от ${formatUpdated(appState.meta.updatedAt)}` : 'Сервер недоступен');
    if (!quiet && !cached) showToast('Сервер недоступен, сохранённых данных пока нет');
  }
  renderAll();
}

function homeworkTemplate(item) {
  const status = statusMeta[item.status] || statusMeta.unknown;
  return `<article class="homework-item accent-${escapeHtml(item.accent || 'violet')}" data-status="${escapeHtml(item.status)}">
    <div class="subject-icon">${escapeHtml(item.icon)}</div>
    <div class="subject-name"><b>${escapeHtml(item.subject)}</b><small>${escapeHtml(item.teacher)}</small></div>
    <div class="task-text">${escapeHtml(item.task)}<small>${escapeHtml(item.dueLabel)}</small></div>
    <span class="status-chip">${status.label}</span>
  </article>`;
}

function renderHomework() {
  const allHomework = homeworkItems();
  const assigned = allHomework.filter(item => item.status === 'assigned').length;
  $('#homework-count').textContent = assigned;
  $('#summary-homework').textContent = assigned;
  const preview = allHomework.filter(item => item.status !== 'none').slice(0, 3);
  $('#homework-preview').innerHTML = preview.length ? preview.map(homeworkTemplate).join('') : '<div class="proposal-empty">Домашние задания ещё не добавлены</div>';

  let list = allHomework;
  if (activeHomeworkFilter === 'assigned') list = list.filter(item => item.status === 'assigned');
  if (activeHomeworkFilter === 'attention') list = list.filter(item => ['known', 'unknown'].includes(item.status));
  $('#homework-full').innerHTML = list.length ? list.map(homeworkTemplate).join('') : '<div class="panel proposal-empty">По этому фильтру ничего нет</div>';
  $('#updated-label').textContent = `Последнее обновление: ${formatUpdated(appState.meta.updatedAt)}`;
}

function changeFor(day, lesson, date) {
  const key = date ? dateKey(date) : '';
  return appState.scheduleChanges.find(change => change.day === day && Number(change.lesson) === lesson && (!change.date || change.date === key));
}

function renderSchedule() {
  const dayKeys = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const now = new Date();
  const todayKey = dayKeys[now.getDay()];
  const today = appState.schedule.find(day => day.day === todayKey);
  const monday = mondayFor();
  const saturday = scheduleDate(5);
  const selectedDates = appState.schedule.map((_, index) => scheduleDate(index));
  const selectedDateKeys = selectedDates.map(dateKey);
  const visibleChanges = appState.scheduleChanges.filter(change => !change.date || selectedDateKeys.includes(change.date));

  const rangeStart = monday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const rangeEnd = saturday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: monday.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  $('#week-label').textContent = `${rangeStart} — ${rangeEnd}`;
  $('#summary-lessons').textContent = today?.lessons.length || 0;
  $('#next-lesson').textContent = today?.lessons[0] ? `первый — ${today.lessons[0]}` : 'уроков сегодня нет';
  $('#summary-changes').textContent = visibleChanges.length;
  $('#schedule-alert').hidden = visibleChanges.length === 0;
  $('#notification-button').hidden = visibleChanges.length === 0;
  $('#changes-summary-card').hidden = visibleChanges.length === 0;

  $('#today-lessons').innerHTML = (today?.lessons || []).slice(0, 5).map((lesson, index) => {
    const change = changeFor(today.day, index + 1, now);
    const displayed = change?.type === 'replacement' ? change.to : lesson;
    const bell = bellFor(today.day, index);
    return `<div class="lesson-row"><span class="lesson-number">${index + 1}</span><div><b>${escapeHtml(displayed)}</b>${change ? `<small>${change.type === 'cancelled' ? 'Отменён' : 'Замена'}</small>` : ''}</div><span class="lesson-time">${bell ? `${bell.start}–${bell.end}` : 'время уточняется'}</span></div>`;
  }).join('');

  $('#schedule-board').innerHTML = appState.schedule.map((day, dayIndex) => {
    const calendarDate = selectedDates[dayIndex];
    const isToday = dateKey(calendarDate) === dateKey(now);
    return `<section class="day-column ${isToday ? 'today' : ''}" data-date="${dateKey(calendarDate)}">
    <div class="day-header"><div><b>${escapeHtml(day.day)}</b><small>${calendarDate.toLocaleDateString('ru-RU', { month: 'short' })}</small></div><span>${calendarDate.getDate()}</span></div>
    ${day.lessons.map((lesson, index) => {
      const change = changeFor(day.day, index + 1, calendarDate);
      const isCancelled = change?.type === 'cancelled';
      const displayLesson = change?.type === 'replacement' ? change.to : lesson;
      const className = isCancelled ? 'cancelled' : change ? 'changed' : '';
      const bell = bellFor(day.day, index);
      const timeLabel = bell ? `${bell.start}–${bell.end}` : 'время уточняется';
      const detail = change
        ? change.note || change.teacher || lesson
        : bell?.breakAfter ? `перемена после — ${bell.breakAfter} мин` : bell ? 'последний урок' : 'звонки субботы пока не указаны';
      return `<div class="schedule-lesson ${className}">
        ${change ? `<span class="change-badge">${isCancelled ? 'отмена' : 'замена'}</span>` : ''}
        <span class="lesson-index">${index + 1} урок · ${timeLabel}</span>
        <b>${escapeHtml(displayLesson)}</b>
        <small>${escapeHtml(detail)}</small>
      </div>`;
    }).join('')}
  </section>`;
  }).join('');
}

function supplyItems() {
  return supplyState;
}

function renderSupplies() {
  const items = supplyItems();
  const recommendedItems = items.filter(item => Number.isFinite(item.recommended) && item.recommended > 0);
  const recommended = recommendedItems.reduce((sum, item) => sum + item.recommended, 0);
  const available = recommendedItems.reduce((sum, item) => sum + Math.min(item.current, item.recommended), 0);
  const percent = recommended ? Math.round(available / recommended * 100) : 0;
  $('#supply-percent').textContent = `${percent}%`;
  $('#supply-summary-text').textContent = items.length === 0 ? 'Принадлежности ещё не добавлены.' : recommended === 0 ? 'Укажите личное количество. Рекомендации пока не настроены.' : percent === 100 ? 'Рюкзак полностью готов!' : `Не хватает ${recommended - available} предметов до рекомендации.`;
  $('#progress-ring').style.setProperty('--progress', `${percent}%`);
  $('span', $('#progress-ring')).textContent = `${percent}%`;
  $('#supplies-grid').innerHTML = items.length ? items.map(item => {
    const hasRecommendation = Number.isFinite(item.recommended) && item.recommended > 0;
    const enough = hasRecommendation && item.current >= item.recommended;
    const recommendation = hasRecommendation ? `Рекомендуется: ${item.recommended} ${escapeHtml(item.unit)}` : 'Рекомендация пока не задана';
    const stateLabel = hasRecommendation ? (enough ? 'Готово' : `Нужно ещё ${item.recommended - item.current}`) : `Сейчас: ${item.current}`;
    const necessity = { required: 'Обязательно', recommended: 'Желательно', optional: 'Необязательно', not_set: 'Уровень не задан' }[item.necessity] || 'Уровень не задан';
    return `<article class="panel supply-card" data-supply-id="${escapeHtml(item.id)}"><div class="supply-icon">${escapeHtml(item.icon)}</div><div><h3>${escapeHtml(item.name)}</h3><p>${recommendation} · ${necessity}</p><div><span class="counter"><button data-delta="-1" aria-label="Уменьшить">−</button><span>${item.current}</span><button data-delta="1" aria-label="Увеличить">＋</button></span><span class="${enough ? 'supply-ok' : 'supply-low'}">${stateLabel}</span></div></div></article>`;
  }).join('') : '<div class="panel proposal-empty">Список пока пуст. Принадлежности будут добавлены после уточнения данных.</div>';
}

function mapLabels() {
  return activeMap === 'subjects'
    ? { title: 'Карта предметов', description: 'Важность и субъективная сложность', top: 'Сложнее +20', bottom: 'Легче −20', left: 'Менее важно −20', right: 'Важнее +20', x: 'Важность', y: 'Сложность' }
    : { title: 'Карта учителей', description: 'Сила преподавания и характер', top: 'Мягче +20', bottom: 'Строже −20', left: 'Слабее −20', right: 'Сильнее +20', x: 'Как учит', y: 'Характер' };
}

function renderCoordinates() {
  const labels = mapLabels();
  $('#map-title').textContent = labels.title;
  $('#map-description').textContent = labels.description;
  const points = appState.coordinates[activeMap] || [];
  const map = $('#coordinate-map');
  map.innerHTML = `<span class="axis-label axis-top">${labels.top}</span><span class="axis-label axis-bottom">${labels.bottom}</span><span class="axis-label axis-left">${labels.left}</span><span class="axis-label axis-right">${labels.right}</span>${points.map(point => {
    const left = 5 + ((Number(point.x) + 20) / 40) * 90;
    const bottom = 5 + ((Number(point.y) + 20) / 40) * 90;
    return `<button class="map-point ${currentRole === 'admin' ? 'draggable' : ''}" style="left:${left}%;bottom:${bottom}%;--point:${escapeHtml(point.color)}" data-point="${escapeHtml(point.id)}" data-name="${escapeHtml(point.name)}" aria-label="${escapeHtml(point.name)}"></button>`;
  }).join('')}`;
  $('#coordinate-detail').innerHTML = points.length
    ? '<div class="empty-detail"><span>⌖</span><h3>Выберите точку</h3><p>Здесь появятся координаты и подробное описание.</p></div>'
    : '<div class="empty-detail"><span>⌖</span><h3>Координаты ещё не заполнены</h3><p>Точки появятся после добавления подтверждённых значений.</p></div>';
  renderCoordinateEditor();
}

function renderCoordinateEditor() {
  const editor = $('#coordinate-editor');
  editor.hidden = currentRole !== 'admin';
  if (editor.hidden) return;
  const select = $('#coordinate-object');
  const input = $('#coordinate-new-name');
  if (activeMap === 'subjects') {
    const placed = new Set((appState.coordinates.subjects || []).map(point => point.name));
    const available = subjectsFromSchedule().filter(subject => !placed.has(subject));
    select.hidden = false;
    input.hidden = true;
    select.innerHTML = available.map(subject => `<option>${escapeHtml(subject)}</option>`).join('');
    $('#add-coordinate').disabled = available.length === 0;
  } else {
    select.hidden = true;
    input.hidden = false;
    $('#add-coordinate').disabled = input.value.trim().length === 0;
  }
}

function showCoordinateDetail(pointId) {
  const point = (appState.coordinates[activeMap] || []).find(item => item.id === pointId);
  if (!point) return;
  const labels = mapLabels();
  $$('.map-point').forEach(button => button.classList.toggle('active', button.dataset.point === pointId));
  $('#coordinate-detail').innerHTML = `<div class="detail-color" style="--detail:${escapeHtml(point.color)}">${escapeHtml(point.name.slice(0, 1))}</div><h2>${escapeHtml(point.name)}</h2><div class="coordinate-values"><div class="coordinate-value"><small>${labels.x}</small><strong>${point.x > 0 ? '+' : ''}${point.x}</strong></div><div class="coordinate-value"><small>${labels.y}</small><strong>${point.y > 0 ? '+' : ''}${point.y}</strong></div></div><p>${escapeHtml(point.description || 'Описание пока не добавлено.')}</p>${currentRole === 'admin' ? '<p class="drag-hint">Зажмите точку на карте и перетащите её в нужное место.</p>' : ''}`;
}

function renderAdmin() {
  const select = $('#admin-hw-id');
  const selected = select.value;
  const subjects = subjectsFromSchedule();
  select.innerHTML = subjects.map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join('');
  if (selected && subjects.includes(selected)) select.value = selected;
  syncAdminHomeworkFields();
  $('#proposal-list').innerHTML = appState.proposals.length ? appState.proposals.map(item => `<article class="proposal-item"><b>${escapeHtml(item.subject)}</b><p>${escapeHtml(item.text)}</p><small>${escapeHtml(item.author)} · ожидает модерации</small></article>`).join('') : '<div class="proposal-empty">Новых предложений пока нет</div>';
  renderAdminSupplies();
}

function renderAdminSupplies() {
  const container = $('#admin-supplies');
  if (!container) return;
  container.innerHTML = supplyState.map(item => `<article class="admin-supply-row" data-admin-supply="${item.id}">
    <div><b>${escapeHtml(item.name)}</b><small>${item.subject ? 'Отдельная тетрадь' : 'Общая принадлежность'}</small></div>
    <label>Количество<input class="admin-recommended" type="number" min="0" max="99" value="${item.recommended ?? ''}" placeholder="—"></label>
    <label>Необходимость<select class="admin-necessity"><option value="not_set" ${item.necessity === 'not_set' ? 'selected' : ''}>Не задана</option><option value="optional" ${item.necessity === 'optional' ? 'selected' : ''}>Необязательно</option><option value="recommended" ${item.necessity === 'recommended' ? 'selected' : ''}>Желательно</option><option value="required" ${item.necessity === 'required' ? 'selected' : ''}>Обязательно</option></select></label>
    <button class="secondary-button save-recommendation">Сохранить</button>
  </article>`).join('');
}

function syncAdminHomeworkFields() {
  const item = appState.homework.find(entry => entry.subject === $('#admin-hw-id').value);
  $('#admin-hw-status').value = item?.status || 'unknown';
  $('#admin-hw-task').value = item?.task || '';
}

function renderAll() {
  renderMeta();
  renderHomework();
  renderSchedule();
  renderSupplies();
  renderCoordinates();
  renderAdmin();
  $('#proposal-subject').innerHTML = subjectsFromSchedule().map(subject => `<option>${escapeHtml(subject)}</option>`).join('');
}

function navigate(route) {
  $$('.page').forEach(page => page.classList.toggle('active', page.dataset.page === route));
  $$('[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === route));
  history.replaceState(null, '', `#${route}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyUser(user) {
  currentUser = user;
  currentRole = user.role;
  const roleLabel = user.role === 'admin' ? 'Администратор' : 'Ученик';
  $('#profile-name').textContent = user.displayName;
  $('#profile-avatar').textContent = user.displayName.slice(0, 1).toUpperCase();
  $('#role-label').textContent = roleLabel;
  $('#profile-menu-name').textContent = user.displayName;
  $('#profile-menu-role').textContent = roleLabel;
  $('.admin-link').style.display = user.role === 'admin' ? '' : 'none';
  if (user.role !== 'admin' && location.hash === '#admin') navigate('today');
}

function showAuth(tab = 'login') {
  currentUser = null;
  currentRole = 'student';
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  switchAuthTab(tab);
}

async function showApp(user) {
  applyUser(user);
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  await loadState();
}

function switchAuthTab(tab) {
  const registration = tab === 'register';
  $('#login-form').hidden = registration;
  $('#register-form').hidden = !registration;
  $('#auth-title').textContent = registration ? 'Создание аккаунта' : 'Вход в аккаунт';
  $('#auth-subtitle').textContent = registration ? 'Зарегистрируйтесь, чтобы сохранить личные данные.' : 'Введите логин и пароль, чтобы продолжить.';
  $('#auth-error').textContent = '';
  $$('.auth-tabs button').forEach(button => button.classList.toggle('active', button.dataset.authTab === tab));
}

function scheduleSupplySave(item) {
  clearTimeout(supplySaveTimers.get(item.id));
  localStorage.setItem(`alegieri-supplies-${currentUser.id}`, JSON.stringify(supplyState));
  const timer = setTimeout(async () => {
    try {
      await request(`/api/supplies/${item.id}`, { method: 'PUT', body: JSON.stringify({ current: item.current }) });
      setSyncState('online', 'Личные данные сохранены');
    } catch { setSyncState('offline', 'Сохранено на устройстве'); }
  }, 500);
  supplySaveTimers.set(item.id, timer);
}

function bindEvents() {
  document.addEventListener('click', event => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) { event.preventDefault(); navigate(routeButton.dataset.route); }
  });

  $('#homework-filter').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    activeHomeworkFilter = button.dataset.filter;
    $$('#homework-filter button').forEach(item => item.classList.toggle('active', item === button));
    renderHomework();
  });

  $('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('alegieri-sidebar-collapsed', String(collapsed));
    $('#sidebar-toggle').textContent = collapsed ? '☷' : '☰';
  });
  $('#previous-week').addEventListener('click', () => { weekOffset -= 1; renderSchedule(); });
  $('#next-week').addEventListener('click', () => { weekOffset += 1; renderSchedule(); });
  $('#current-week').addEventListener('click', () => { weekOffset = 0; renderSchedule(); });

  $('.coordinate-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-map]');
    if (!button) return;
    activeMap = button.dataset.map;
    $$('.coordinate-tabs button').forEach(item => item.classList.toggle('active', item === button));
    renderCoordinates();
  });
  $('#coordinate-map').addEventListener('click', event => {
    const point = event.target.closest('[data-point]');
    if (point) showCoordinateDetail(point.dataset.point);
  });
  $('#coordinate-new-name').addEventListener('input', renderCoordinateEditor);
  $('#add-coordinate').addEventListener('click', async () => {
    const name = activeMap === 'subjects' ? $('#coordinate-object').value : $('#coordinate-new-name').value.trim();
    if (!name) return;
    try {
      await request('/api/admin/coordinate', { method: 'POST', body: JSON.stringify({ map: activeMap, name, x: 0, y: 0, color: coordinateColors[(appState.coordinates[activeMap] || []).length % coordinateColors.length] }) });
      $('#coordinate-new-name').value = '';
      showToast('Точка добавлена — теперь её можно перетащить');
      await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });

  const coordinateMap = $('#coordinate-map');
  coordinateMap.addEventListener('pointerdown', event => {
    const pointElement = event.target.closest('[data-point]');
    if (!pointElement || currentRole !== 'admin') return;
    event.preventDefault();
    pointElement.setPointerCapture(event.pointerId);
    pointElement.classList.add('dragging');
    dragState = { id: pointElement.dataset.point, element: pointElement, pointerId: event.pointerId };
  });
  coordinateMap.addEventListener('pointermove', event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const rect = coordinateMap.getBoundingClientRect();
    const horizontal = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const vertical = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const x = Math.round((Math.max(0, Math.min(1, (horizontal - .05) / .9)) * 40) - 20);
    const y = Math.round((Math.max(0, Math.min(1, ((1 - vertical) - .05) / .9)) * 40) - 20);
    const point = (appState.coordinates[activeMap] || []).find(item => item.id === dragState.id);
    if (!point) return;
    point.x = x; point.y = y;
    dragState.element.style.left = `${5 + ((x + 20) / 40) * 90}%`;
    dragState.element.style.bottom = `${5 + ((y + 20) / 40) * 90}%`;
    showCoordinateDetail(point.id);
  });
  coordinateMap.addEventListener('pointerup', async event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const finished = dragState;
    dragState = null;
    finished.element.classList.remove('dragging');
    const point = (appState.coordinates[activeMap] || []).find(item => item.id === finished.id);
    if (!point) return;
    try {
      await request('/api/admin/coordinate', { method: 'POST', body: JSON.stringify({ map: activeMap, ...point }) });
      showToast(`Координаты сохранены: ${point.x}, ${point.y}`);
    } catch (error) { showToast(error.message); }
  });

  $('#supplies-grid').addEventListener('click', event => {
    const button = event.target.closest('[data-delta]');
    const card = event.target.closest('[data-supply-id]');
    if (!button || !card) return;
    const item = supplyItems().find(entry => Number(entry.id) === Number(card.dataset.supplyId));
    item.current = Math.max(0, Math.min(99, item.current + Number(button.dataset.delta)));
    renderSupplies(); scheduleSupplySave(item);
  });
  $('#reset-supplies').addEventListener('click', () => loadState());

  const dialog = $('#proposal-dialog');
  $('#open-proposal').addEventListener('click', () => dialog.showModal());
  $('#proposal-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/homework/proposals', { method: 'POST', body: JSON.stringify({ subject: $('#proposal-subject').value, text: $('#proposal-text').value }) });
      dialog.close(); $('#proposal-form').reset(); showToast('Предложение отправлено на модерацию'); await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });

  $('#profile-button').addEventListener('click', event => { event.stopPropagation(); $('#profile-menu').hidden = !$('#profile-menu').hidden; });
  document.addEventListener('click', () => { $('#profile-menu').hidden = true; });
  $('#logout-button').addEventListener('click', async () => {
    try { await request('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('alegieri-state');
    if (currentUser) localStorage.removeItem(`alegieri-supplies-${currentUser.id}`);
    $('#profile-menu').hidden = true;
    showAuth();
  });

  $('#admin-hw-id').addEventListener('change', syncAdminHomeworkFields);
  $('#admin-homework-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/admin/homework', { method: 'POST', body: JSON.stringify({ subject: $('#admin-hw-id').value, status: $('#admin-hw-status').value, task: $('#admin-hw-task').value }) });
      showToast('Домашнее задание обновлено'); await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });
  $('#admin-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/admin/schedule-change', { method: 'POST', body: JSON.stringify({ date: $('#change-date').value, lesson: $('#change-lesson').value, type: $('#change-type').value, to: $('#change-to').value, note: $('#change-note').value }) });
      showToast('Изменение добавлено'); event.target.reset(); $('#change-date').value = defaultSchoolDate(); await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });
  $('#admin-supplies').addEventListener('click', async event => {
    const button = event.target.closest('.save-recommendation');
    const row = event.target.closest('[data-admin-supply]');
    if (!button || !row) return;
    const recommendedValue = $('.admin-recommended', row).value;
    try {
      await request('/api/admin/supply-recommendation', { method: 'POST', body: JSON.stringify({ id: Number(row.dataset.adminSupply), recommended: recommendedValue === '' ? null : Number(recommendedValue), necessity: $('.admin-necessity', row).value }) });
      showToast('Рекомендация сохранена');
      await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });

  window.addEventListener('online', () => loadState({ quiet: true }));
  window.addEventListener('offline', () => setSyncState('offline', 'Нет соединения · данные сохранены'));
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; $('#install-button').hidden = false; });
  $('#install-button').addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#install-button').hidden = true; });
}

function bindAuthEvents() {
  $$('.auth-tabs button').forEach(button => button.addEventListener('click', () => switchAuthTab(button.dataset.authTab)));
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#auth-error').textContent = '';
    try {
      const user = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }) });
      $('#login-password').value = '';
      await showApp(user);
    } catch (error) { $('#auth-error').textContent = error.message; }
  });
  $('#register-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#auth-error').textContent = '';
    try {
      const user = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ displayName: $('#register-name').value, username: $('#register-username').value, password: $('#register-password').value }) });
      $('#register-form').reset();
      await showApp(user);
    } catch (error) { $('#auth-error').textContent = error.message; }
  });
}

async function init() {
  const sidebarCollapsed = localStorage.getItem('alegieri-sidebar-collapsed') === 'true';
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  $('#sidebar-toggle').textContent = sidebarCollapsed ? '☷' : '☰';
  $('#change-date').value = defaultSchoolDate();
  bindAuthEvents();
  bindEvents();
  const initialRoute = location.hash.slice(1);
  navigate(['today', 'homework', 'schedule', 'supplies', 'coordinates', 'admin'].includes(initialRoute) ? initialRoute : 'today');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=1', { updateViaCache: 'none' }).catch(() => {});
  try {
    const user = await request('/api/me');
    await showApp(user);
  } catch { showAuth(); }
  setInterval(() => { if (currentUser) loadState({ quiet: true }); }, 60_000);
}

init();
