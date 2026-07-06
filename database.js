import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';

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
    period_count INTEGER DEFAULT 2,
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
  CREATE TABLE IF NOT EXISTS shift_reminder_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    send_time TEXT NOT NULL DEFAULT '09:00',
    body_work TEXT NOT NULL,
    body_off TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    last_sent_date TEXT
  );
  CREATE TABLE IF NOT EXISTS attendance_checkins (
    id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    check_date TEXT NOT NULL,
    checked_in_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(captain_id, check_date)
  );
  CREATE TABLE IF NOT EXISTS finance_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    company_commission_rate REAL DEFAULT 20
  );
  CREATE TABLE IF NOT EXISTS finance_stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS captain_finances (
    captain_id TEXT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
    transfers_debts REAL DEFAULT 0,
    rent REAL DEFAULT 0,
    total_commission REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS captain_store_invoices (
    id TEXT PRIMARY KEY,
    captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES finance_stores(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(captain_id, store_id)
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

  await addColumn(
    'ALTER TABLE shifts ADD COLUMN period_count INTEGER DEFAULT 2',
    'ALTER TABLE shifts ADD COLUMN period_count TINYINT DEFAULT 2'
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

export async function migrateShiftReminderTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS shift_reminder_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      send_time TEXT NOT NULL DEFAULT '09:00',
      body_work TEXT NOT NULL,
      body_off TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      last_sent_date TEXT
    )
  `;
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS shift_reminder_config (
        id INT PRIMARY KEY DEFAULT 1,
        send_time VARCHAR(5) NOT NULL DEFAULT '09:00',
        body_work TEXT NOT NULL,
        body_off TEXT NOT NULL,
        is_active TINYINT DEFAULT 0,
        last_sent_date VARCHAR(10) NULL
      )
    `);
  } else {
    sqlite.exec(sql);
  }
}

export async function migrateAttendanceTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS attendance_checkins (
      id TEXT PRIMARY KEY,
      captain_id TEXT NOT NULL,
      check_date TEXT NOT NULL,
      checked_in_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(captain_id, check_date)
    )
  `;
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS attendance_checkins (
        id VARCHAR(36) PRIMARY KEY,
        captain_id VARCHAR(36) NOT NULL,
        check_date VARCHAR(10) NOT NULL,
        checked_in_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_captain_date (captain_id, check_date),
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
      )
    `);
  } else {
    sqlite.exec(sql);
  }
}

export async function migrateFinanceTables() {
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS finance_config (
        id INT PRIMARY KEY DEFAULT 1,
        company_commission_rate DECIMAL(5,2) DEFAULT 20
      )
    `);
    await execute(`
      CREATE TABLE IF NOT EXISTS finance_stores (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await execute(`
      CREATE TABLE IF NOT EXISTS captain_finances (
        captain_id VARCHAR(36) PRIMARY KEY,
        transfers_debts DECIMAL(12,2) DEFAULT 0,
        rent DECIMAL(12,2) DEFAULT 0,
        total_commission DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
      )
    `);
    await execute(`
      CREATE TABLE IF NOT EXISTS captain_store_invoices (
        id VARCHAR(36) PRIMARY KEY,
        captain_id VARCHAR(36) NOT NULL,
        store_id VARCHAR(36) NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_captain_store (captain_id, store_id),
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES finance_stores(id) ON DELETE CASCADE
      )
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS finance_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        company_commission_rate REAL DEFAULT 20
      );
      CREATE TABLE IF NOT EXISTS finance_stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS captain_finances (
        captain_id TEXT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
        transfers_debts REAL DEFAULT 0,
        rent REAL DEFAULT 0,
        total_commission REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS captain_store_invoices (
        id TEXT PRIMARY KEY,
        captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
        store_id TEXT NOT NULL REFERENCES finance_stores(id) ON DELETE CASCADE,
        amount REAL NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(captain_id, store_id)
      );
    `);
  }

  const cfg = await queryOne('SELECT id FROM finance_config WHERE id = 1');
  if (!cfg) {
    await execute('INSERT INTO finance_config (id, company_commission_rate) VALUES (1, 20)', []);
  }
}

