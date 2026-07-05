import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const isMySQL = Boolean(
  process.env.MYSQL_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  process.env.MYSQLHOST
);

let pool = null;
let sqlite = null;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS captains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    captain_number TEXT NOT NULL UNIQUE,
    username TEXT UNIQUE,
    photo TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    period1_end TEXT DEFAULT '12:00',
    break_hours REAL DEFAULT 2,
    break_minutes INTEGER DEFAULT 120,
    period2_start TEXT DEFAULT '14:00',
    is_active INTEGER DEFAULT 1,
    UNIQUE(captain_id, day_of_week)
  );
  CREATE TABLE IF NOT EXISTS sms_messages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    captain_id TEXT REFERENCES captains(id) ON DELETE SET NULL,
    scheduled_at TEXT NOT NULL,
    repeat_type TEXT DEFAULT 'once' CHECK(repeat_type IN ('once', 'daily', 'weekly')),
    is_active INTEGER DEFAULT 1,
    last_sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sms_log (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES sms_messages(id) ON DELETE SET NULL,
    captain_id TEXT REFERENCES captains(id) ON DELETE SET NULL,
    captain_name TEXT,
    captain_phone TEXT,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'sent' CHECK(status IN ('pending', 'sent', 'delivered', 'failed')),
    sent_at TEXT DEFAULT (datetime('now')),
    source TEXT DEFAULT 'gateway'
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    role TEXT DEFAULT 'employee' CHECK(role IN ('admin', 'manager', 'employee')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    photo TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sms_queue (
    id TEXT PRIMARY KEY,
    recipient_phone TEXT NOT NULL,
    message TEXT NOT NULL,
    message_id TEXT REFERENCES sms_messages(id) ON DELETE SET NULL,
    captain_id TEXT REFERENCES captains(id) ON DELETE SET NULL,
    captain_name TEXT,
    sms_type TEXT DEFAULT 'shift',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sms_gateway_heartbeat (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_seen_at TEXT DEFAULT (datetime('now'))
  );
`;

const SCHEMA_MYSQL = fs.readFileSync(path.join(__dirname, 'schema.mysql.sql'), 'utf8');

function getMySQLHostConfig() {
  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'railway',
    ssl: process.env.MYSQLSSL === 'false' ? undefined : { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
  };
}

function getMySQLConnectionCandidates() {
  const candidates = [];
  const add = (label, config) => candidates.push({ label, config });

  if (process.env.MYSQL_URL) add('MYSQL_URL', process.env.MYSQL_URL);
  if (process.env.DATABASE_URL?.startsWith('mysql')) add('DATABASE_URL', process.env.DATABASE_URL);
  // Public TCP proxy — works when internal DNS (mysql.railway.internal) is unreachable
  if (process.env.MYSQL_PUBLIC_URL) add('MYSQL_PUBLIC_URL', process.env.MYSQL_PUBLIC_URL);
  if (process.env.MYSQLHOST || process.env.MYSQL_HOST) add('MYSQLHOST', getMySQLHostConfig());

  return candidates;
}

async function connectMySQL() {
  const candidates = getMySQLConnectionCandidates();
  if (!candidates.length) {
    throw new Error('MySQL env vars missing. Link MySQL service to Backend in Railway → Variables → Add Reference.');
  }

  const errors = [];
  for (const { label, config } of candidates) {
    try {
      const nextPool = mysql.createPool(config);
      await nextPool.execute('SELECT 1');
      console.log(`✅ MySQL connected via ${label}`);
      return nextPool;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.warn(`⚠️ MySQL ${label} failed (${err.code}), trying next...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not connect to MySQL. ${errors.join(' | ')}. ` +
    'In Railway: open Backend → Variables → Add Reference → select MySQL service, then redeploy.'
  );
}

export async function initDb() {
  if (isMySQL) {
    pool = await connectMySQL();
    const statements = SCHEMA_MYSQL.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await pool.execute(stmt);
    }
    console.log('✅ MySQL tables ready');
    return;
  }

  const dbPath = path.join(__dirname, 'data', 'captain.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA_SQLITE);
  console.log('✅ SQLite connected —', dbPath);
}

/** تحويل ISO/Date إلى صيغة MySQL: YYYY-MM-DD HH:MM:SS */
export function toDbDateTime(value) {
  if (!value) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return String(value).replace('T', ' ').replace(/\.\d{3}Z?$/, '').replace(/Z$/, '');
  }
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function toTimestamp(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const raw = String(value);
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T')).getTime();
}

export async function queryAll(sql, params = []) {
  if (isMySQL) {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }
  return sqlite.prepare(sql).all(...params);
}

export async function queryOne(sql, params = []) {
  if (isMySQL) {
    const [rows] = await pool.execute(sql, params);
    return rows[0] || null;
  }
  return sqlite.prepare(sql).get(...params) || null;
}

export async function execute(sql, params = []) {
  if (isMySQL) {
    const [result] = await pool.execute(sql, params);
    return result;
  }
  return sqlite.prepare(sql).run(...params);
}

export async function migrateCaptainPasswordColumn() {
  if (isMySQL) return;
  const cols = sqlite.prepare('PRAGMA table_info(captains)').all();
  if (!cols.some(c => c.name === 'password_hash')) {
    sqlite.exec('ALTER TABLE captains ADD COLUMN password_hash TEXT DEFAULT ""');
  }
}

export async function migrateShiftPeriodColumns() {
  const addColumn = async (sqliteSql, mysqlSql) => {
    if (isMySQL) {
      try { await execute(mysqlSql); } catch (_) { /* column may exist */ }
    } else {
      try { sqlite.exec(sqliteSql); } catch (_) { /* column may exist */ }
    }
  };

  await addColumn(
    "ALTER TABLE shifts ADD COLUMN period1_end TEXT DEFAULT '12:00'",
    "ALTER TABLE shifts ADD COLUMN period1_end VARCHAR(10) DEFAULT '12:00'"
  );
  await addColumn(
    'ALTER TABLE shifts ADD COLUMN break_hours REAL DEFAULT 2',
    'ALTER TABLE shifts ADD COLUMN break_hours DECIMAL(4,1) DEFAULT 2'
  );
  await addColumn(
    "ALTER TABLE shifts ADD COLUMN period2_start TEXT DEFAULT '14:00'",
    "ALTER TABLE shifts ADD COLUMN period2_start VARCHAR(10) DEFAULT '14:00'"
  );

  await addColumn(
    'ALTER TABLE shifts ADD COLUMN break_minutes INTEGER DEFAULT 120',
    'ALTER TABLE shifts ADD COLUMN break_minutes INT DEFAULT 120'
  );

  await execute(`
    UPDATE shifts SET
      period1_end = COALESCE(NULLIF(period1_end, ''), '12:00'),
      break_hours = COALESCE(break_hours, 2),
      break_minutes = COALESCE(break_minutes, ROUND(COALESCE(break_hours, 2) * 60)),
      period2_start = COALESCE(NULLIF(period2_start, ''), '14:00')
    WHERE period1_end IS NULL OR period1_end = ''
       OR break_hours IS NULL
       OR break_minutes IS NULL
       OR period2_start IS NULL OR period2_start = ''
  `);
}

export async function migrateCaptainUsernameColumn() {
  if (isMySQL) {
    const cols = await queryAll("SHOW COLUMNS FROM captains LIKE 'username'");
    if (!cols.length) {
      await execute('ALTER TABLE captains ADD COLUMN username VARCHAR(50) NULL UNIQUE');
    }
  } else {
    const cols = sqlite.prepare('PRAGMA table_info(captains)').all();
    if (!cols.some(c => c.name === 'username')) {
      sqlite.exec('ALTER TABLE captains ADD COLUMN username TEXT UNIQUE');
    }
  }

  const rows = await queryAll(
    "SELECT id, captain_number, username FROM captains WHERE username IS NULL OR username = ''"
  );
  for (const row of rows) {
    if (row.captain_number) {
      await execute('UPDATE captains SET username = ? WHERE id = ?', [
        String(row.captain_number).trim().toLowerCase(),
        row.id
      ]);
    }
  }
}

export function getDbType() {
  return isMySQL ? 'mysql' : 'sqlite';
}

export function nowExpr() {
  return isMySQL ? 'NOW()' : "datetime('now')";
}

export default { initDb, queryAll, queryOne, execute, isMySQL, getDbType, nowExpr };
