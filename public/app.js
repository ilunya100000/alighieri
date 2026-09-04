const statusMeta = {
  assigned: { label: 'Задано', short: 'Задано' },
  known: { label: 'Известно, что задано', short: 'Будет позже' },
  unknown: { label: 'О ДЗ неизвестно', short: 'Нет информации' },
  none: { label: 'Нет ДЗ', short: 'Нет ДЗ' }
};

const coordinateColors = ['#7c5cff', '#3c8dff', '#f59e45', '#45ad7d', '#df665d', '#9b5de5'];
const gradeTypes = [
  ['Работа на уроке', 1], ['Домашнее задание', 1], ['Самостоятельная работа', 1.2], ['Лабораторная работа', 1.3], ['Проверочная работа', 1.3], ['Словарный диктант', 1.4], ['Контрольная работа', 1.5], ['Административная контрольная работа', 1.5], ['Срезовая работа', 1.3], ['Контрольная практическая работа', 1.5], ['Классное сочинение', 1.5], ['Домашнее сочинение', 1.4], ['Аудирование', 1.4], ['Контрольный диктант', 1.5], ['Зачёт', 1.5], ['Работа над ошибками', 1], ['Викторина', 1], ['Изложение', 1.4], ['Дистанционный урок', 1], ['Электронное обучение', 1], ['Сочинение', 1], ['Пр.', 1], ['Электронный курс', 1], ['Тест', 1], ['Ведение тетради', 1], ['Чтение наизусть', 1], ['Практическая работа', 1.3]
];
const fallbackState = {
  meta: { className: '9 В', updatedAt: new Date().toISOString(), term: '' },
  homework: [], schedule: [], scheduleChanges: [], bellSchedule: [], supplies: { 'current-student': [] },
  holidays: [],
  coordinates: { subjects: [], teachers: [] }, proposals: []
};

let appState = fallbackState;
let supplyState = [];
let gradeState = [];
let homeworkProgress = [];
let currentUser = null;
let activeHomeworkPeriod = 'current';
let activeMap = 'subjects';
let currentRole = 'student';
let weekOffset = 0;
let dragState = null;
let deferredInstall;
let adminHomeworkDirty = false;
let serverClockOffset = 0;
let clockTimer = null;
let selectedGradeLesson = null;
let selectedGradeValue = 5;
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

function changeNotificationSignature(state) {
  const changes = (state.scheduleChanges || []).map(item => `${item.id || ''}|${item.date || ''}|${item.lesson || ''}|${item.type}|${item.to || ''}`);
  const homework = (state.homework || []).filter(item => item.status === 'assigned').map(item => `${item.id}|${item.date}|${item.lesson}|${item.task}`);
  return JSON.stringify({ changes: changes.sort(), homework: homework.sort() });
}

function notifyAboutChanges(state) {
  if (!currentUser || !('Notification' in window)) return;
  const key = `alegieri-notification-signature-${currentUser.id}`;
  const previous = localStorage.getItem(key);
  const next = changeNotificationSignature(state);
  localStorage.setItem(key, next);
  if (!previous || previous === next || Notification.permission !== 'granted') return;
  const before = JSON.parse(previous);
  const after = JSON.parse(next);
  const addedChanges = after.changes.filter(item => !before.changes.includes(item)).length;
  const addedHomework = after.homework.filter(item => !before.homework.includes(item)).length;
  if (!addedChanges && !addedHomework) return;
  const parts = [];
  if (addedChanges) parts.push(`изменений в расписании: ${addedChanges}`);
  if (addedHomework) parts.push(`новых ДЗ: ${addedHomework}`);
  new Notification('Алегьери: есть обновления', { body: parts.join(' · '), icon: '/icon.svg' });
}

