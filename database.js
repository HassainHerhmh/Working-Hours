import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const isMySQL = Boolean(
  process.env.MYSQL_URL ||
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

function getMySQLConfig() {
  if (process.env.MYSQL_URL) return process.env.MYSQL_URL;
  if (process.env.DATABASE_URL?.startsWith('mysql')) return process.env.DATABASE_URL;
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

export async function initDb() {
  if (isMySQL) {
    pool = mysql.createPool(getMySQLConfig());
    const statements = SCHEMA_MYSQL.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await pool.execute(stmt);
    }
    console.log('✅ MySQL connected — tables ready');
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

export function getDbType() {
  return isMySQL ? 'mysql' : 'sqlite';
}

export function nowExpr() {
  return isMySQL ? 'NOW()' : "datetime('now')";
}

export default { initDb, queryAll, queryOne, execute, isMySQL, getDbType, nowExpr };
