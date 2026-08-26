import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { queryAll, queryOne, execute, isMySQL, toDbDateTime } from './database.js';
import { getYemenNow } from './shiftReminder.service.js';

const gzip = promisify(zlib.gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = __dirname;

function yemenDateKey(d = getYemenNow()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeTime(t) {
  if (!t || typeof t !== 'string') return '';
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (Buffer.isBuffer(val)) return `X'${val.toString('hex')}'`;
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Date) return `'${toDbDateTime(val)}'`;
  return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function quoteTableName(name) {
  return isMySQL ? `\`${name}\`` : `"${name}"`;
}

export function resolveBackupDirectory(configPath) {
  const raw = String(configPath || './backups').trim() || './backups';
  const resolved = path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.resolve(BACKEND_ROOT, raw);
  return resolved;
}

function getAllowedBrowseRoots() {
  const roots = [
    { label: 'مجلد التطبيق', path: path.resolve(BACKEND_ROOT) },
    { label: 'المجلد الأب', path: path.resolve(BACKEND_ROOT, '..') },
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const key = root.path;
    if (seen.has(key) || !fs.existsSync(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPathAllowed(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  return getAllowedBrowseRoots().some((root) => {
    const normalizedRoot = path.resolve(root.path);
    return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

export function toStoredBackupPath(absolutePath) {
  const resolved = path.resolve(String(absolutePath || ''));
  const relative = path.relative(BACKEND_ROOT, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `./${relative.replace(/\\/g, '/')}`;
  }
  return resolved.replace(/\\/g, '/');
}

export async function browseBackupDirectory(inputPath = '') {
  const fallback = resolveBackupDirectory('./backups');
  let target = fallback;

  if (inputPath) {
    target = path.isAbsolute(String(inputPath))
      ? path.normalize(String(inputPath))
      : resolveBackupDirectory(String(inputPath));
  }

  if (!isPathAllowed(target)) {
    throw new Error('المسار غير مسموح');
  }

  let stat = null;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    throw new Error('المجلد غير موجود');
  }
  if (!stat.isDirectory()) {
    throw new Error('المسار المحدد ليس مجلداً');
  }

  const entries = [];
  const dirEntries = await fs.promises.readdir(target, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const fullPath = path.join(target, entry.name);
    if (!isPathAllowed(fullPath)) continue;
    try {
      const entryStat = await fs.promises.stat(fullPath);
      entries.push({
        name: entry.name,
        type: entryStat.isDirectory() ? 'directory' : 'file',
        path: fullPath,
        stored_path: toStoredBackupPath(fullPath),
        size_bytes: entryStat.isFile() ? entryStat.size : null,
      });
    } catch {
      // skip unreadable entries
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'ar');
  });

  const parentPath = path.dirname(target);
  const canCreateFolder = fs.existsSync(target);

  return {
    current_path: target,
    stored_path: toStoredBackupPath(target),
    parent_path: parentPath !== target && isPathAllowed(parentPath) ? parentPath : null,
    parent_stored_path: parentPath !== target && isPathAllowed(parentPath)
      ? toStoredBackupPath(parentPath)
      : null,
    roots: getAllowedBrowseRoots().map((root) => ({
      ...root,
      stored_path: toStoredBackupPath(root.path),
    })),
    can_create_folder: canCreateFolder,
    entries,
  };
}

export async function createBackupFolder(parentPath, folderName) {
  const parent = path.isAbsolute(String(parentPath))
    ? path.normalize(String(parentPath))
    : resolveBackupDirectory(String(parentPath));

  if (!isPathAllowed(parent)) {
    throw new Error('المسار غير مسموح');
  }

  const safeName = String(folderName || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!safeName) throw new Error('اسم المجلد مطلوب');

  const target = path.join(parent, safeName);
  if (!isPathAllowed(target)) {
    throw new Error('لا يمكن إنشاء المجلد في هذا المسار');
  }

  await fs.promises.mkdir(target, { recursive: true });
  return browseBackupDirectory(target);
}

async function listTableNames() {
  if (isMySQL) {
    const rows = await queryAll('SHOW TABLES');
    return rows.map((row) => Object.values(row)[0]).filter(Boolean);
  }
  const rows = await queryAll(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  return rows.map((row) => row.name).filter(Boolean);
}

async function exportDatabaseSql() {
  let sql = `-- Captain Platform Backup\n-- ${new Date().toISOString()}\n-- DB: ${isMySQL ? 'mysql' : 'sqlite'}\n\n`;
  if (isMySQL) sql += 'SET FOREIGN_KEY_CHECKS=0;\n\n';

  const tables = await listTableNames();
  for (const tableName of tables) {
    const quoted = quoteTableName(tableName);

    if (isMySQL) {
      const createRow = await queryOne(`SHOW CREATE TABLE ${quoted}`);
      const createSql = createRow?.['Create Table'] || createRow?.[`Create Table`];
      if (createSql) {
        sql += `DROP TABLE IF EXISTS ${quoted};\n${createSql};\n\n`;
      }
    } else {
      const createRow = await queryOne(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
        [tableName]
      );
      if (createRow?.sql) {
        sql += `DROP TABLE IF EXISTS ${quoted};\n${createRow.sql};\n\n`;
      }
    }

    const rows = await queryAll(`SELECT * FROM ${quoted}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((col) => escapeSqlValue(row[col]));
      const colList = cols.map((col) => quoteTableName(col)).join(', ');
      sql += `INSERT INTO ${quoted} (${colList}) VALUES (${values.join(', ')});\n`;
    }
    if (rows.length) sql += '\n';
  }

  if (isMySQL) sql += 'SET FOREIGN_KEY_CHECKS=1;\n';
  return sql;
}

async function copyIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return false;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
  return true;
}

export async function getBackupConfig() {
  let row = await queryOne('SELECT * FROM backup_config WHERE id = 1');
  if (!row) {
    await execute(
      `INSERT INTO backup_config (id, backup_path, backup_time, is_active, retention_days)
       VALUES (1, './backups', '21:00', 1, 30)`
    );
    row = await queryOne('SELECT * FROM backup_config WHERE id = 1');
  }
  return {
    ...row,
    is_active: Boolean(row.is_active),
    retention_days: Number(row.retention_days || 30),
    resolved_path: resolveBackupDirectory(row.backup_path),
  };
}

export async function saveBackupConfig(data = {}) {
  const existing = await getBackupConfig();
  const backup_path = String(data.backup_path ?? existing.backup_path ?? './backups').trim() || './backups';
  const backup_time = normalizeTime(data.backup_time || existing.backup_time || '21:00');
  const is_active = data.is_active !== undefined ? (data.is_active ? 1 : 0) : (existing.is_active ? 1 : 0);
  const retention_days = Math.min(Math.max(Number(data.retention_days ?? existing.retention_days ?? 30) || 30, 1), 365);

  const targetDir = resolveBackupDirectory(backup_path);
  await fs.promises.mkdir(targetDir, { recursive: true });

  if (isMySQL) {
    await execute(
      `INSERT INTO backup_config (id, backup_path, backup_time, is_active, retention_days)
       VALUES (1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE backup_path = ?, backup_time = ?, is_active = ?, retention_days = ?`,
      [backup_path, backup_time, is_active, retention_days, backup_path, backup_time, is_active, retention_days]
    );
  } else {
    await execute(
      `UPDATE backup_config
       SET backup_path = ?, backup_time = ?, is_active = ?, retention_days = ?
       WHERE id = 1`,
      [backup_path, backup_time, is_active, retention_days]
    );
  }

  return getBackupConfig();
}

async function cleanupOldBackups(backupDir, retentionDays) {
  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^captain-backup-/.test(entry.name)) continue;
    const fullPath = path.join(backupDir, entry.name);
    const stat = await fs.promises.stat(fullPath);
    if (stat.mtimeMs < cutoff) {
      await fs.promises.unlink(fullPath).catch(() => {});
    }
  }
}

export async function listBackupHistory(limit = 20) {
  const config = await getBackupConfig();
  const backupDir = resolveBackupDirectory(config.backup_path);
  if (!fs.existsSync(backupDir)) return [];

  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^captain-backup-/.test(entry.name)) continue;
    const fullPath = path.join(backupDir, entry.name);
    const stat = await fs.promises.stat(fullPath);
    files.push({
      file_name: entry.name,
      file_path: fullPath,
      size_bytes: stat.size,
      created_at: stat.mtime.toISOString(),
    });
  }

  return files
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
}

export async function runBackup({ force = false } = {}) {
  const config = await getBackupConfig();
  const backupDir = resolveBackupDirectory(config.backup_path);
  await fs.promises.mkdir(backupDir, { recursive: true });

  const now = getYemenNow();
  const todayKey = yemenDateKey(now);
  if (!force && config.last_backup_date === todayKey) {
    return { ok: true, skipped: true, reason: 'already_backed_up_today' };
  }

  const stamp = `${todayKey}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const baseName = `captain-backup-${stamp}`;
  const createdFiles = [];

  try {
    const sql = await exportDatabaseSql();
    const gzPath = path.join(backupDir, `${baseName}.sql.gz`);
    const compressed = await gzip(Buffer.from(sql, 'utf8'));
    await fs.promises.writeFile(gzPath, compressed);
    createdFiles.push(gzPath);

    if (!isMySQL) {
      const sqlitePath = path.join(BACKEND_ROOT, 'data', 'captain.db');
      const sqliteCopy = path.join(backupDir, `${baseName}.db`);
      if (await copyIfExists(sqlitePath, sqliteCopy)) {
        createdFiles.push(sqliteCopy);
      }
    }

    await cleanupOldBackups(backupDir, config.retention_days || 30);

    const mainFile = createdFiles[0];
    const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
    await execute(
      `UPDATE backup_config
       SET last_backup_date = ?, last_backup_at = ${updatedAt}, last_backup_file = ?, last_backup_status = 'success', last_backup_error = NULL
       WHERE id = 1`,
      [todayKey, path.basename(mainFile)]
    );

    console.log(`💾 Backup created: ${mainFile}`);
    return {
      ok: true,
      file_name: path.basename(mainFile),
      files: createdFiles.map((filePath) => path.basename(filePath)),
      backup_path: backupDir,
      created_at: new Date().toISOString(),
    };
  } catch (err) {
    const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
    await execute(
      `UPDATE backup_config
       SET last_backup_at = ${updatedAt}, last_backup_status = 'failed', last_backup_error = ?
       WHERE id = 1`,
      [err.message || 'backup failed']
    );
    throw err;
  }
}

export async function processScheduledBackup() {
  const config = await getBackupConfig();
  if (!config.is_active) return;

  const now = getYemenNow();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const backupTime = normalizeTime(config.backup_time || '21:00');
  if (currentTime !== backupTime) return;

  const todayKey = yemenDateKey(now);
  if (config.last_backup_date === todayKey) return;

  await runBackup({ force: true });
}

export function resolveBackupFile(config, fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || !/^captain-backup-/.test(safeName)) {
    throw new Error('ملف النسخة غير صالح');
  }
  const fullPath = path.join(resolveBackupDirectory(config.backup_path), safeName);
  if (!fs.existsSync(fullPath)) throw new Error('ملف النسخة غير موجود');
  return fullPath;
}
