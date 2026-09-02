const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.ALEGIERI_DB || path.join(__dirname, 'data', 'alegieri.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supply_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    subject TEXT,
    icon TEXT NOT NULL DEFAULT '▤',
    unit TEXT NOT NULL DEFAULT 'шт.',
    recommended_count INTEGER,
    necessity TEXT NOT NULL DEFAULT 'not_set' CHECK (necessity IN ('not_set', 'optional', 'recommended', 'required')),
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS user_supplies (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    supply_id INTEGER NOT NULL REFERENCES supply_definitions(id) ON DELETE CASCADE,
    current_count INTEGER NOT NULL DEFAULT 0 CHECK (current_count >= 0),
    PRIMARY KEY (user_id, supply_id)
  );
`);

function seedState() {
  const exists = db.prepare('SELECT 1 FROM app_state WHERE id = 1').get();
  if (exists) return;
  const seedPath = path.join(__dirname, 'data', 'state.json');
  const state = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  db.prepare('INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify(state), new Date().toISOString());
}

function migrateState() {
  const state = readState();
  let changed = false;
  if (!Array.isArray(state.holidays) || state.holidays.length === 0) {
    state.holidays = [
      { id: 'autumn-2026', name: 'Осенние каникулы', start: '2026-10-26', end: '2026-11-03' },
      { id: 'winter-2026', name: 'Зимние каникулы', start: '2026-12-31', end: '2027-01-10' },
      { id: 'spring-2027', name: 'Весенние каникулы', start: '2027-03-27', end: '2027-04-04' },
      { id: 'summer-2027', name: 'Летние каникулы', start: '2027-05-26', end: null }
    ];
    changed = true;
  }
  for (const day of state.schedule || []) {
    day.lessons = day.lessons.map(subject => {
      if (subject === 'Английский язык (Разговорный практикум)') {
        changed = true;
        return 'Английский язык (Р)';
      }
      return subject;
    });
  }
  if (state.meta?.version !== 2) {
    state.meta.version = 2;
    changed = true;
  }
  if (changed) writeState(state);
}

function readState() {
  const row = db.prepare('SELECT json FROM app_state WHERE id = 1').get();
  return JSON.parse(row.json);
}

function writeState(state) {
  state.meta.updatedAt = new Date().toISOString();
  db.prepare('UPDATE app_state SET json = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(state), state.meta.updatedAt);
}

function isNotebookSubject(subject) {
  const value = subject.toLocaleLowerCase('ru-RU');
  return !value.includes('разговор')
    && !value.includes('(р)')
    && !value.startsWith('вд ')
    && value !== 'вд'
    && value !== 'физкультура';
}

function syncSupplyCatalog() {
  const state = readState();
  const subjects = [...new Set(state.schedule.flatMap(day => day.lessons))].filter(isNotebookSubject);
  const insert = db.prepare(`
    INSERT INTO supply_definitions (item_key, name, subject, icon, unit, sort_order)
    VALUES (?, ?, ?, ?, 'шт.', ?)
    ON CONFLICT(item_key) DO UPDATE SET name = excluded.name, subject = excluded.subject, sort_order = excluded.sort_order
  `);
  let order = 0;
  for (const subject of subjects) {
    insert.run(`notebook:${subject}`, `Тетрадь — ${subject}`, subject, '▤', order++);
  }
  const generic = [
    ['pens', 'Ручки', '✎'],
    ['pencils', 'Карандаши', '✐'],
    ['ruler', 'Линейка', '╱'],
    ['covers', 'Обложки', '▱']
  ];
  for (const [key, name, icon] of generic) insert.run(key, name, null, icon, order++);
}

function normalizeUsername(username) {
  return String(username || '').trim().toLocaleLowerCase('ru-RU');
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}

function createUser({ username, password, displayName, role = 'student' }) {
  const normalized = normalizeUsername(username);
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_.-]{3,32}$/.test(normalized)) throw new Error('Логин: 3–32 символа, буквы, цифры, точка, дефис или подчёркивание');
  if (String(password || '').length < 8) throw new Error('Пароль должен содержать не менее 8 символов');
  const cleanName = String(displayName || username).trim().slice(0, 60);
  if (!cleanName) throw new Error('Укажите имя');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = passwordDigest(password, salt);
  const result = db.prepare(`INSERT INTO users (username, display_name, password_hash, password_salt, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(normalized, cleanName, passwordHash, salt, role, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), username: normalized, displayName: cleanName, role };
}

function upsertAdmin(username, password) {
  const normalized = normalizeUsername(username);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalized);
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = passwordDigest(password, salt);
  if (existing) {
    db.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, role = 'admin', display_name = 'Администратор' WHERE id = ?`)
      .run(passwordHash, salt, existing.id);
    return existing.id;
  }
  return createUser({ username: normalized, password, displayName: 'Администратор', role: 'admin' }).id;
}

function authenticate(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));
  if (!row) return null;
  const calculated = Buffer.from(passwordDigest(String(password || ''), row.password_salt), 'hex');
  const expected = Buffer.from(row.password_hash, 'hex');
  if (calculated.length !== expected.length || !crypto.timingSafeEqual(calculated, expected)) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hash, userId, expires.toISOString(), now.toISOString());
  return { token, expires };
}

function userFromToken(token) {
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash, new Date().toISOString());
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role } : null;
}

function deleteSession(token) {
  if (!token) return;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
}

function getSupplies(userId) {
  return db.prepare(`SELECT d.id, d.item_key AS itemKey, d.name, d.subject, d.icon, d.unit,
      d.recommended_count AS recommended, d.necessity, COALESCE(u.current_count, 0) AS current
    FROM supply_definitions d
    LEFT JOIN user_supplies u ON u.supply_id = d.id AND u.user_id = ?
    ORDER BY d.sort_order, d.id`).all(userId);
}

function setSupplyCount(userId, supplyId, count) {
  const safeCount = Math.max(0, Math.min(99, Math.round(Number(count) || 0)));
  db.prepare(`INSERT INTO user_supplies (user_id, supply_id, current_count) VALUES (?, ?, ?)
    ON CONFLICT(user_id, supply_id) DO UPDATE SET current_count = excluded.current_count`)
    .run(userId, supplyId, safeCount);
  return safeCount;
}

function setSupplyRecommendation(supplyId, recommended, necessity) {
  const count = recommended === null || recommended === '' ? null : Math.max(0, Math.min(99, Math.round(Number(recommended) || 0)));
  const level = ['not_set', 'optional', 'recommended', 'required'].includes(necessity) ? necessity : 'not_set';
  const result = db.prepare('UPDATE supply_definitions SET recommended_count = ?, necessity = ? WHERE id = ?')
    .run(count, level, supplyId);
  if (!result.changes) throw new Error('Принадлежность не найдена');
}

seedState();
migrateState();
syncSupplyCatalog();

module.exports = {
  dbPath, readState, writeState, createUser, upsertAdmin, authenticate,
  createSession, userFromToken, deleteSession, getSupplies, setSupplyCount,
  setSupplyRecommendation, syncSupplyCatalog
};