function formatUpdated(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'время неизвестно';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function subjectsFromSchedule() {
  return [...new Set(appState.schedule.flatMap(day => day.lessons))];
}

function moscowNow() {
  const instant = new Date(Date.now() + serverClockOffset);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

function displaySubjectName(subject = '') {
  return subject === 'Английский язык (Разговорный практикум)' ? 'Английский язык (Р)' : subject;
}

function teacherShortName(name = '') {
  const words = String(name).split('·')[0].trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return String(name).split('·')[0].trim();
  return `${words[0]} ${words.slice(1).map(word => `${word.slice(0, 1)}.`).join(' ')}`;
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
  const now = moscowNow();
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
  if (period === 'current') {
    const now = moscowNow();
    const today = dateKey(now);
    const todayFinished = schoolDayFinished(schoolDay(now), now);
    return appState.homework.filter(item => item.status === 'assigned' && item.date >= today && (!todayFinished || item.date !== today)).sort((a, b) => `${a.date}-${a.lesson}`.localeCompare(`${b.date}-${b.lesson}`)).map((item, index) => {
      const date = dateFromKey(item.date);
      const day = schoolDay(date);
      const originalSubject = day?.lessons?.[Number(item.lesson) - 1] || item.subject;
      return { ...item, originalSubject, dueLabel: `${date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })} · ${item.lesson} урок`, task: item.task || '', accent: item.accent || ['violet', 'blue', 'orange', 'green'][index % 4] };
    });
  }
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
        task: saved?.task || '',
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
  const date = moscowNow();
  if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return dateKey(date);
}

function mondayFor(offset = 0) {
  const date = moscowNow();
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

function isLessonPassed(bell, now = moscowNow()) {
  if (!bell?.end) return false;
  const [hour, minute] = bell.end.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}

function schoolDayFinished(day, now = moscowNow()) {
  if (!day || day.day === 'Сб' || dayOffInfo(now)) return false;
  const lastBell = bellFor(day.day, day.lessons.length - 1);
  return isLessonPassed(lastBell, now);
}

function renderMeta() {
  $('#class-name').textContent = appState.meta.className || 'Класс';
  $('#class-term').textContent = appState.meta.term || `${appState.schedule.length} учебных дней`;
  const now = moscowNow();
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
    const [fresh, supplies, grades, progress, clock] = await Promise.all([request('/api/state'), request('/api/supplies'), request('/api/grades'), request('/api/homework/progress'), request('/api/time')]);
    appState = fresh;
    supplyState = supplies.items || [];
    gradeState = grades.items || [];
    homeworkProgress = progress.items || [];
    serverClockOffset = new Date(clock.now).getTime() - Date.now();
    localStorage.setItem('alegieri-state', JSON.stringify(fresh));
    notifyAboutChanges(fresh);
    localStorage.setItem(`alegieri-supplies-${currentUser.id}`, JSON.stringify(supplyState));
    setSyncState('online', `Обновлено ${formatUpdated(fresh.meta.updatedAt)}`);
  } catch (error) {
    if (error.status === 401) { showAuth(); return; }
    const cached = localStorage.getItem('alegieri-state');
    appState = cached ? JSON.parse(cached) : fallbackState;
    const cachedSupplies = localStorage.getItem(`alegieri-supplies-${currentUser?.id}`);
    supplyState = cachedSupplies ? JSON.parse(cachedSupplies) : [];
    gradeState = [];
    homeworkProgress = [];
    setSyncState('offline', cached ? `Офлайн · копия от ${formatUpdated(appState.meta.updatedAt)}` : 'Сервер недоступен');
    if (!quiet && !cached) showToast('Сервер недоступен, сохранённых данных пока нет');
  }
  renderAll();
}

function homeworkTemplate(item) {
  const status = statusMeta[item.status] || statusMeta.unknown;
  const completed = homeworkProgress.some(entry => entry.homeworkId === item.id && entry.completed);
  return `<article class="homework-item accent-${escapeHtml(item.accent || 'violet')}" data-status="${escapeHtml(item.status)}">
    <div class="subject-icon">${subjectIcon(item.subject)}</div>
    <div class="subject-name"><b>${escapeHtml(displaySubjectName(item.subject))}</b><small>${item.replacement ? `Замена вместо ${escapeHtml(displaySubjectName(item.originalSubject))}` : escapeHtml(item.teacher)}</small></div>
    <div class="task-text ${item.status === 'assigned' ? '' : 'status-only'}">${item.status === 'assigned' ? escapeHtml(item.task) : ''}<small>${escapeHtml(item.dueLabel)}</small></div>
    <span class="homework-state">${status.label}</span>
    ${item.status === 'assigned' ? `<button class="homework-complete ${completed ? 'completed' : ''}" data-homework-complete="${escapeHtml(item.id)}" aria-pressed="${completed}" title="Отметить выполнение">${completed ? '✓ Сделано' : '○ Сделано'}</button>` : ''}
  </article>`;
}

function renderHomework() {
  const allHomework = homeworkItems();
  const assigned = allHomework.filter(item => item.status === 'assigned');
  const completed = assigned.filter(item => homeworkProgress.some(entry => entry.homeworkId === item.id && entry.completed)).length;
  const percent = assigned.length ? Math.round(completed / assigned.length * 100) : 0;
  $('#homework-count').textContent = assigned.length;
  $('#summary-homework').textContent = `${percent}%`;
  $('#summary-homework-caption').textContent = assigned.length ? `выполнено ${completed} из ${assigned.length}` : 'актуальных заданий нет';
  const preview = allHomework.slice(0, 3);
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

function gradesForLesson(date, lesson, subject) {
  const key = dateKey(date);
  return gradeState.filter(item => item.date === key && Number(item.lesson) === Number(lesson) && item.subject === subject)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function renderSchedule() {
  const dayKeys = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const now = moscowNow();
  const todayKey = dayKeys[now.getDay()];
  const today = appState.schedule.find(day => day.day === todayKey);
  const todayOff = dayOffInfo(now);
  const monday = mondayFor(weekOffset);
  const saturday = scheduleDate(5);
  const selectedDates = appState.schedule.map((_, index) => scheduleDate(index));
  const selectedDateKeys = selectedDates.map(dateKey);
  const visibleChanges = appState.scheduleChanges.filter(change => !change.date || selectedDateKeys.includes(change.date));

  const rangeStart = monday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const rangeEnd = saturday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: monday.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  $('#week-label').textContent = `${rangeStart} — ${rangeEnd}`;
  const finished = schoolDayFinished(today, now);
  const displayDate = finished ? nextSchoolDate(now) : now;
  const displayDay = displayDate ? schoolDay(displayDate) : null;
  const displayOff = displayDate ? dayOffInfo(displayDate) : null;
  const summaryTitle = $('#summary-lessons').closest('.summary-card').querySelector('small');
  summaryTitle.textContent = finished ? 'Уроки завтра' : 'Уроки сегодня';
  $('#summary-lessons').textContent = displayOff ? 0 : displayDay?.lessons.length || 0;
  $('#next-lesson').textContent = displayOff ? displayOff.name : displayDay?.lessons[0] ? `первый — ${displaySubjectName(displayDay.lessons[0])}` : 'ближайших уроков нет';
  $('#summary-changes').textContent = visibleChanges.length;
  $('#schedule-alert').hidden = visibleChanges.length === 0;
  $('#notification-button').hidden = visibleChanges.length === 0;
  $('#changes-summary-card').hidden = visibleChanges.length === 0;

  const todayPanel = $('#today-lessons').closest('.day-plan-panel');
  $('.panel-heading .eyebrow', todayPanel).textContent = finished ? 'ЗАВТРА' : 'СЕГОДНЯ';
  $('.panel-heading h2', todayPanel).textContent = finished ? 'Расписание на завтра' : 'Расписание дня';
  $('#today-lessons').innerHTML = displayOff ? `<div class="day-off-empty"><b>${escapeHtml(displayOff.name)}</b><small>В этот день уроков нет</small></div>` : (displayDay?.lessons || []).slice(0, 5).map((lesson, index) => {
    const change = changeFor(displayDay.day, index + 1, displayDate);
    const displayed = change?.type === 'replacement' ? change.to : lesson;
    const bell = bellFor(displayDay.day, index);
    const passed = !finished && isLessonPassed(bell, now);
    return `<div class="lesson-row ${passed ? 'passed' : ''}"><span class="mini-subject-icon">${subjectIcon(displayed)}</span><div><b>${escapeHtml(displaySubjectName(displayed))}</b>${passed ? '<small class="lesson-passed">Урок прошёл</small>' : change ? `<small>${change.type === 'cancelled' ? 'Отменён' : 'Замена'}</small>` : ''}</div><span class="lesson-time">${bell ? `${bell.start}–${bell.end}` : 'время уточняется'}</span></div>`;
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
      const bell = bellFor(day.day, index);
      const passed = isToday && isLessonPassed(bell, now);
      const className = `${isCancelled ? 'cancelled' : change ? 'changed' : ''} ${passed ? 'passed' : ''}`;
      const homeworkStatus = isCancelled ? '' : homeworkStatusFor(calendarDate, index + 1, displayLesson);
      const grades = isCancelled ? [] : gradesForLesson(calendarDate, index + 1, displayLesson);
      const timeLabel = bell ? `${bell.start}–${bell.end}` : 'время уточняется';
      const detail = change
        ? change.note || change.teacher || lesson
        : bell?.breakAfter ? `перемена после — ${bell.breakAfter} мин` : bell ? 'последний урок' : 'звонки субботы пока не указаны';
      return `<div class="schedule-lesson ${className}">
        ${change ? `<span class="change-badge">${isCancelled ? 'отмена' : 'замена'}</span>` : ''}
        <span class="lesson-index">${index + 1} урок · ${timeLabel}</span>
        <div class="schedule-subject"><span class="mini-subject-icon">${subjectIcon(displayLesson)}</span><b>${escapeHtml(displaySubjectName(displayLesson))}</b></div>
        <small>${passed ? 'Урок прошёл' : escapeHtml(detail)}</small>
        ${homeworkStatus ? `<span class="schedule-hw-status" data-status="${homeworkStatus}" title="${escapeHtml(statusMeta[homeworkStatus].label)}"><i></i>${escapeHtml(statusMeta[homeworkStatus].short)}</span>` : ''}
        ${grades.length ? `<span class="schedule-grade-marks" title="Ваши оценки за этот урок">${grades.map(item => `<b data-grade="${item.grade}">${item.grade}</b>`).join('')}<small>${grades.length === 1 ? 'оценка' : 'оценки'}</small></span>` : ''}
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

function gradeLessonPlan(date) {
  const off = dayOffInfo(date);
  const day = schoolDay(date);
  if (off || !day) return { off: off?.name || 'В этот день учебных занятий нет', lessons: [] };
  return {
    off: null,
    lessons: day.lessons.map((originalSubject, index) => {
      const lesson = index + 1;
      const change = changeFor(day.day, lesson, date);
      return { lesson, originalSubject, subject: change?.type === 'replacement' && change.to ? change.to : originalSubject, cancelled: change?.type === 'cancelled', replacement: change?.type === 'replacement', note: change?.note || '' };
    })
  };
}

function selectedGradeLessonData() {
  const date = dateFromKey($('#grade-date').value);
  return date ? gradeLessonPlan(date).lessons.find(item => item.lesson === selectedGradeLesson) : null;
}

function syncGradeForm() {
  const lesson = selectedGradeLessonData();
  const type = $('#grade-type').value;
  const homework = lesson ? homeworkForLesson(dateFromKey($('#grade-date').value), lesson.lesson, lesson.subject) : null;
  const shouldLink = type === 'Домашнее задание' && homework?.status === 'assigned';
  $('#grade-homework-label').hidden = !shouldLink;
  $('#grade-homework-chip').hidden = !shouldLink;
  $('#grade-homework').innerHTML = shouldLink ? `<option value="linked">${escapeHtml(homework.task ? `ДЗ: ${homework.task}` : 'Домашнее задание урока')}</option>` : '<option value="">Не связывать</option>';
}

function gradeSummary(items) {
  const weight = items.reduce((sum, item) => sum + Number(item.weight), 0);
  const value = items.reduce((sum, item) => sum + Number(item.grade) * Number(item.weight), 0);
  const average = weight ? value / weight : 0;
  const enough = items.length >= 3;
  const predicted = enough ? Math.max(2, Math.min(5, Math.floor(average + .5))) : null;
  const next = predicted && predicted < 5 ? predicted + 1 : null;
  const needed = next ? Math.max(0, Math.ceil(((next - .5) * weight - value) / (5 - (next - .5)))) : 0;
  return { weight, value, average, enough, predicted, next, needed };
}

function renderGrades() {
  const typeSelect = $('#grade-type');
  const currentType = typeSelect.value;
  typeSelect.innerHTML = gradeTypes.map(([name, weight]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)} · вес ${weight}</option>`).join('');
  if ([...typeSelect.options].some(option => option.value === currentType)) typeSelect.value = currentType;
  if (!$('#grade-date').value) $('#grade-date').value = dateKey(moscowNow());
  const chosenDate = dateFromKey($('#grade-date').value);
  const plan = gradeLessonPlan(chosenDate);
  $('#grade-date-hint').textContent = plan.off || `${chosenDate.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })} · выберите урок для оценки`;
  if (!plan.lessons.some(item => item.lesson === selectedGradeLesson && !item.cancelled)) selectedGradeLesson = null;
  $('#grade-lessons').innerHTML = plan.lessons.length ? plan.lessons.map(item => `<button class="grade-lesson ${item.cancelled ? 'cancelled' : ''} ${item.lesson === selectedGradeLesson ? 'active' : ''}" data-grade-lesson="${item.lesson}" ${item.cancelled ? 'disabled' : ''}><span>${item.lesson}</span><i class="mini-subject-icon">${subjectIcon(item.subject)}</i><b>${escapeHtml(displaySubjectName(item.subject))}</b><small>${item.cancelled ? 'Отменён' : item.replacement ? `Замена вместо ${escapeHtml(displaySubjectName(item.originalSubject))}` : 'Урок по расписанию'}</small></button>`).join('') : '<div class="grade-no-lessons">На эту дату уроков нет.</div>';
  const selected = selectedGradeLessonData();
  $('#grade-entry-panel').hidden = !selected;
  if (selected) {
    const homework = homeworkForLesson(chosenDate, selected.lesson, selected.subject);
    $('#grade-selected-title').innerHTML = `${subjectIcon(selected.subject)} <span>${escapeHtml(displaySubjectName(selected.subject))}</span>`;
    $('#grade-selected-caption').textContent = `${chosenDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} · ${selected.lesson} урок${selected.replacement ? ' · замена' : ''}${homework?.status === 'assigned' ? ' · ДЗ добавлено' : ''}`;
    $$('#grade-value button').forEach(button => button.classList.toggle('active', Number(button.dataset.gradeValue) === selectedGradeValue));
    syncGradeForm();
  }

  const bySubject = gradeState.reduce((result, item) => { (result[item.subject] ||= []).push(item); return result; }, {});
  const subjects = subjectsFromSchedule().sort((a, b) => a.localeCompare(b, 'ru'));
  $('#grades-overview').innerHTML = subjects.map(subject => {
    const items = bySubject[subject] || [];
    const ordered = [...items].sort((a, b) => a.date.localeCompare(b.date));
    const summary = gradeSummary(items);
    const average = summary.enough ? summary.average.toFixed(2).replace('.', ',') : '—';
    const prediction = summary.predicted ? String(summary.predicted) : 'после 3 оценок';
    const next = summary.next ? (summary.needed ? `${summary.needed} пят. до ${summary.next}` : `можно до ${summary.next}`) : summary.predicted === 5 ? 'максимум' : 'нужно ещё оценок';
    return `<article class="panel grade-subject-card"><div class="grade-subject-heading"><span class="mini-subject-icon">${subjectIcon(subject)}</span><div><h2>${escapeHtml(displaySubjectName(subject))}</h2><small>${items.length ? `${items.length} ${items.length === 1 ? 'оценка' : 'оценок'}` : 'Оценок пока нет'}</small></div></div><div class="grade-metrics"><div class="grade-metric"><small>Средний</small><strong>${average}</strong></div><div class="grade-metric"><small>Прогноз</small><strong>${escapeHtml(prediction)}</strong></div><div class="grade-metric"><small>До выше</small><strong>${escapeHtml(next)}</strong></div></div><div class="grade-dynamics" title="Динамика оценок">${ordered.map(item => `<i data-grade="${item.grade}" style="height:${20 + item.grade * 12}%" title="${item.grade} · ${escapeHtml(item.date)}"></i>`).join('')}</div><div class="grade-history">${[...items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map(item => `<div class="grade-history-row"><span class="grade-mark">${item.grade}</span><b>${escapeHtml(item.activityType)}</b><span>${escapeHtml(dateFromKey(item.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }))} · ${item.lesson || '?'} урок${item.homeworkDate ? ' · ДЗ' : ''}</span><button data-grade-delete="${item.id}" title="Удалить оценку">×</button></div>`).join('')}</div></article>`;
  }).join('');
}

function mapLabels() {
  return activeMap === 'subjects'
    ? { title: 'Карта предметов', description: 'Важность и субъективная сложность', top: 'Сложнее +20', bottom: 'Легче −20', left: 'Менее важно −20', right: 'Важнее +20', x: 'Важность', y: 'Сложность' }
    : { title: 'Карта учителей', description: 'Характер и сила преподавания', top: 'Сильнее +20', bottom: 'Слабее −20', left: 'Строже −20', right: 'Добрее +20', x: 'Характер', y: 'Как учит' };
}

function renderCoordinates() {
  const labels = mapLabels();
  $('#map-title').textContent = labels.title;
  $('#map-description').textContent = labels.description;
  const points = appState.coordinates[activeMap] || [];
  const subjectMap = activeMap === 'subjects';
  const map = $('#coordinate-map');
  map.innerHTML = `<span class="axis-label axis-top">${labels.top}</span><span class="axis-label axis-bottom">${labels.bottom}</span><span class="axis-label axis-left">${labels.left}</span><span class="axis-label axis-right">${labels.right}</span>${points.map(point => {
    const left = 5 + ((Number(point.x) + 20) / 40) * 90;
    const bottom = 5 + ((Number(point.y) + 20) / 40) * 90;
    const label = subjectMap ? displaySubjectName(point.name) : teacherShortName(point.name);
    const icon = subjectMap ? `<span class="map-point-icon">${subjectIcon(point.name)}</span>` : '';
    return `<button class="map-point ${subjectMap ? 'subject-map-point' : ''} ${currentRole === 'admin' ? 'draggable' : ''}" style="left:${left}%;bottom:${bottom}%;--point:${escapeHtml(point.color)}" data-point="${escapeHtml(point.id)}" data-name="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
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
  const metric = (name, value, from, to, reverseColors = false) => {
    const safeValue = Math.max(-20, Math.min(20, Number(value) || 0));
    const percent = ((safeValue + 20) / 40) * 100;
    const colorPosition = reverseColors ? 100 - percent : percent;
    const hue = Math.round(5 + colorPosition * 2.85);
    return `<section class="coordinate-metric" style="--metric-color:hsl(${hue} 72% 46%)"><div class="coordinate-metric-heading"><h3>${escapeHtml(name)}</h3><strong>${safeValue > 0 ? '+' : ''}${safeValue}</strong></div><div class="coordinate-scale"><span class="coordinate-scale-fill" style="width:${percent}%"></span><i class="coordinate-scale-marker" style="left:${percent}%"></i></div><div class="coordinate-scale-ends"><span>${escapeHtml(from)}</span><span>${escapeHtml(to)}</span></div></section>`;
  };
  const subjectPoint = activeMap === 'subjects';
  const title = subjectPoint ? displaySubjectName(point.name) : teacherShortName(point.name);
  const visual = subjectPoint ? subjectIcon(point.name) : escapeHtml(title.slice(0, 1));
  $$('.map-point').forEach(button => button.classList.toggle('active', button.dataset.point === pointId));
  const editForm = currentRole === 'admin' ? `<form class="coordinate-edit-form" data-coordinate-id="${escapeHtml(point.id)}">
    <label>Подпись точки<input name="name" maxlength="100" value="${escapeHtml(point.name)}" required></label>
    <div class="coordinate-edit-values"><label>${labels.x}<input name="x" type="number" min="-20" max="20" value="${Number(point.x)}" required></label><label>${labels.y}<input name="y" type="number" min="-20" max="20" value="${Number(point.y)}" required></label></div>
    <label>Заметка<textarea name="description" maxlength="800" placeholder="Краткое описание точки">${escapeHtml(point.description || '')}</textarea></label>
    <button class="secondary-button" type="submit">Сохранить метку</button>
    <p class="drag-hint">Координаты также можно изменить, перетащив точку на карте.</p>
  </form>` : `<p>${escapeHtml(point.description || 'Описание пока не добавлено.')}</p>`;
  $('#coordinate-detail').innerHTML = `<div class="detail-color ${subjectPoint ? 'detail-subject-icon' : ''}" style="--detail:${escapeHtml(point.color)}">${visual}</div><h2>${escapeHtml(title)}</h2><div class="coordinate-metrics">${metric(labels.x, point.x, labels.left, labels.right, !subjectPoint)}${metric(labels.y, point.y, labels.bottom, labels.top, subjectPoint)}</div><p class="coordinate-note">${escapeHtml(point.description || 'Описание пока не добавлено.')}</p>${editForm}`;
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
  syncAdminHomeworkTaskField();
}

function syncAdminHomeworkTaskField() {
  const assigned = $('#admin-hw-status').value === 'assigned';
  $('#admin-hw-task').disabled = !assigned;
  $('#admin-hw-task').required = assigned;
  $('#admin-hw-task-label').classList.toggle('field-disabled', !assigned);
  $('#admin-hw-task-hint').textContent = assigned ? 'Обязателен для статуса «Задано».' : 'Для этого статуса текст задания не используется.';
  if (!assigned) $('#admin-hw-task').value = '';
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
  renderGrades();
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
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-homework-complete]');
    if (!button) return;
    const homeworkId = button.dataset.homeworkComplete;
    const previous = homeworkProgress.some(entry => entry.homeworkId === homeworkId && entry.completed);
    try {
      await request(`/api/homework/progress/${encodeURIComponent(homeworkId)}`, { method: 'PUT', body: JSON.stringify({ completed: !previous }) });
      const item = homeworkProgress.find(entry => entry.homeworkId === homeworkId);
      if (item) item.completed = !previous;
      else homeworkProgress.push({ homeworkId, completed: !previous });
      renderHomework();
      showToast(!previous ? 'Задание отмечено выполненным' : 'Отметка выполнения снята');
    } catch (error) { showToast(error.message); }
  });

  $('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('alegieri-sidebar-collapsed', String(collapsed));
    $('#sidebar-toggle').textContent = collapsed ? '☷' : '☰';
  });
  $('#notification-button').addEventListener('click', async event => {
    if (!('Notification' in window)) return;
    event.stopPropagation();
    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      showToast(permission === 'granted' ? 'Уведомления включены только для новых изменений' : 'Разрешение на уведомления не получено');
    } else if (Notification.permission === 'granted') showToast('Уведомления включены: придут только при новом ДЗ, замене или отмене');
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
  $('#coordinate-detail').addEventListener('submit', async event => {
    const form = event.target.closest('.coordinate-edit-form');
    if (!form) return;
    event.preventDefault();
    const point = (appState.coordinates[activeMap] || []).find(item => item.id === form.dataset.coordinateId);
    if (!point) return;
    const fields = new FormData(form);
    const payload = {
      map: activeMap,
      id: point.id,
      name: String(fields.get('name') || '').trim(),
      x: Number(fields.get('x')),
      y: Number(fields.get('y')),
      description: String(fields.get('description') || '').trim(),
      color: point.color
    };
    if (!payload.name) return showToast('Укажите подпись точки');
    try {
      const saved = await request('/api/admin/coordinate', { method: 'POST', body: JSON.stringify(payload) });
      Object.assign(point, saved);
      renderCoordinates();
      showCoordinateDetail(point.id);
      showToast('Метка сохранена');
    } catch (error) { showToast(error.message); }
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

  $('#grade-date').addEventListener('change', () => { selectedGradeLesson = null; renderGrades(); });
  $('#grade-lessons').addEventListener('click', event => {
    const button = event.target.closest('[data-grade-lesson]');
    if (!button || button.disabled) return;
    selectedGradeLesson = Number(button.dataset.gradeLesson);
    renderGrades();
  });
  $('#grade-value').addEventListener('click', event => {
    const button = event.target.closest('[data-grade-value]');
    if (!button) return;
    selectedGradeValue = Number(button.dataset.gradeValue);
    $$('#grade-value button').forEach(item => item.classList.toggle('active', item === button));
  });
  $('#grade-type').addEventListener('change', syncGradeForm);
  $('#grade-form').addEventListener('submit', async event => {
    event.preventDefault();
    const lesson = selectedGradeLessonData();
    if (!lesson) return showToast('Сначала выберите урок из расписания');
    const [activityType, weight] = gradeTypes.find(([name]) => name === $('#grade-type').value) || [$('#grade-type').value, 1];
    const date = $('#grade-date').value;
    const linkHomework = $('#grade-homework').value === 'linked';
    try {
      await request('/api/grades', { method: 'POST', body: JSON.stringify({ subject: lesson.subject, lesson: lesson.lesson, grade: selectedGradeValue, activityType, weight, date, homeworkDate: linkHomework ? date : null, homeworkLesson: linkHomework ? lesson.lesson : null }) });
      showToast('Оценка добавлена');
      selectedGradeValue = 5;
      await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });
  $('#grades-overview').addEventListener('click', async event => {
    const button = event.target.closest('[data-grade-delete]');
    if (!button) return;
    try {
      await request(`/api/grades/${button.dataset.gradeDelete}`, { method: 'DELETE' });
      showToast('Оценка удалена');
      await loadState({ quiet: true });
    } catch (error) { showToast(error.message); }
  });

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
  $('#admin-hw-status').addEventListener('change', syncAdminHomeworkTaskField);
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
    await Promise.all(cacheNames.filter(name => name.startsWith('alegieri-') && name !== 'alegieri-v3-0').map(name => caches.delete(name)));
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
  navigate(['today', 'homework', 'schedule', 'supplies', 'grades', 'coordinates', 'admin'].includes(initialRoute) ? initialRoute : 'today');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=3.0', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
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
