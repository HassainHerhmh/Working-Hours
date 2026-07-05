import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data', 'captain.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS captains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    captain_number TEXT NOT NULL UNIQUE,
    photo TEXT DEFAULT '',
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
    source TEXT DEFAULT 'simulator'
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
`);

export default db;
