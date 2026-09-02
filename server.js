const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  readState, writeState, createUser, authenticate, createSession, userFromToken,
  deleteSession, getSupplies, setSupplyCount, setSupplyRecommendation
} = require('./database');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const publicDir = path.join(__dirname, 'public');
const loginAttempts = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(body));
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function currentUser(req) {
  return userFromToken(cookieValue(req, 'alegieri_session'));
}

function setSessionCookie(res, session, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((session.expires.getTime() - Date.now()) / 1000));
  res.setHeader('Set-Cookie', `alegieri_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${session.expires.toUTCString()}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'alegieri_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function loginAllowed(req) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  return entry.count < 10;
}

function recordLoginFailure(req) {
  const key = req.socket.remoteAddress || 'local';
  const entry = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  entry.count += 1;
  loginAttempts.set(key, entry);
}

function clearLoginFailures(req) {
  loginAttempts.delete(req.socket.remoteAddress || 'local');
}

function bodyFrom(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Слишком большой запрос'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    json(res, 401, { error: 'Войдите в аккаунт' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user || user.role !== 'admin') {
    json(res, 403, { error: 'Требуются права администратора' });
    return null;
  }
  return user;
}

function holidayFor(state, key) {
  return (state.holidays || []).find(item => key >= item.start && (!item.end || key <= item.end));
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = currentUser(req);
    return json(res, user ? 200 : 401, user || { error: 'Нет активной сессии' });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const input = await bodyFrom(req);
    try {
      const user = createUser({ username: input.username, password: input.password, displayName: input.displayName });
      const session = createSession(user.id);
      setSessionCookie(res, session, req);
      return json(res, 201, user);
    } catch (error) {
      const duplicate = String(error.message).includes('UNIQUE');
      return json(res, duplicate ? 409 : 400, { error: duplicate ? 'Такой логин уже занят' : error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!loginAllowed(req)) return json(res, 429, { error: 'Слишком много попыток. Повторите вход через 15 минут' });
    const input = await bodyFrom(req);
    const user = authenticate(input.username, input.password);
    if (!user) {
      recordLoginFailure(req);
      return json(res, 401, { error: 'Неверный логин или пароль' });
    }
    clearLoginFailures(req);
    const session = createSession(user.id);
    setSessionCookie(res, session, req);
    return json(res, 200, user);
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    deleteSession(cookieValue(req, 'alegieri_session'));
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!requireUser(req, res)) return;
    return json(res, 200, readState());
  }

  if (req.method === 'GET' && url.pathname === '/api/supplies') {
    const user = requireUser(req, res);
    if (!user) return;
    return json(res, 200, { items: getSupplies(user.id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/homework/proposals') {
    const user = requireUser(req, res);
    if (!user) return;
    const input = await bodyFrom(req);
    if (!input.subject || !input.text) return json(res, 400, { error: 'Укажите предмет и задание' });
    const state = readState();
    const proposal = {
      id: `proposal-${Date.now()}`,
      subject: String(input.subject).slice(0, 80),
      text: String(input.text).slice(0, 600),
      author: user.displayName,
      authorId: user.id,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    state.proposals.push(proposal);
    writeState(state);
    return json(res, 201, proposal);
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/supplies/')) {
    const user = requireUser(req, res);
    if (!user) return;
    const supplyId = Number(url.pathname.split('/').pop());
    const input = await bodyFrom(req);
    const current = setSupplyCount(user.id, supplyId, input.current);
    return json(res, 200, { id: supplyId, current });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/homework') {
    if (!requireAdmin(req, res)) return;
    const input = await bodyFrom(req);
    const state = readState();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) return json(res, 400, { error: 'Укажите дату урока' });
    const homeworkDate = new Date(`${input.date}T12:00:00`);
    const dayKey = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][homeworkDate.getDay()];
    const day = state.schedule.find(entry => entry.day === dayKey);
    const lesson = Number(input.lesson);
    if (holidayFor(state, input.date) || state.scheduleChanges.some(entry => entry.type === 'day_off' && entry.date === input.date)) return json(res, 400, { error: 'Нельзя задать ДЗ на выходной день' });
    if (!day || !Number.isInteger(lesson) || lesson < 1 || lesson > day.lessons.length) return json(res, 400, { error: 'Такого урока нет в расписании' });
    const change = state.scheduleChanges.find(entry => entry.date === input.date && Number(entry.lesson) === lesson);
    if (change?.type === 'cancelled') return json(res, 400, { error: 'Нельзя задать ДЗ на отменённый урок' });
    const scheduledSubject = change?.type === 'replacement' && change.to ? change.to : day.lessons[lesson - 1];
    const subject = String(input.subject || scheduledSubject).trim().slice(0, 100);
    let item = state.homework.find(entry => entry.date === input.date && Number(entry.lesson) === lesson);
    if (!item) {
      item = {
        id: `hw-${Date.now()}`,
        subject,
        date: input.date,
        lesson,
        teacher: '',
        dueLabel: '',
        status: 'unknown',
        task: '',
        icon: String(input.subject).slice(0, 1).toUpperCase(),
        accent: 'violet'
      };
      state.homework.push(item);
    }
    Object.assign(item, {
      subject,
      date: input.date,
      lesson,
      status: input.status ?? item.status,
      task: input.task ?? item.task,
      dueLabel: input.dueLabel ?? item.dueLabel
    });
    writeState(state);
    return json(res, 200, item);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/schedule-change') {
    if (!requireAdmin(req, res)) return;
    const input = await bodyFrom(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) return json(res, 400, { error: 'Укажите дату изменения' });
    const changeDate = new Date(`${input.date}T12:00:00`);
    const day = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][changeDate.getDay()];
    if (!['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].includes(day)) return json(res, 400, { error: 'На воскресенье расписания нет' });
    const state = readState();
    const type = input.type;
    if (type === 'working_day') {
      const before = state.scheduleChanges.length;
      state.scheduleChanges = state.scheduleChanges.filter(entry => !(entry.type === 'day_off' && entry.date === input.date));
      if (state.scheduleChanges.length !== before) writeState(state);
      return json(res, 200, { ok: true, removed: before - state.scheduleChanges.length });
    }
    if (type === 'day_off') {
      let dayOff = state.scheduleChanges.find(entry => entry.type === 'day_off' && entry.date === input.date);
      if (!dayOff) {
        dayOff = { id: `day-off-${Date.now()}` };
        state.scheduleChanges.push(dayOff);
      }
      Object.assign(dayOff, { date: input.date, day, lesson: null, type: 'day_off', from: '', to: '', teacher: '', note: String(input.note || 'Дополнительный выходной').slice(0, 200) });
      writeState(state);
      return json(res, 201, dayOff);
    }
    if (!['replacement', 'cancelled'].includes(type)) return json(res, 400, { error: 'Неизвестный тип изменения' });
    const lesson = Number(input.lesson);
    const scheduleDay = state.schedule.find(entry => entry.day === day);
    if (!scheduleDay || !Number.isInteger(lesson) || lesson < 1 || lesson > scheduleDay.lessons.length) return json(res, 400, { error: 'Такого урока нет в расписании' });
    if (type === 'replacement' && !String(input.to || '').trim()) return json(res, 400, { error: 'Выберите новый предмет' });
    let change = state.scheduleChanges.find(entry => entry.date === input.date && Number(entry.lesson) === lesson && entry.type !== 'day_off');
    if (!change) {
      change = { id: `change-${Date.now()}` };
      state.scheduleChanges.push(change);
    }
    Object.assign(change, {
      date: input.date,
      day,
      lesson,
      type,
      from: input.from || '',
      to: input.to || '',
      teacher: input.teacher || '',
      note: input.note || ''
    });
    writeState(state);
    return json(res, 201, change);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/coordinate') {
    if (!requireAdmin(req, res)) return;
    const input = await bodyFrom(req);
    const map = input.map === 'teachers' ? 'teachers' : input.map === 'subjects' ? 'subjects' : null;
    if (!map || !String(input.name || '').trim()) return json(res, 400, { error: 'Укажите карту и название точки' });
    const state = readState();
    const points = state.coordinates[map];
    let point = points.find(entry => entry.id === input.id || entry.name === input.name);
    if (!point) {
      point = {
        id: `${map === 'subjects' ? 's' : 't'}-${Date.now()}`,
        name: String(input.name).trim().slice(0, 100),
        x: 0,
        y: 0,
        color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#7c5cff',
        description: ''
      };
      points.push(point);
    }
    point.x = Math.max(-20, Math.min(20, Math.round(Number(input.x) || 0)));
    point.y = Math.max(-20, Math.min(20, Math.round(Number(input.y) || 0)));
    if (input.description !== undefined) point.description = String(input.description).slice(0, 800);
    writeState(state);
    return json(res, 200, point);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/supply-recommendation') {
    if (!requireAdmin(req, res)) return;
    const input = await bodyFrom(req);
    setSupplyRecommendation(Number(input.id), input.recommended, input.necessity);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'API-метод не найден' });
}

function staticFile(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' && url.searchParams.get('release') === '1') {
      res.writeHead(302, {
        Location: '/?release=2.4',
        'Cache-Control': 'no-store, max-age=0',
        'Clear-Site-Data': '"cache"'
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: error.message || 'Ошибка сервера' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Алегьери v2 запущен: http://localhost:${PORT}`);
  console.log('Для устройств в одной сети используйте IP этого компьютера и тот же порт.');
});