export async function migrateFinanceVouchersTable() {
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS finance_vouchers (
        id VARCHAR(36) PRIMARY KEY,
        captain_id VARCHAR(36) NOT NULL,
        voucher_type VARCHAR(20) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        note VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
      )
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS finance_vouchers (
        id TEXT PRIMARY KEY,
        captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
        voucher_type TEXT NOT NULL CHECK(voucher_type IN ('disbursement', 'receipt')),
        amount REAL NOT NULL,
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }
}

export async function migrateFinanceInvoicePostingsTable() {
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS finance_invoice_postings (
        id VARCHAR(36) PRIMARY KEY,
        captain_id VARCHAR(36) NOT NULL UNIQUE,
        total_invoices DECIMAL(12,2) NOT NULL DEFAULT 0,
        transfers_debts DECIMAL(12,2) NOT NULL DEFAULT 0,
        posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
      )
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS finance_invoice_postings (
        id TEXT PRIMARY KEY,
        captain_id TEXT NOT NULL UNIQUE REFERENCES captains(id) ON DELETE CASCADE,
        total_invoices REAL NOT NULL DEFAULT 0,
        transfers_debts REAL NOT NULL DEFAULT 0,
        posted_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  const rows = await queryAll(`
    SELECT cf.captain_id, cf.transfers_debts,
      COALESCE(SUM(i.amount), 0) AS total_invoices
    FROM captain_finances cf
    LEFT JOIN captain_store_invoices i ON i.captain_id = cf.captain_id
    GROUP BY cf.captain_id, cf.transfers_debts
    HAVING total_invoices > 0 OR cf.transfers_debts > 0
  `);

  for (const row of rows) {
    const exists = await queryOne(
      'SELECT id FROM finance_invoice_postings WHERE captain_id = ?',
      [row.captain_id]
    );
    if (!exists) {
      await execute(
        'INSERT INTO finance_invoice_postings (id, captain_id, total_invoices, transfers_debts) VALUES (?, ?, ?, ?)',
        [uuid(), row.captain_id, row.total_invoices, row.transfers_debts]
      );
    }
  }
}

export async function migrateFinanceInvoiceSalesDateColumn() {
  if (isMySQL) {
    const cols = await queryAll("SHOW COLUMNS FROM finance_invoice_postings LIKE 'sales_date'");
    if (!cols.length) {
      await execute('ALTER TABLE finance_invoice_postings ADD COLUMN sales_date VARCHAR(10) NULL');
    }
  } else {
    const cols = sqlite.prepare('PRAGMA table_info(finance_invoice_postings)').all();
    if (!cols.some(c => c.name === 'sales_date')) {
      sqlite.exec('ALTER TABLE finance_invoice_postings ADD COLUMN sales_date TEXT');
    }
  }

  const rows = await queryAll(
    'SELECT id, posted_at, sales_date FROM finance_invoice_postings WHERE sales_date IS NULL OR sales_date = ?',
    ['']
  );
  for (const row of rows) {
    const raw = String(row.posted_at || '');
    const salesDate = raw.slice(0, 10) || new Date().toISOString().slice(0, 10);
    await execute('UPDATE finance_invoice_postings SET sales_date = ? WHERE id = ?', [salesDate, row.id]);
  }
}

export async function migrateFinanceCommissionPostingsTable() {
  if (isMySQL) {
    await execute(`
      CREATE TABLE IF NOT EXISTS finance_commission_postings (
        id VARCHAR(36) PRIMARY KEY,
        captain_id VARCHAR(36) NOT NULL UNIQUE,
        total_commission DECIMAL(12,2) NOT NULL DEFAULT 0,
        rent DECIMAL(12,2) NOT NULL DEFAULT 0,
        posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE
      )
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS finance_commission_postings (
        id TEXT PRIMARY KEY,
        captain_id TEXT NOT NULL UNIQUE REFERENCES captains(id) ON DELETE CASCADE,
        total_commission REAL NOT NULL DEFAULT 0,
        rent REAL NOT NULL DEFAULT 0,
        posted_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  const rows = await queryAll(`
    SELECT captain_id, total_commission, rent
    FROM captain_finances
    WHERE total_commission > 0 OR rent > 0
  `);

  for (const row of rows) {
    const exists = await queryOne(
      'SELECT id FROM finance_commission_postings WHERE captain_id = ?',
      [row.captain_id]
    );
    if (!exists) {
      await execute(
        'INSERT INTO finance_commission_postings (id, captain_id, total_commission, rent) VALUES (?, ?, ?, ?)',
        [uuid(), row.captain_id, row.total_commission, row.rent]
      );
    }
  }
}

export async function migrateFinanceCommissionSalesDateColumn() {
  if (isMySQL) {
    const cols = await queryAll("SHOW COLUMNS FROM finance_commission_postings LIKE 'sales_date'");
    if (!cols.length) {
      await execute('ALTER TABLE finance_commission_postings ADD COLUMN sales_date VARCHAR(10) NULL');
    }
  } else {
    const cols = sqlite.prepare('PRAGMA table_info(finance_commission_postings)').all();
    if (!cols.some(c => c.name === 'sales_date')) {
      sqlite.exec('ALTER TABLE finance_commission_postings ADD COLUMN sales_date TEXT');
    }
  }

  const rows = await queryAll(
    'SELECT id, posted_at, sales_date FROM finance_commission_postings WHERE sales_date IS NULL OR sales_date = ?',
    ['']
  );
  for (const row of rows) {
    const salesDate = String(row.posted_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    await execute('UPDATE finance_commission_postings SET sales_date = ? WHERE id = ?', [salesDate, row.id]);
  }
}

export async function migrateFinanceInvoicePerDate() {
  const today = new Date().toISOString().slice(0, 10);

  if (isMySQL) {
    const invoiceCols = await queryAll("SHOW COLUMNS FROM captain_store_invoices LIKE 'sales_date'");
    if (!invoiceCols.length) {
      await execute('ALTER TABLE captain_store_invoices ADD COLUMN sales_date VARCHAR(10) NULL');
    }
  } else {
    const invoiceCols = sqlite.prepare('PRAGMA table_info(captain_store_invoices)').all();
    if (!invoiceCols.some(c => c.name === 'sales_date')) {
      sqlite.exec('ALTER TABLE captain_store_invoices ADD COLUMN sales_date TEXT');
    }
  }

  const postingDateRows = await queryAll(
    'SELECT id, posted_at, sales_date FROM finance_invoice_postings WHERE sales_date IS NULL OR sales_date = ?',
    ['']
  );
  for (const row of postingDateRows) {
    const salesDate = String(row.posted_at || '').slice(0, 10) || today;
    await execute('UPDATE finance_invoice_postings SET sales_date = ? WHERE id = ?', [salesDate, row.id]);
  }

  const invoiceRows = await queryAll(
    'SELECT id, captain_id FROM captain_store_invoices WHERE sales_date IS NULL OR sales_date = ?',
    ['']
  );
  for (const row of invoiceRows) {
    const posting = await queryOne(
      'SELECT sales_date, posted_at FROM finance_invoice_postings WHERE captain_id = ? ORDER BY posted_at DESC LIMIT 1',
      [row.captain_id]
    );
    const salesDate = posting?.sales_date || String(posting?.posted_at || '').slice(0, 10) || today;
    await execute('UPDATE captain_store_invoices SET sales_date = ? WHERE id = ?', [salesDate, row.id]);
  }

  if (isMySQL) {
    async function dropForeignKeys(table, column) {
      const fkRows = await queryAll(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [table, column]);
      for (const fk of fkRows) {
        await execute(`ALTER TABLE ${table} DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
      }
      return fkRows.length > 0;
    }

    async function foreignKeyExists(table, column) {
      const fkRows = await queryAll(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [table, column]);
      return fkRows.length > 0;
    }

    const uniqPosting = await queryAll(
      'SHOW INDEX FROM finance_invoice_postings WHERE Key_name = ?',
      ['uniq_captain_invoice_sales_date']
    );
    if (!uniqPosting.length) {
      const uniqueCaptain = await queryAll(
        'SHOW INDEX FROM finance_invoice_postings WHERE Key_name = ? AND Non_unique = 0',
        ['captain_id']
      );
      if (uniqueCaptain.length) {
        await dropForeignKeys('finance_invoice_postings', 'captain_id');
        await execute('ALTER TABLE finance_invoice_postings DROP INDEX captain_id');
      }
      await execute(
        'ALTER TABLE finance_invoice_postings ADD UNIQUE KEY uniq_captain_invoice_sales_date (captain_id, sales_date)'
      );
      if (!(await foreignKeyExists('finance_invoice_postings', 'captain_id'))) {
        await execute(
          'ALTER TABLE finance_invoice_postings ADD CONSTRAINT fk_invoice_postings_captain FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE'
        );
      }
    }

    const uniqStoreDate = await queryAll(
      'SHOW INDEX FROM captain_store_invoices WHERE Key_name = ?',
      ['uniq_captain_store_date']
    );
    if (!uniqStoreDate.length) {
      const storeIndexes = await queryAll(
        'SHOW INDEX FROM captain_store_invoices WHERE Key_name = ?',
        ['uniq_captain_store']
      );
      if (storeIndexes.length) {
        await dropForeignKeys('captain_store_invoices', 'captain_id');
        await dropForeignKeys('captain_store_invoices', 'store_id');
        await execute('ALTER TABLE captain_store_invoices DROP INDEX uniq_captain_store');
      }
      await execute(
        'ALTER TABLE captain_store_invoices ADD UNIQUE KEY uniq_captain_store_date (captain_id, store_id, sales_date)'
      );
      if (!(await foreignKeyExists('captain_store_invoices', 'captain_id'))) {
        await execute(
          'ALTER TABLE captain_store_invoices ADD CONSTRAINT fk_store_invoices_captain FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE'
        );
      }
      if (!(await foreignKeyExists('captain_store_invoices', 'store_id'))) {
        await execute(
          'ALTER TABLE captain_store_invoices ADD CONSTRAINT fk_store_invoices_store FOREIGN KEY (store_id) REFERENCES finance_stores(id) ON DELETE CASCADE'
        );
      }
    }
  } else {
    const postingIndexes = sqlite.prepare('PRAGMA index_list(finance_invoice_postings)').all();
    if (postingIndexes.some(i => i.unique)) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS finance_invoice_postings_new (
          id TEXT PRIMARY KEY,
          captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
          total_invoices REAL NOT NULL DEFAULT 0,
          transfers_debts REAL NOT NULL DEFAULT 0,
          sales_date TEXT NOT NULL,
          posted_at TEXT DEFAULT (datetime('now')),
          UNIQUE(captain_id, sales_date)
        );
        INSERT INTO finance_invoice_postings_new (id, captain_id, total_invoices, transfers_debts, sales_date, posted_at)
        SELECT id, captain_id, total_invoices, transfers_debts,
          COALESCE(NULLIF(sales_date, ''), substr(posted_at, 1, 10)),
          posted_at
        FROM finance_invoice_postings;
        DROP TABLE finance_invoice_postings;
        ALTER TABLE finance_invoice_postings_new RENAME TO finance_invoice_postings;
      `);
    }

    const storeIndexes = sqlite.prepare('PRAGMA index_list(captain_store_invoices)').all();
    if (storeIndexes.some(i => i.unique)) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS captain_store_invoices_new (
          id TEXT PRIMARY KEY,
          captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
          store_id TEXT NOT NULL REFERENCES finance_stores(id) ON DELETE CASCADE,
          amount REAL NOT NULL DEFAULT 0,
          sales_date TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(captain_id, store_id, sales_date)
        );
        INSERT INTO captain_store_invoices_new (id, captain_id, store_id, amount, sales_date, created_at)
        SELECT id, captain_id, store_id, amount,
          COALESCE(NULLIF(sales_date, ''), '${today}'),
          created_at
        FROM captain_store_invoices;
        DROP TABLE captain_store_invoices;
        ALTER TABLE captain_store_invoices_new RENAME TO captain_store_invoices;
      `);
    }
  }
}

