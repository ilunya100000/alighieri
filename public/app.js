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
  holidays: [],
  coordinates: { subjects: [], teachers: [] }, proposals: []
};

let appState = fallbackState;
let supplyState = [];
let currentUser = null;
let activeHomeworkPeriod = 'current';
let activeMap = 'subjects';
let currentRole = 'student';
let weekOffset = 0;
let dragState = null;
let deferredInstall;
let adminHomeworkDirty = false;
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

function displaySubjectName(subject = '') {
  return subject === 'Английский язык (Разговорный практикум)' ? 'Английский язык (Р)' : subject;
}

function subjectIcon(subject = '') {
  const value = subject.toLocaleLowerCase('ru-RU');
  let paths = '<path d="M5 5.5h14v13H5z"/><path d="M9 5.5v13"/>';
  if (/алгеб/.test(value)) paths = '<path d="M4 18c3-10 5-10 8 0 2-7 4-7 8-2"/><path d="M4 7h5M6.5 4.5v5"/>';
  else if (/геометр/.test(value)) paths = '<path d="m4 19 8-15 8 15z"/><path d="M8 15h8M12 4v15"/>';
  else if (/физик/.test(value)) paths = '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="9" ry="3.8"/><ellipse cx="12" cy="12" rx="3.8" ry="9" transform="rotate(35 12 12)"/>';
  else if (/русск/.test(value)) paths = '<path d="m5 19 2-5L17 4l3 3-10 10z"/><path d="m14 7 3 3M5 19l5-2"/>';
  else if (/литератур/.test(value)) paths = '<path d="M4 5h6a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H4z"/><path d="M20 5h-4a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h4z"/>';
  else if (/англий.*\(р\)/.test(value)) paths = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/>';
  else if (/итальян.*\(р\)/.test(value)) paths = '<path d="M5 5h14v11H9l-4 4z"/><path d="M9 9h6M9 12h4"/>';
  else if (/англий/.test(value)) paths = '<path d="M5 4.5h10a3 3 0 0 1 3 3v12H8a3 3 0 0 0-3 0z"/><path d="m9 14 2.5-6 2.5 6m-4-2h3"/>';
  else if (/итальян/.test(value)) paths = '<path d="M5 4v16M6 5h13l-3 4 3 4H6"/><path d="M10 5v8M14 5v8"/>';
  else if (/информат/.test(value)) paths = '<rect x="3.5" y="5" width="17" height="12" rx="2"/><path d="m8 10-2 2 2 2m8-4 2 2-2 2m-5 3v3m-3 0h6"/>';
  else if (/хими/.test(value)) paths = '<path d="M9 3v6l-4 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-4-8V3M8 14h8M8 3h8"/>';
  else if (/биолог/.test(value)) paths = '<path d="M19 4C9 4 5 9 5 15c4 1 11-1 14-11Z"/><path d="M5 20c2-6 6-9 12-13"/>';
  else if (/географ/.test(value)) paths = '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"/>';
  else if (/истори/.test(value)) paths = '<path d="M4 9h16M6 9v8m4-8v8m4-8v8m4-8v8M3 20h18M12 3 3 7h18z"/>';
  else if (/обществ/.test(value)) paths = '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 20c0-4 2-6 5-6s5 2 5 6M11 20c0-4 2-6 5-6s5 2 5 6"/>';
  else if (/физкультур/.test(value)) paths = '<circle cx="12" cy="5" r="2"/><path d="m8 21 2-6-3-3m3 3 3-5 4 3m-7-5 3 2 3-2"/>';
  else if (/труд/.test(value)) paths = '<path d="m14 6 4-3 3 3-3 4M5 20l8-8M4 14l6 6M3 17l4 4"/>';
  else if (/обзр/.test(value)) paths = '<path d="M12 3 4.5 6v5c0 5 3.2 8.5 7.5 10 4.3-1.5 7.5-5 7.5-10V6z"/><path d="M12 8v7M8.5 11.5h7"/>';
  else if (/вис/.test(value)) paths = '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/>';
  else if (/вд |разговоры о важном/.test(value)) paths = '<path d="M5 5h14v11H9l-4 4z"/><path d="m9 10 2 2 4-4"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function schoolDay(date) {
  const keys = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  return appState.schedule.find(day => day.day === keys[date.getDay()]);
}

