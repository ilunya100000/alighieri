import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { once } from 'node:events';

const port = 4199;
const tempDir = mkdtempSync(join(tmpdir(), 'alegieri-test-'));
const dbPath = join(tempDir, 'test.db');
const commonEnv = { ...process.env, ALEGIERI_DB: dbPath };
const setup = spawnSync(process.execPath, ['setup-admin.js'], {
  cwd: new URL('.', import.meta.url),
  env: { ...commonEnv, ALEGIERI_ADMIN_PASSWORD: 'test-admin-password' },
  encoding: 'utf8'
});
if (setup.status !== 0) throw new Error(setup.stderr || 'Не удалось создать тестового администратора');

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url),
  env: { ...commonEnv, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

const base = `http://127.0.0.1:${port}`;
const jsonHeaders = { 'Content-Type': 'application/json' };
const cookieFrom = response => response.headers.get('set-cookie')?.split(';')[0] || '';

try {
  await wait(500);

  const anonymousState = await fetch(`${base}/api/state`);
  if (anonymousState.status !== 401) throw new Error('Данные доступны без входа');

  const registerResponse = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ username: 'student_test', password: 'student-password', displayName: 'Тестовый ученик' })
  });
  if (registerResponse.status !== 201) throw new Error(`Регистрация не работает: ${await registerResponse.text()}`);
  const studentCookie = cookieFrom(registerResponse);

  const stateResponse = await fetch(`${base}/api/state`, { headers: { Cookie: studentCookie } });
  const state = await stateResponse.json();
  if (state.meta.className !== '9 В' || state.schedule.length !== 6) throw new Error('Учебные данные загружены неверно');
  if (state.schedule.find(day => day.day === 'Пт')?.lessons.length !== 7) throw new Error('Пятничное расписание заполнено неверно');
  if (!state.schedule.find(day => day.day === 'Ср')?.lessons.includes('Английский язык (Р)')) throw new Error('Разговорный английский не приведён к обозначению (Р)');
  if (state.schedule.find(day => day.day === 'Ср')?.lessons.includes('Английский язык (Разговорный практикум)')) throw new Error('Осталось старое обозначение разговорного английского');
  if (state.bellSchedule?.[0]?.start !== '09:00' || state.bellSchedule?.[6]?.end !== '15:50') throw new Error('Расписание звонков заполнено неверно');
  const holidays = Object.fromEntries((state.holidays || []).map(item => [item.id, item]));
  if (holidays['autumn-2026']?.start !== '2026-10-26' || holidays['autumn-2026']?.end !== '2026-11-03') throw new Error('Осенние каникулы заполнены неверно');
  if (holidays['winter-2026']?.start !== '2026-12-31' || holidays['winter-2026']?.end !== '2027-01-10') throw new Error('Зимние каникулы заполнены неверно');
  if (holidays['spring-2027']?.start !== '2027-03-27' || holidays['spring-2027']?.end !== '2027-04-04') throw new Error('Весенние каникулы заполнены неверно');
  if (holidays['summer-2027']?.start !== '2027-05-26' || holidays['summer-2027']?.end !== null) throw new Error('Летние каникулы заполнены неверно');

  const suppliesResponse = await fetch(`${base}/api/supplies`, { headers: { Cookie: studentCookie } });
  const supplies = (await suppliesResponse.json()).items;
  if (!supplies.some(item => item.name === 'Тетрадь — Алгебра')) throw new Error('Нет отдельных тетрадей по предметам');
  if (supplies.some(item => /Разговор|Физкультура|ВД \(/i.test(item.name))) throw new Error('Созданы тетради для исключённых предметов');

  const forbidden = await fetch(`${base}/api/admin/homework`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: studentCookie }, body: JSON.stringify({ subject: 'Алгебра' })
  });
  if (forbidden.status !== 403) throw new Error('Административный API не защищён ролью');

  const adminLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'admin', password: 'test-admin-password' })
  });
  if (!adminLogin.ok) throw new Error('Вход администратора не работает');
  const adminCookie = cookieFrom(adminLogin);
  const monday = new Date();
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const replacement = await fetch(`${base}/api/admin/schedule-change`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ date: mondayKey, lesson: 2, type: 'replacement', to: 'География', note: 'Тестовая замена' })
  });
  if (!replacement.ok) throw new Error(`Замена не сохраняется: ${await replacement.text()}`);
  const homework = await fetch(`${base}/api/admin/homework`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ date: mondayKey, lesson: 2, subject: 'География', status: 'assigned', task: 'Параграф 5' })
  });
  if (!homework.ok) throw new Error(`ДЗ заменённого урока не сохраняется: ${await homework.text()}`);
  const updatedState = await (await fetch(`${base}/api/state`, { headers: { Cookie: adminCookie } })).json();
  const linkedHomework = updatedState.homework.find(item => item.date === mondayKey && Number(item.lesson) === 2);
  if (linkedHomework?.subject !== 'География' || linkedHomework.task !== 'Параграф 5') throw new Error('ДЗ не связано с предметом замены');
  const lessonsResponse = await fetch(`${base}/api/lessons?date=${mondayKey}`, { headers: { Cookie: studentCookie } });
  const lessons = await lessonsResponse.json();
  const replacementLesson = lessons.lessons.find(item => item.lesson === 2);
  if (replacementLesson?.subject !== 'География' || !replacementLesson.replacement) throw new Error('Оценки не получают заменённый урок из расписания');
  const studentGrade = await fetch(`${base}/api/grades`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: studentCookie },
    body: JSON.stringify({ date: mondayKey, lesson: 2, subject: 'География', grade: 5, activityType: 'Домашнее задание', weight: 1, homeworkDate: mondayKey, homeworkLesson: 2 })
  });
  if (studentGrade.status !== 201) throw new Error(`Ученик не может добавить оценку к уроку: ${await studentGrade.text()}`);
  const wrongGrade = await fetch(`${base}/api/grades`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: studentCookie },
    body: JSON.stringify({ date: mondayKey, lesson: 2, subject: 'Информатика', grade: 5, activityType: 'Работа на уроке', weight: 1 })
  });
  if (wrongGrade.status !== 400) throw new Error('Оценку можно сохранить для предмета вне расписания');
  if (updatedState.meta.version !== 2) throw new Error('Миграция состояния v2 не выполнена');
  const dayOffResponse = await fetch(`${base}/api/admin/schedule-change`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ date: mondayKey, type: 'day_off', note: 'Тестовый выходной' })
  });
  if (!dayOffResponse.ok) throw new Error(`Выходной день не сохраняется: ${await dayOffResponse.text()}`);
  const forbiddenHolidayHomework = await fetch(`${base}/api/admin/homework`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ date: mondayKey, lesson: 1, subject: 'Информатика', status: 'assigned', task: 'Не должно сохраниться' })
  });
  if (forbiddenHolidayHomework.status !== 400) throw new Error('ДЗ можно сохранить на выходной день');
  const restoreDayResponse = await fetch(`${base}/api/admin/schedule-change`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ date: mondayKey, type: 'working_day' })
  });
  if (!restoreDayResponse.ok) throw new Error('Учебный день не восстанавливается');
  const recommendation = await fetch(`${base}/api/admin/supply-recommendation`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ id: supplies[0].id, recommended: 2, necessity: 'required' })
  });
  if (!recommendation.ok) throw new Error('Рекомендации администратора не сохраняются');

  const pageResponse = await fetch(`${base}/`);
  const html = await pageResponse.text();
  if (!pageResponse.ok || !html.includes('Алегьери') || !html.includes('login-form')) throw new Error('Входное окно недоступно');
  if (!html.includes('data-filter="current"') || !html.includes('data-filter="tomorrow"') || !html.includes('data-filter="week"')) throw new Error('Периоды дневника v2 отсутствуют');
  const appJs = await (await fetch(`${base}/app.js`)).text();
  if (!appJs.includes('function subjectIcon') || !appJs.includes('schedule-hw-status')) throw new Error('SVG-иконки или индикаторы ДЗ в расписании отсутствуют');

  const post = (path, cookie, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...jsonHeaders, Cookie: cookie }, body: JSON.stringify(body) });
  const proposalInput = { date: mondayKey, lesson: 2, text: 'Новое ДЗ по географии' };
  const emptyProposal = await post('/api/homework/proposals', studentCookie, { ...proposalInput, text: '   ' });
  if (emptyProposal.status !== 400) throw new Error('Предложение из пробелов принято');
  const noLessonProposal = await post('/api/homework/proposals', studentCookie, { ...proposalInput, lesson: 99 });
  if (noLessonProposal.status !== 400) throw new Error('Предложение вне расписания принято');
  const created = await post('/api/homework/proposals', studentCookie, proposalInput);
  if (created.status !== 201) throw new Error('Предложение на заменённый урок не создано');
  const proposal = await created.json();
  if (proposal.subject !== 'География' || proposal.date !== mondayKey || proposal.lesson !== 2) throw new Error('Предложение потеряло дату, урок или замену');
  const review = { id: proposal.id, action: 'approve' };
  if ((await post('/api/admin/proposal-review', studentCookie, review)).status !== 403) throw new Error('Ученик может модерировать ДЗ');
  const conflict = await post('/api/admin/proposal-review', adminCookie, review);
  if (conflict.status !== 409 || (await conflict.json()).code !== 'HOMEWORK_EXISTS') throw new Error('ДЗ заменяется без подтверждения');
  const approvedResponse = await post('/api/admin/proposal-review', adminCookie, { ...review, overwrite: true });
  if (!approvedResponse.ok) throw new Error('Администратор не может поставить ДЗ');
  const approved = await approvedResponse.json();
  const reviewedState = await (await fetch(`${base}/api/state`, { headers: { Cookie: studentCookie } })).json();
  const approvedHomework = reviewedState.homework.find(item => item.id === approved.homeworkId);
  if (approvedHomework?.task !== proposalInput.text || approvedHomework?.status !== 'assigned' || approvedHomework?.lesson !== 2) throw new Error('Одобренное предложение не попало в дневник');
  if ((await post('/api/admin/proposal-review', adminCookie, { ...review, overwrite: true })).status !== 409) throw new Error('Предложение можно обработать повторно');
  const toReject = await (await post('/api/homework/proposals', studentCookie, { date: mondayKey, lesson: 3, text: 'Отклоняемое ДЗ' })).json();
  const rejectedResponse = await post('/api/admin/proposal-review', adminCookie, { id: toReject.id, action: 'reject' });
  if (!rejectedResponse.ok || (await rejectedResponse.json()).status !== 'rejected') throw new Error('Отклонение не работает');
  const rejectedState = await (await fetch(`${base}/api/state`, { headers: { Cookie: adminCookie } })).json();
  if (rejectedState.homework.some(item => item.task === 'Отклоняемое ДЗ')) throw new Error('Отклонённое ДЗ опубликовано');
  const progressResponse = await fetch(`${base}/api/homework/progress/${approvedHomework.id}`, { method: 'PUT', headers: { ...jsonHeaders, Cookie: studentCookie }, body: JSON.stringify({ completed: true }) });
  if (!progressResponse.ok) throw new Error('Отметка выполнения не сохраняется');
  const studentProgress = await (await fetch(`${base}/api/homework/progress`, { headers: { Cookie: studentCookie } })).json();
  const adminProgress = await (await fetch(`${base}/api/homework/progress`, { headers: { Cookie: adminCookie } })).json();
  if (!studentProgress.items.some(item => item.homeworkId === approvedHomework.id && item.completed)) throw new Error('Выполнение потерялось после загрузки');
  if (adminProgress.items.some(item => item.homeworkId === approvedHomework.id && item.completed)) throw new Error('Чужая отметка выполнения видна другому пользователю');
  const changedProposal = await (await post('/api/homework/proposals', studentCookie, { date: mondayKey, lesson: 3, text: 'Алгебра' })).json();
  await post('/api/admin/schedule-change', adminCookie, { date: mondayKey, lesson: 3, type: 'replacement', to: 'Физика' });
  if ((await post('/api/admin/proposal-review', adminCookie, { id: changedProposal.id, action: 'approve' })).status !== 409) throw new Error('Предложение принято на предмет, изменённый заменой');
  await post('/api/admin/schedule-change', adminCookie, { date: mondayKey, lesson: 3, type: 'cancelled' });
  if ((await post('/api/homework/proposals', studentCookie, { date: mondayKey, lesson: 3, text: 'Отменённый урок' })).status !== 400) throw new Error('Предложение принято на отменённый урок');
  console.log('OK: Алегьери v3.1 — дневник, замены, оценки, предложения, модерация, личное выполнение и роли');
} finally {
  server.kill();
  await Promise.race([once(server, 'exit'), wait(1500)]);
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