export async function migrateFinanceCommissionPerDate() {
  const today = new Date().toISOString().slice(0, 10);

  const postingDateRows = await queryAll(
    'SELECT id, posted_at, sales_date FROM finance_commission_postings WHERE sales_date IS NULL OR sales_date = ?',
    ['']
  );
  for (const row of postingDateRows) {
    const salesDate = String(row.posted_at || '').slice(0, 10) || today;
    await execute('UPDATE finance_commission_postings SET sales_date = ? WHERE id = ?', [salesDate, row.id]);
  }

  if (isMySQL) {
    async function dropForeignKeys(table, column) {
      const fkRows = await queryAll(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [table, column]);
      for (const fk of fkRows) {
        await execute(`ALTER TABLE ${table} DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
      }
    }

    async function foreignKeyExists(table, column) {
      const fkRows = await queryAll(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [table, column]);
      return fkRows.length > 0;
    }

    const uniqPosting = await queryAll(
      'SHOW INDEX FROM finance_commission_postings WHERE Key_name = ?',
      ['uniq_captain_commission_sales_date']
    );
    if (!uniqPosting.length) {
      const uniqueCaptain = await queryAll(
        'SHOW INDEX FROM finance_commission_postings WHERE Key_name = ? AND Non_unique = 0',
        ['captain_id']
      );
      if (uniqueCaptain.length) {
        await dropForeignKeys('finance_commission_postings', 'captain_id');
        await execute('ALTER TABLE finance_commission_postings DROP INDEX captain_id');
      }
      await execute(
        'ALTER TABLE finance_commission_postings ADD UNIQUE KEY uniq_captain_commission_sales_date (captain_id, sales_date)'
      );
      if (!(await foreignKeyExists('finance_commission_postings', 'captain_id'))) {
        await execute(
          'ALTER TABLE finance_commission_postings ADD CONSTRAINT fk_commission_postings_captain FOREIGN KEY (captain_id) REFERENCES captains(id) ON DELETE CASCADE'
        );
      }
    }
  } else {
    const postingIndexes = sqlite.prepare('PRAGMA index_list(finance_commission_postings)').all();
    if (postingIndexes.some(i => i.unique)) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS finance_commission_postings_new (
          id TEXT PRIMARY KEY,
          captain_id TEXT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
          total_commission REAL NOT NULL DEFAULT 0,
          rent REAL NOT NULL DEFAULT 0,
          sales_date TEXT NOT NULL,
          posted_at TEXT DEFAULT (datetime('now')),
          UNIQUE(captain_id, sales_date)
        );
        INSERT INTO finance_commission_postings_new (id, captain_id, total_commission, rent, sales_date, posted_at)
        SELECT id, captain_id, total_commission, rent,
          COALESCE(NULLIF(sales_date, ''), substr(posted_at, 1, 10)),
          posted_at
        FROM finance_commission_postings;
        DROP TABLE finance_commission_postings;
        ALTER TABLE finance_commission_postings_new RENAME TO finance_commission_postings;
      `);
    }
  }
}

export async function migrateFinanceVoucherDateColumn() {
  if (isMySQL) {
    const cols = await queryAll("SHOW COLUMNS FROM finance_vouchers LIKE 'voucher_date'");
    if (!cols.length) {
      await execute('ALTER TABLE finance_vouchers ADD COLUMN voucher_date VARCHAR(10) NULL');
    }
  } else {
    const cols = sqlite.prepare('PRAGMA table_info(finance_vouchers)').all();
    if (!cols.some(c => c.name === 'voucher_date')) {
      sqlite.exec('ALTER TABLE finance_vouchers ADD COLUMN voucher_date TEXT');
    }
  }

  const rows = await queryAll(
    'SELECT id, created_at, voucher_date FROM finance_vouchers WHERE voucher_date IS NULL OR voucher_date = ?',
    ['']
  );
  for (const row of rows) {
    const voucherDate = String(row.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    await execute('UPDATE finance_vouchers SET voucher_date = ? WHERE id = ?', [voucherDate, row.id]);
  }
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
