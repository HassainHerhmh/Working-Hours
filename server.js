import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { initDb, queryAll, queryOne, execute, getDbType, nowExpr, migrateCaptainPasswordColumn, migrateCaptainUsernameColumn, migrateShiftPeriodColumns, migrateShiftReminderTable, migrateAttendanceTable, migrateFinanceTables, migrateFinanceVouchersTable, migrateFinanceInvoicePostingsTable, migrateFinanceInvoiceSalesDateColumn, migrateFinanceInvoicePerDate, migrateFinanceCommissionPostingsTable, migrateFinanceCommissionSalesDateColumn, migrateFinanceVoucherDateColumn, toDbDateTime } from './database.js';
import * as smsGw from './smsGateway.service.js';
import * as shiftReminder from './shiftReminder.service.js';
import * as attendance from './attendance.service.js';
import * as finance from './finance.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function requireGatewayAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== smsGw.getGatewayToken()) {
    return res.status(401).json({ message: 'رمز بوابة SMS غير صالح' });
  }
  next();
}

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function formatBreakDuration(totalMinutes) {
  const minutes = Math.max(0, Number(totalMinutes) || 0);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return `${hours}س ${mins}د`;
  if (hours) return `${hours}س`;
  return `${mins}د`;
}

function normalizeTime(t) {
  if (!t || typeof t !== 'string') return '';
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function enrichShift(shift) {
  if (!shift) return null;
  const period_count = Number(shift.period_count) === 1 ? 1 : 2;
  const period1_start = normalizeTime(shift.start_time);
  const period1_end = normalizeTime(shift.period1_end || '12:00');
  const break_minutes = Number(
    shift.break_minutes ?? Math.round(Number(shift.break_hours ?? 2) * 60)
  );
  const break_hours = Math.floor(break_minutes / 60);
  const break_mins = break_minutes % 60;
  const period2_start = normalizeTime(shift.period2_start || '14:00');
  const period2_end = normalizeTime(shift.end_time);
  const breakLabel = formatBreakDuration(break_minutes);
  const schedule_label = period_count === 1
    ? `${period1_start}–${period2_end}`
    : `${period1_start}–${period1_end} | راحة ${breakLabel} | ${period2_start}–${period2_end}`;
  return {
    ...shift,
    period_count,
    period1_start,
    period1_end: period_count === 1 ? period2_end : period1_end,
    break_minutes,
    break_hours,
    break_mins,
    period2_start,
    period2_end,
    break_label: breakLabel,
    schedule_label
  };
}

function isUniqueError(e) {
  return e.message?.includes('UNIQUE') || e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
}

function sanitizeCaptain(captain) {
  if (!captain) return null;
  const { password_hash, ...safe } = captain;
  return safe;
}

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

async function ensureCaptainPasswords() {
  const rows = await queryAll("SELECT id FROM captains WHERE password_hash IS NULL OR password_hash = ''");
  if (!rows.length) return;
  const hash = bcrypt.hashSync('123456', 10);
  for (const row of rows) {
    await execute('UPDATE captains SET password_hash = ? WHERE id = ?', [hash, row.id]);
  }
}

async function seedIfEmpty() {
  await migrateCaptainPasswordColumn();
  await migrateCaptainUsernameColumn();
  await migrateShiftPeriodColumns();
  await migrateShiftReminderTable();
  await migrateAttendanceTable();
  await migrateFinanceTables();
  await migrateFinanceVouchersTable();
  await migrateFinanceInvoicePostingsTable();
  await migrateFinanceInvoiceSalesDateColumn();
  await migrateFinanceInvoicePerDate();
  await migrateFinanceCommissionPostingsTable();
  await migrateFinanceCommissionSalesDateColumn();
  await migrateFinanceVoucherDateColumn();
  const captainCount = Number((await queryOne('SELECT COUNT(*) as c FROM captains')).c);
  if (captainCount === 0) {
    const captains = [
      { name: 'أحمد محمد', phone: '967771234567', captain_number: 'C001', username: 'c001' },
      { name: 'خالد علي', phone: '967772345678', captain_number: 'C002', username: 'c002' },
      { name: 'سعد يوسف', phone: '967773456789', captain_number: 'C003', username: 'c003' }
    ];
    const defaultHash = bcrypt.hashSync('123456', 10);

    for (const c of captains) {
      const id = uuid();
      await execute(
        'INSERT INTO captains (id, name, phone, captain_number, username, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [id, c.name, c.phone, c.captain_number, c.username, defaultHash]
      );
      for (let day = 0; day <= 4; day++) {
        await execute(
          'INSERT INTO shifts (id, captain_id, day_of_week, start_time, end_time, period1_end, break_hours, break_minutes, period2_start, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [uuid(), id, day, '08:00', '17:00', '12:00', 2, 120, '14:00', 1]
        );
      }
    }
  }

  const userCount = Number((await queryOne('SELECT COUNT(*) as c FROM users')).c);
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await execute(`
      INSERT INTO users (id, name, email, phone, role, status, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [uuid(), 'المدير', 'admin@ebham.com', '967770000000', 'admin', 'active', hash]);
  }
  await ensureCaptainPasswords();
}

// ─── Users ──────────────────────────────────────────────────

app.get('/api/users', async (_, res) => {
  const users = await queryAll('SELECT * FROM users ORDER BY created_at DESC');
  res.json(users.map(sanitizeUser));
});

app.post('/api/users', upload.single('photo'), async (req, res) => {
  const { name, email, phone, role, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'الاسم وكلمة المرور مطلوبة' });
  }
  const id = uuid();
  const photo = req.file ? `/uploads/${req.file.filename}` : '';
  const hash = bcrypt.hashSync(password, 10);
  try {
    await execute(`
      INSERT INTO users (id, name, email, phone, role, photo, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, name, email || null, phone || null, role || 'employee', photo, hash]);
    res.status(201).json(sanitizeUser(await queryOne('SELECT * FROM users WHERE id = ?', [id])));
  } catch (e) {
    if (isUniqueError(e)) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.put('/api/users/:id', upload.single('photo'), async (req, res) => {
  const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });

  const { name, email, phone, role, status, password } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : existing.photo;
  const hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;

  try {
    await execute(`
      UPDATE users SET name = ?, email = ?, phone = ?, role = ?, status = ?, photo = ?, password_hash = ?
      WHERE id = ?
    `, [
      name ?? existing.name,
      email !== undefined ? (email || null) : existing.email,
      phone !== undefined ? (phone || null) : existing.phone,
      role ?? existing.role,
      status ?? existing.status,
      photo,
      hash,
      req.params.id
    ]);
    res.json(sanitizeUser(await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id])));
  } catch (e) {
    if (isUniqueError(e)) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.patch('/api/users/:id/status', async (req, res) => {
  const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const status = existing.status === 'active' ? 'inactive' : 'active';
  await execute('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json(sanitizeUser(await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id])));
});

app.patch('/api/users/:id/reset-password', async (req, res) => {
  const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const { password } = req.body;
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }
  const hash = bcrypt.hashSync(password, 10);
  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  res.json({ ok: true, message: 'تم إعادة تعيين كلمة المرور' });
});

app.delete('/api/users/:id', async (req, res) => {
  await execute('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Captains ───────────────────────────────────────────────

app.get('/api/captains', async (_, res) => {
  const captains = await queryAll('SELECT * FROM captains ORDER BY created_at DESC');
  res.json(captains.map(sanitizeCaptain));
});

app.get('/api/captains/:id', async (req, res) => {
  const captain = await queryOne('SELECT * FROM captains WHERE id = ?', [req.params.id]);
  if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });
  res.json(sanitizeCaptain(captain));
});

app.post('/api/captains', upload.single('photo'), async (req, res) => {
  const { name, phone, captain_number, username, password } = req.body;
  if (!name || !phone || !captain_number || !username) {
    return res.status(400).json({ error: 'الاسم والهاتف ورقم الكابتن واسم المستخدم مطلوبة' });
  }
  const id = uuid();
  const photo = req.file ? `/uploads/${req.file.filename}` : '';
  const hash = bcrypt.hashSync(password || '123456', 10);
  const normalizedUsername = String(username).trim().toLowerCase();
  try {
    await execute(
      'INSERT INTO captains (id, name, phone, captain_number, username, photo, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, phone, captain_number, normalizedUsername, photo, hash]
    );
    res.status(201).json(sanitizeCaptain(await queryOne('SELECT * FROM captains WHERE id = ?', [id])));
  } catch (e) {
    if (isUniqueError(e)) {
      return res.status(409).json({ error: 'رقم الهاتف أو رقم الكابتن أو اسم المستخدم مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.put('/api/captains/:id', upload.single('photo'), async (req, res) => {
  const existing = await queryOne('SELECT * FROM captains WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'الكابتن غير موجود' });

  const { name, phone, captain_number, username, password } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : existing.photo;
  const hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  const normalizedUsername = username
    ? String(username).trim().toLowerCase()
    : existing.username;

  try {
    await execute(
      'UPDATE captains SET name = ?, phone = ?, captain_number = ?, username = ?, photo = ?, password_hash = ? WHERE id = ?',
      [
        name || existing.name,
        phone || existing.phone,
        captain_number || existing.captain_number,
        normalizedUsername,
        photo,
        hash,
        req.params.id
      ]
    );
    res.json(sanitizeCaptain(await queryOne('SELECT * FROM captains WHERE id = ?', [req.params.id])));
  } catch (e) {
    if (isUniqueError(e)) {
      return res.status(409).json({ error: 'رقم الهاتف أو رقم الكابتن أو اسم المستخدم مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.delete('/api/captains/:id', async (req, res) => {
  await execute('DELETE FROM captains WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/captains/:id/reset-password', async (req, res) => {
  const existing = await queryOne('SELECT * FROM captains WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'الكابتن غير موجود' });
  const { password } = req.body;
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }
  const hash = bcrypt.hashSync(password, 10);
  await execute('UPDATE captains SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  res.json({ ok: true, message: 'تم إعادة تعيين كلمة المرور' });
});

// ─── Shifts ─────────────────────────────────────────────────

app.get('/api/shifts', async (req, res) => {
  const { captain_id } = req.query;
  let shifts;
  if (captain_id) {
    shifts = await queryAll('SELECT * FROM shifts WHERE captain_id = ? ORDER BY day_of_week', [captain_id]);
  } else {
    shifts = await queryAll(`
      SELECT s.*, c.name as captain_name, c.captain_number
      FROM shifts s JOIN captains c ON c.id = s.captain_id
      ORDER BY c.name, s.day_of_week
    `);
  }
  res.json(shifts.map(s => enrichShift({ ...s, day_name: DAYS[s.day_of_week] })));
});

app.put('/api/shifts/captain/:captainId', async (req, res) => {
  const { shifts } = req.body;
  if (!Array.isArray(shifts)) return res.status(400).json({ error: 'بيانات الدوام غير صالحة' });

  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [req.params.captainId]);
  if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });

  await execute('DELETE FROM shifts WHERE captain_id = ?', [req.params.captainId]);
  for (const s of shifts) {
    if (s.is_active !== false) {
      const period1_start = s.period1_start || s.start_time || '08:00';
      const period1_end = s.period1_end || '12:00';
      const period_count = Number(s.period_count) === 1 ? 1 : 2;
      const break_minutes = period_count === 1 ? 0 : (
        s.break_minutes != null
          ? Number(s.break_minutes)
          : Math.round(Number(s.break_hours ?? 2) * 60) + Number(s.break_mins ?? 0)
      );
      const period2_start = s.period2_start || '14:00';
      const period2_end = period_count === 1
        ? (s.period1_end || s.end_time || '17:00')
        : (s.period2_end || s.end_time || '17:00');
      const end_time = period2_end;
      await execute(
        'INSERT INTO shifts (id, captain_id, day_of_week, start_time, end_time, period1_end, break_hours, break_minutes, period2_start, period_count, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuid(), req.params.captainId, s.day_of_week,
          period1_start, end_time,
          period_count === 1 ? end_time : period1_end,
          break_minutes / 60, break_minutes, period2_start, period_count, 1
        ]
      );
    }
  }

  const result = await queryAll('SELECT * FROM shifts WHERE captain_id = ? ORDER BY day_of_week', [req.params.captainId]);
  res.json(result.map(s => enrichShift({ ...s, day_name: DAYS[s.day_of_week] })));
});

// ─── SMS Messages ───────────────────────────────────────────

app.get('/api/sms/messages', async (_, res) => {
  const messages = await queryAll(`
    SELECT m.*, c.name as captain_name, c.phone as captain_phone
    FROM sms_messages m
    LEFT JOIN captains c ON c.id = m.captain_id
    ORDER BY m.created_at DESC
  `);
  res.json(messages);
});

app.post('/api/sms/messages', async (req, res) => {
  const { title, body, captain_id, scheduled_at, repeat_type } = req.body;
  if (!title || !body || !scheduled_at) {
    return res.status(400).json({ error: 'العنوان والنص ووقت الإرسال مطلوبة' });
  }
  const id = uuid();
  await execute(`
    INSERT INTO sms_messages (id, title, body, captain_id, scheduled_at, repeat_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, title, body, captain_id || null, toDbDateTime(scheduled_at), repeat_type || 'once']);

  res.status(201).json(await queryOne('SELECT * FROM sms_messages WHERE id = ?', [id]));
});

app.put('/api/sms/messages/:id', async (req, res) => {
  const existing = await queryOne('SELECT * FROM sms_messages WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'الرسالة غير موجودة' });

  const { title, body, captain_id, scheduled_at, repeat_type, is_active } = req.body;
  await execute(`
    UPDATE sms_messages SET title = ?, body = ?, captain_id = ?, scheduled_at = ?,
    repeat_type = ?, is_active = ? WHERE id = ?
  `, [
    title ?? existing.title,
    body ?? existing.body,
    captain_id !== undefined ? (captain_id || null) : existing.captain_id,
    scheduled_at !== undefined ? toDbDateTime(scheduled_at) : toDbDateTime(existing.scheduled_at),
    repeat_type ?? existing.repeat_type,
    is_active ?? existing.is_active,
    req.params.id
  ]);
  res.json(await queryOne('SELECT * FROM sms_messages WHERE id = ?', [req.params.id]));
});

app.delete('/api/sms/messages/:id', async (req, res) => {
  await execute('DELETE FROM sms_messages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/sms/shift-reminder', async (_, res) => {
  res.json(await shiftReminder.getShiftReminderConfig());
});

app.put('/api/sms/shift-reminder', async (req, res) => {
  const { send_time, body_work, body_off, is_active } = req.body;
  const saved = await shiftReminder.saveShiftReminderConfig({
    send_time, body_work, body_off, is_active,
  });
  res.json(saved);
});

app.post('/api/sms/shift-reminder/test', async (_, res) => {
  const config = await shiftReminder.getShiftReminderConfig();
  const captains = await queryAll('SELECT * FROM captains LIMIT 1');
  if (!captains.length) return res.status(400).json({ error: 'لا يوجد كباتن' });
  const captain = captains[0];
  const tomorrow = shiftReminder.getYemenNow();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const shift = await queryOne(
    'SELECT * FROM shifts WHERE captain_id = ? AND day_of_week = ? AND is_active = 1',
    [captain.id, tomorrow.getDay()]
  );
  const preview = shiftReminder.buildTomorrowMessage(captain, shift, config);
  res.json({ preview, captain: captain.name, hasShift: Boolean(shift) });
});

app.post('/api/sms/shift-reminder/send-now', async (req, res) => {
  try {
    const { body_work, body_off } = req.body || {};
    const result = await shiftReminder.sendShiftRemindersNow({ body_work, body_off });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── SMS Log & Simulator ────────────────────────────────────

app.get('/api/sms/log', async (req, res) => {
  const { limit = 50 } = req.query;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const logs = await queryAll(`SELECT * FROM sms_log ORDER BY sent_at DESC LIMIT ${safeLimit}`);
  res.json(logs);
});

app.post('/api/sms/send-now', async (req, res) => {
  const { message_id, captain_id, body } = req.body;

  if (message_id) {
    const msg = await queryOne('SELECT * FROM sms_messages WHERE id = ?', [message_id]);
    if (!msg) return res.status(404).json({ error: 'الرسالة غير موجودة' });

    const queued = await smsGw.queueMessageToCaptains(msg);
    await execute(`UPDATE sms_messages SET last_sent_at = ${nowExpr()} WHERE id = ?`, [msg.id]);
    return res.json({ queued: queued.length, messages: queued });
  }

  if (captain_id && body) {
    const captain = await queryOne('SELECT * FROM captains WHERE id = ?', [captain_id]);
    if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });
    const queued = await smsGw.queueSms({
      recipientPhone: captain.phone,
      message: body,
      captainId: captain.id,
      captainName: captain.name,
      smsType: 'shift'
    });
    return res.json({ queued: 1, message: queued });
  }

  res.status(400).json({ error: 'حدد message_id أو captain_id + body' });
});

app.get('/api/sms/gateway-status', async (_, res) => {
  res.json({ stats: await smsGw.getGatewayStats(), tokenConfigured: Boolean(smsGw.getGatewayToken()) });
});

// ─── SMS Gateway (بوابة الإرسال) ───────────────────────────

app.get('/api/sms-gateway/stats', requireGatewayAuth, async (_, res) => {
  await smsGw.touchGatewayHeartbeat();
  res.json({ stats: await smsGw.getGatewayStats() });
});

app.get('/api/sms-gateway/pending', requireGatewayAuth, async (req, res) => {
  await smsGw.touchGatewayHeartbeat();
  const messages = await smsGw.getPendingSms(req.query.limit);
  res.json({ messages });
});

app.post('/api/sms-gateway/:id/sent', requireGatewayAuth, async (req, res) => {
  const row = await smsGw.markSmsSent(req.params.id);
  if (!row) return res.status(404).json({ message: 'الرسالة غير موجودة' });
  res.json({ ok: true, message: row });
});

app.post('/api/sms-gateway/:id/failed', requireGatewayAuth, async (req, res) => {
  const row = await smsGw.markSmsFailed(req.params.id, req.body?.error);
  if (!row) return res.status(404).json({ message: 'الرسالة غير موجودة' });
  res.json({ ok: true, message: row });
});

app.get('/api/sms/simulator/inbox/:captainId', async (req, res) => {
  const logs = await queryAll(`
    SELECT * FROM sms_log WHERE captain_id = ? ORDER BY sent_at DESC LIMIT 30
  `, [req.params.captainId]);
  res.json(logs);
});

// ─── Platform Admin Login ───────────────────────────────────

app.post('/api/platform-auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'البريد الإلكتروني أو رقم الهاتف وكلمة المرور مطلوبة' });
  }
  const key = String(username).trim();
  const user = await queryOne(
    'SELECT * FROM users WHERE email = ? OR phone = ?',
    [key, key]
  );
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'البريد الإلكتروني أو رقم الهاتف أو كلمة المرور غير صحيحة' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'الحساب معطّل — تواصل مع المدير' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'البريد الإلكتروني أو رقم الهاتف أو كلمة المرور غير صحيحة' });
  }
  res.json({ user: sanitizeUser(user), token: user.id });
});

// ─── Captain App Login (simple phone lookup) ────────────────

app.post('/api/captain-auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبة' });
  }
  const key = String(username).trim().toLowerCase();
  const captain = await queryOne(
    'SELECT * FROM captains WHERE username = ?',
    [key]
  );
  if (!captain || !captain.password_hash) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  if (!bcrypt.compareSync(password, captain.password_hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  res.json({ captain: sanitizeCaptain(captain), token: captain.id });
});

app.get('/api/captain-auth/me/:id', async (req, res) => {
  const captain = await queryOne('SELECT * FROM captains WHERE id = ?', [req.params.id]);
  if (!captain) return res.status(404).json({ error: 'غير موجود' });

  const shifts = (await queryAll('SELECT * FROM shifts WHERE captain_id = ? AND is_active = 1 ORDER BY day_of_week', [captain.id]))
    .map(s => enrichShift({ ...s, day_name: DAYS[s.day_of_week] }));

  const today = new Date().getDay();
  const todayShift = shifts.find(s => s.day_of_week === today);
  const attendanceStatus = await attendance.getCheckInStatus(captain.id);

  res.json({
    captain: sanitizeCaptain(captain),
    shifts,
    todayShift,
    todayName: DAYS[today],
    attendance: attendanceStatus,
  });
});

// ─── Finance ────────────────────────────────────────────────

app.get('/api/finance/config', async (_, res) => {
  res.json(await finance.getFinanceConfig());
});

app.put('/api/finance/config', async (req, res) => {
  try {
    res.json(await finance.saveFinanceConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/finance/stores', async (_, res) => {
  res.json(await finance.listStores());
});

app.post('/api/finance/stores', async (req, res) => {
  try {
    const store = await finance.createStore(req.body.name);
    res.status(201).json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/finance/stores/:id', async (req, res) => {
  try {
    res.json(await finance.updateStore(req.params.id, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/finance/stores/:id', async (req, res) => {
  await finance.deleteStore(req.params.id);
  res.json({ ok: true });
});

app.get('/api/finance/captain/:captainId', async (req, res) => {
  try {
    const { period, date, sales_date } = req.query;
    res.json(await finance.getCaptainFinance(req.params.captainId, { period, date, sales_date }));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.put('/api/finance/captain/:captainId', async (req, res) => {
  try {
    res.json(await finance.saveCaptainFinance(req.params.captainId, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/finance/vouchers', async (req, res) => {
  res.json(await finance.listAllVouchers(req.query.captain_id || undefined));
});

app.get('/api/finance/captain/:captainId/vouchers', async (req, res) => {
  res.json(await finance.listCaptainVouchers(req.params.captainId));
});

app.post('/api/finance/captain/:captainId/vouchers', async (req, res) => {
  try {
    const voucher = await finance.createVoucher(req.params.captainId, req.body);
    res.status(201).json(voucher);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/finance/vouchers/:id', async (req, res) => {
  await finance.deleteVoucher(req.params.id);
  res.json({ ok: true });
});

app.put('/api/finance/vouchers/:id', async (req, res) => {
  try {
    res.json(await finance.updateVoucher(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/finance/invoice-postings', async (_, res) => {
  res.json(await finance.listInvoicePostings());
});

app.delete('/api/finance/invoice-postings/:id', async (req, res) => {
  try {
    res.json(await finance.deleteInvoicePosting(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/finance/captain/:captainId/commission', async (req, res) => {
  try {
    res.json(await finance.saveCaptainCommission(req.params.captainId, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/finance/commission-postings', async (_, res) => {
  res.json(await finance.listCommissionPostings());
});

app.delete('/api/finance/commission-postings/:id', async (req, res) => {
  try {
    res.json(await finance.deleteCommissionPosting(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Attendance ─────────────────────────────────────────────

app.post('/api/attendance/check-in', async (req, res) => {
  const { captain_id } = req.body;
  if (!captain_id) return res.status(400).json({ error: 'معرّف الكابتن مطلوب' });
  try {
    const result = await attendance.recordCheckIn(captain_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/attendance/status/:captainId', async (req, res) => {
  const status = await attendance.getCheckInStatus(req.params.captainId);
  res.json(status);
});

app.get('/api/attendance/report', async (req, res) => {
  const { period = 'day', date, captain_id } = req.query;
  const report = await attendance.getAttendanceReport({
    period: ['day', 'week', 'month'].includes(period) ? period : 'day',
    date: date || undefined,
    captain_id: captain_id || undefined,
  });
  res.json(report);
});

// ─── Scheduler (checks every 30s) ───────────────────────────

async function processScheduledMessages() {
  await shiftReminder.processShiftReminders().catch(err => console.error('Shift reminder error:', err));

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentDay = now.getDay();

  const messages = await queryAll('SELECT * FROM sms_messages WHERE is_active = 1');

  for (const msg of messages) {
    const schedDate = new Date(msg.scheduled_at);
    const schedTime = `${String(schedDate.getHours()).padStart(2, '0')}:${String(schedDate.getMinutes()).padStart(2, '0')}`;

    if (schedTime !== currentTime) continue;

    if (msg.repeat_type === 'once') {
      const lastSent = msg.last_sent_at ? new Date(msg.last_sent_at) : null;
      if (lastSent && (now - lastSent) < 60000) continue;
      if (lastSent) continue;
    }

    if (msg.repeat_type === 'weekly') {
      if (schedDate.getDay() !== currentDay) continue;
    }

    const targets = msg.captain_id
      ? [await queryOne('SELECT * FROM captains WHERE id = ?', [msg.captain_id])].filter(Boolean)
      : await queryAll('SELECT * FROM captains');

    if (targets.length === 0) continue;

    await smsGw.queueMessageToCaptains(msg);

    await execute(`UPDATE sms_messages SET last_sent_at = ${nowExpr()} WHERE id = ?`, [msg.id]);

    if (msg.repeat_type === 'once') {
      await execute('UPDATE sms_messages SET is_active = 0 WHERE id = ?', [msg.id]);
    }
  }
}

setInterval(() => {
  processScheduledMessages().catch(err => console.error('Scheduler error:', err));
}, 30000);

app.get('/api/health', (_, res) => res.json({ status: 'ok', days: DAYS, db: getDbType() }));

async function start() {
  await initDb();
  await seedIfEmpty();

  app.listen(PORT, () => {
    console.log(`🚀 Captain Platform API running on http://localhost:${PORT} [${getDbType()}]`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
