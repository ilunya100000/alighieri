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
  if (state.bellSchedule?.[0]?.start !== '09:00' || state.bellSchedule?.[6]?.end !== '15:50') throw new Error('Расписание звонков заполнено неверно');

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
  const recommendation = await fetch(`${base}/api/admin/supply-recommendation`, {
    method: 'POST', headers: { ...jsonHeaders, Cookie: adminCookie },
    body: JSON.stringify({ id: supplies[0].id, recommended: 2, necessity: 'required' })
  });
  if (!recommendation.ok) throw new Error('Рекомендации администратора не сохраняются');

  const pageResponse = await fetch(`${base}/`);
  const html = await pageResponse.text();
  if (!pageResponse.ok || !html.includes('Алегьери') || !html.includes('login-form')) throw new Error('Входное окно недоступно');

  console.log('OK: Алегьери v1, SQLite, регистрация, вход, роли, тетради и рекомендации работают');
} finally {
  server.kill();
  await Promise.race([once(server, 'exit'), wait(1500)]);
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