function dayOffInfo(date) {
  const key = dateKey(date);
  const manual = (appState.scheduleChanges || []).find(change => change.type === 'day_off' && change.date === key);
  if (manual) return { name: manual.note || 'Выходной день', manual: true };
  const holiday = (appState.holidays || []).find(item => key >= item.start && (!item.end || key <= item.end));
  return holiday ? { name: holiday.name, manual: false } : null;
}

function instructionDay(date) {
  const scheduledDay = schoolDay(date);
  return scheduledDay && !dayOffInfo(date) ? scheduledDay : null;
}

function nextSchoolDate(from = new Date(), includeToday = false) {
  const date = new Date(from);
  date.setHours(12, 0, 0, 0);
  if (!includeToday) date.setDate(date.getDate() + 1);
  for (let attempts = 0; attempts < 370; attempts += 1) {
    if (instructionDay(date)) return date;
    date.setDate(date.getDate() + 1);
  }
  return null;
}

function homeworkDates(period = activeHomeworkPeriod) {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  if (period === 'current') {
    const current = instructionDay(now) ? now : nextSchoolDate(now, true);
    return current ? [current] : [];
  }
  if (period === 'tomorrow') {
    const tomorrow = nextSchoolDate(now);
    return tomorrow ? [tomorrow] : [];
  }
  const dates = [];
  const cursor = new Date(now);
  for (let offset = 0; offset < 7; offset += 1) {
    if (instructionDay(cursor)) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function homeworkForLesson(date, lesson, subject) {
  const key = dateKey(date);
  return appState.homework.find(item => item.date === key && Number(item.lesson) === lesson)
    || appState.homework.find(item => item.date === key && item.subject === subject && !item.lesson);
}

function homeworkItems(period = activeHomeworkPeriod) {
  const result = [];
  for (const date of homeworkDates(period)) {
    const day = schoolDay(date);
    if (!day) continue;
    day.lessons.forEach((originalSubject, index) => {
      const lesson = index + 1;
      const change = changeFor(day.day, lesson, date);
      if (change?.type === 'cancelled') return;
      const subject = change?.type === 'replacement' && change.to ? change.to : originalSubject;
      const saved = homeworkForLesson(date, lesson, subject);
      result.push({
        id: saved?.id || `lesson-${dateKey(date)}-${lesson}`,
        subject,
        originalSubject,
        teacher: change?.teacher || saved?.teacher || '',
        date: dateKey(date),
        lesson,
        dueLabel: `${date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })} · ${lesson} урок`,
        status: saved?.status || 'unknown',
        task: saved?.task || 'Задание пока не указано',
        accent: saved?.accent || ['violet', 'blue', 'orange', 'green'][index % 4],
        replacement: change?.type === 'replacement'
      });
    });
  }
  return result;
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
    <div class="subject-icon">${subjectIcon(item.subject)}</div>
    <div class="subject-name"><b>${escapeHtml(displaySubjectName(item.subject))}</b><small>${item.replacement ? `Замена вместо ${escapeHtml(displaySubjectName(item.originalSubject))}` : escapeHtml(item.teacher)}</small></div>
    <div class="task-text">${escapeHtml(item.task)}<small>${escapeHtml(item.dueLabel)}</small></div>
    <span class="homework-state">${status.label}</span>
  </article>`;
}

function renderHomework() {
  const allHomework = homeworkItems();
  const assigned = allHomework.filter(item => item.status === 'assigned').length;
  $('#homework-count').textContent = assigned;
  $('#summary-homework').textContent = assigned;
  const preview = allHomework.filter(item => item.status !== 'none').slice(0, 3);
  $('#homework-preview').innerHTML = preview.length ? preview.map(homeworkTemplate).join('') : '<div class="proposal-empty">Домашние задания ещё не добавлены</div>';

  const groups = allHomework.reduce((result, item) => {
    (result[item.date] ||= []).push(item);
    return result;
  }, {});
  $('#homework-full').innerHTML = allHomework.length ? Object.entries(groups).map(([date, items]) => {
    const title = dateFromKey(date).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    return `<section class="homework-day"><h2>${escapeHtml(title)}</h2><div class="homework-list">${items.map(homeworkTemplate).join('')}</div></section>`;
  }).join('') : '<div class="panel proposal-empty">На выбранный период уроков нет</div>';
  $('#updated-label').textContent = `Последнее обновление: ${formatUpdated(appState.meta.updatedAt)}`;
}

function changeFor(day, lesson, date) {
  const key = date ? dateKey(date) : '';
  return appState.scheduleChanges.find(change => change.day === day && Number(change.lesson) === lesson && (!change.date || change.date === key));
}

function homeworkStatusFor(date, lesson, subject) {
  return homeworkForLesson(date, lesson, subject)?.status || 'unknown';
}

function renderSchedule() {
  const dayKeys = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const now = new Date();
  const todayKey = dayKeys[now.getDay()];
  const today = appState.schedule.find(day => day.day === todayKey);
  const todayOff = dayOffInfo(now);
  const monday = mondayFor();
  const saturday = scheduleDate(5);
  const selectedDates = appState.schedule.map((_, index) => scheduleDate(index));
  const selectedDateKeys = selectedDates.map(dateKey);
  const visibleChanges = appState.scheduleChanges.filter(change => !change.date || selectedDateKeys.includes(change.date));

  const rangeStart = monday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const rangeEnd = saturday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: monday.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  $('#week-label').textContent = `${rangeStart} — ${rangeEnd}`;
  $('#summary-lessons').textContent = todayOff ? 0 : today?.lessons.length || 0;
  $('#next-lesson').textContent = todayOff ? todayOff.name : today?.lessons[0] ? `первый — ${displaySubjectName(today.lessons[0])}` : 'уроков сегодня нет';
  $('#summary-changes').textContent = visibleChanges.length;
  $('#schedule-alert').hidden = visibleChanges.length === 0;
  $('#notification-button').hidden = visibleChanges.length === 0;
  $('#changes-summary-card').hidden = visibleChanges.length === 0;

  $('#today-lessons').innerHTML = todayOff ? `<div class="day-off-empty"><b>${escapeHtml(todayOff.name)}</b><small>Сегодня уроков нет</small></div>` : (today?.lessons || []).slice(0, 5).map((lesson, index) => {
    const change = changeFor(today.day, index + 1, now);
    const displayed = change?.type === 'replacement' ? change.to : lesson;
    const bell = bellFor(today.day, index);
    return `<div class="lesson-row"><span class="mini-subject-icon">${subjectIcon(displayed)}</span><div><b>${escapeHtml(displaySubjectName(displayed))}</b>${change ? `<small>${change.type === 'cancelled' ? 'Отменён' : 'Замена'}</small>` : ''}</div><span class="lesson-time">${bell ? `${bell.start}–${bell.end}` : 'время уточняется'}</span></div>`;
  }).join('');

  $('#schedule-board').innerHTML = appState.schedule.map((day, dayIndex) => {
    const calendarDate = selectedDates[dayIndex];
    const isToday = dateKey(calendarDate) === dateKey(now);
    const off = dayOffInfo(calendarDate);
    return `<section class="day-column ${isToday ? 'today' : ''}" data-date="${dateKey(calendarDate)}">
    <div class="day-header"><div><b>${escapeHtml(day.day)}</b><small>${calendarDate.toLocaleDateString('ru-RU', { month: 'short' })}</small></div><span>${calendarDate.getDate()}</span></div>
    ${off ? `<div class="full-day-off"><span>☀</span><b>${escapeHtml(off.name)}</b><small>Учебных занятий нет</small></div>` : day.lessons.map((lesson, index) => {
      const change = changeFor(day.day, index + 1, calendarDate);
      const isCancelled = change?.type === 'cancelled';
      const displayLesson = change?.type === 'replacement' ? change.to : lesson;
      const className = isCancelled ? 'cancelled' : change ? 'changed' : '';
      const homeworkStatus = isCancelled ? '' : homeworkStatusFor(calendarDate, index + 1, displayLesson);
      const bell = bellFor(day.day, index);
      const timeLabel = bell ? `${bell.start}–${bell.end}` : 'время уточняется';
      const detail = change
        ? change.note || change.teacher || lesson
        : bell?.breakAfter ? `перемена после — ${bell.breakAfter} мин` : bell ? 'последний урок' : 'звонки субботы пока не указаны';
      return `<div class="schedule-lesson ${className}">
        ${change ? `<span class="change-badge">${isCancelled ? 'отмена' : 'замена'}</span>` : ''}
        <span class="lesson-index">${index + 1} урок · ${timeLabel}</span>
        <div class="schedule-subject"><span class="mini-subject-icon">${subjectIcon(displayLesson)}</span><b>${escapeHtml(displaySubjectName(displayLesson))}</b></div>
        <small>${escapeHtml(detail)}</small>
        ${homeworkStatus ? `<span class="schedule-hw-status" data-status="${homeworkStatus}" title="${escapeHtml(statusMeta[homeworkStatus].label)}"><i></i>${escapeHtml(statusMeta[homeworkStatus].short)}</span>` : ''}
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
  select.innerHTML = subjects.map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(displaySubjectName(subject))}</option>`).join('');
  if (selected && subjects.includes(selected)) select.value = selected;
  if (!adminHomeworkDirty) syncAdminHomeworkLessons();
  $('#proposal-list').innerHTML = appState.proposals.length ? appState.proposals.map(item => `<article class="proposal-item"><b>${escapeHtml(item.subject)}</b><p>${escapeHtml(item.text)}</p><small>${escapeHtml(item.author)} · ожидает модерации</small></article>`).join('') : '<div class="proposal-empty">Новых предложений пока нет</div>';
  $('#day-off-list').innerHTML = (appState.scheduleChanges || []).filter(item => item.type === 'day_off').map(item => `<span>${escapeHtml(item.date)} · ${escapeHtml(item.note || 'Выходной')}</span>`).join('') || '<span>Дополнительных выходных нет</span>';
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
  const date = $('#admin-hw-date').value;
  const lesson = Number($('#admin-hw-lesson').value);
  const item = appState.homework.find(entry => entry.date === date && Number(entry.lesson) === lesson);
  $('#admin-hw-status').value = item?.status || 'unknown';
  $('#admin-hw-task').value = item?.task || '';
}

function dateFromKey(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function syncAdminHomeworkLessons() {
  const date = dateFromKey($('#admin-hw-date').value || defaultSchoolDate());
  const day = instructionDay(date);
  const lessonSelect = $('#admin-hw-lesson');
  const previous = Number(lessonSelect.value) || 1;
  lessonSelect.innerHTML = (day?.lessons || []).map((subject, index) => {
    const change = changeFor(day.day, index + 1, date);
    const effective = change?.type === 'replacement' && change.to ? change.to : subject;
    const suffix = change?.type === 'cancelled' ? ' — отменён' : change?.type === 'replacement' ? ' — замена' : '';
    return `<option value="${index + 1}" ${change?.type === 'cancelled' ? 'disabled' : ''}>${index + 1}. ${escapeHtml(displaySubjectName(effective))}${suffix}</option>`;
  }).join('');
  if (!day) lessonSelect.innerHTML = '<option value="">В этот день уроков нет</option>';
  if ([...lessonSelect.options].some(option => Number(option.value) === previous && !option.disabled)) lessonSelect.value = String(previous);
  const lesson = Number(lessonSelect.value);
  const baseSubject = day?.lessons[lesson - 1];
  const change = day && changeFor(day.day, lesson, date);
  const effective = change?.type === 'replacement' && change.to ? change.to : baseSubject;
  if (effective) {
    if (![...$('#admin-hw-id').options].some(option => option.value === effective)) {
      $('#admin-hw-id').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(effective)}">${escapeHtml(displaySubjectName(effective))}</option>`);
    }
    $('#admin-hw-id').value = effective;
  }
  syncAdminHomeworkFields();
}

function renderAll() {
  renderMeta();
  renderHomework();
  renderSchedule();
  renderSupplies();
  renderCoordinates();
  renderAdmin();
  $('#proposal-subject').innerHTML = subjectsFromSchedule().map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(displaySubjectName(subject))}</option>`).join('');
  const changeSelected = $('#change-to').value;
  $('#change-to').innerHTML = subjectsFromSchedule().map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(displaySubjectName(subject))}</option>`).join('');
  if ([...$('#change-to').options].some(option => option.value === changeSelected)) $('#change-to').value = changeSelected;
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
  localStorage.setItem('alegieri-user', JSON.stringify(user));
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

function syncChangeFields() {
  const type = $('#change-type').value;
  const wholeDay = ['day_off', 'working_day'].includes(type);
  $('#change-lesson-label').classList.toggle('field-disabled', wholeDay);
  $('#change-subject-label').classList.toggle('field-disabled', type !== 'replacement');
  $('#change-lesson').disabled = wholeDay;
  $('#change-to').disabled = type !== 'replacement';
}

function bindEvents() {
  document.addEventListener('click', event => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) { event.preventDefault(); navigate(routeButton.dataset.route); }
  });

  $('#homework-filter').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    activeHomeworkPeriod = button.dataset.filter;
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
    localStorage.removeItem('alegieri-user');
    if (currentUser) localStorage.removeItem(`alegieri-supplies-${currentUser.id}`);
    $('#profile-menu').hidden = true;
    showAuth();
  });

  $('#admin-homework-form').addEventListener('input', event => {
    if (event.target.matches('#admin-hw-id, #admin-hw-status, #admin-hw-task')) adminHomeworkDirty = true;
  });
  $('#admin-hw-date').addEventListener('change', () => { adminHomeworkDirty = false; syncAdminHomeworkLessons(); });
  $('#admin-hw-lesson').addEventListener('change', () => { adminHomeworkDirty = false; syncAdminHomeworkLessons(); });
  $('#admin-homework-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/admin/homework', { method: 'POST', body: JSON.stringify({ date: $('#admin-hw-date').value, lesson: Number($('#admin-hw-lesson').value), subject: $('#admin-hw-id').value, status: $('#admin-hw-status').value, task: $('#admin-hw-task').value }) });
      adminHomeworkDirty = false; showToast('Домашнее задание обновлено'); await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });
  $('#admin-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/admin/schedule-change', { method: 'POST', body: JSON.stringify({ date: $('#change-date').value, lesson: $('#change-lesson').value, type: $('#change-type').value, to: $('#change-to').value, note: $('#change-note').value }) });
      showToast('Изменение сохранено'); event.target.reset(); $('#change-date').value = defaultSchoolDate(); syncChangeFields(); await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });
  $('#change-type').addEventListener('change', syncChangeFields);
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
  if ('caches' in window) {
    const cacheNames = await caches.keys().catch(() => []);
    await Promise.all(cacheNames.filter(name => name.startsWith('alegieri-') && name !== 'alegieri-v2-4').map(name => caches.delete(name)));
  }
  const sidebarCollapsed = localStorage.getItem('alegieri-sidebar-collapsed') === 'true';
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  $('#sidebar-toggle').textContent = sidebarCollapsed ? '☷' : '☰';
  $('#change-date').value = defaultSchoolDate();
  $('#admin-hw-date').value = defaultSchoolDate();
  syncChangeFields();
  bindAuthEvents();
  bindEvents();
  const initialRoute = location.hash.slice(1);
  navigate(['today', 'homework', 'schedule', 'supplies', 'coordinates', 'admin'].includes(initialRoute) ? initialRoute : 'today');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=2.4', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
  try {
    const user = await request('/api/me');
    await showApp(user);
  } catch (error) {
    const cachedUser = localStorage.getItem('alegieri-user');
    if (error.status !== 401 && currentUser) {
      console.error(error);
      $('#auth-screen').hidden = true;
      $('#app-shell').hidden = false;
      showToast('Не удалось обновить часть интерфейса — повторите попытку');
    } else if (error.status !== 401 && cachedUser) {
      try {
        await showApp(JSON.parse(cachedUser));
        showToast('Сервер временно недоступен — показана сохранённая копия');
      } catch { showAuth(); }
    } else showAuth();
  }
  setInterval(() => { if (currentUser) loadState({ quiet: true }); }, 60_000);
}

init();
