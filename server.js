import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import db from './db.js';
import * as smsGw from './smsGateway.service.js';

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

function seedIfEmpty() {
  const captainCount = db.prepare('SELECT COUNT(*) as c FROM captains').get().c;
  if (captainCount === 0) {
    const captains = [
      { id: uuid(), name: 'أحمد محمد', phone: '967771234567', captain_number: 'C001' },
      { id: uuid(), name: 'خالد علي', phone: '967772345678', captain_number: 'C002' },
      { id: uuid(), name: 'سعد يوسف', phone: '967773456789', captain_number: 'C003' }
    ];

    const insertCaptain = db.prepare(
      'INSERT INTO captains (id, name, phone, captain_number) VALUES (?, ?, ?, ?)'
    );
    const insertShift = db.prepare(
      'INSERT INTO shifts (id, captain_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)'
    );

    for (const c of captains) {
      insertCaptain.run(c.id, c.name, c.phone, c.captain_number);
      for (let day = 0; day <= 4; day++) {
        insertShift.run(uuid(), c.id, day, '08:00', '17:00');
      }
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (id, name, email, phone, role, status, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), 'المدير', 'admin@go.com', '967770000000', 'admin', 'active', hash);
  }
}

seedIfEmpty();

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

// ─── Users ──────────────────────────────────────────────────

app.get('/api/users', (_, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json(users.map(sanitizeUser));
});

app.post('/api/users', upload.single('photo'), (req, res) => {
  const { name, email, phone, role, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'الاسم وكلمة المرور مطلوبة' });
  }
  const id = uuid();
  const photo = req.file ? `/uploads/${req.file.filename}` : '';
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare(`
      INSERT INTO users (id, name, email, phone, role, photo, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, email || null, phone || null, role || 'employee', photo, hash);
    res.status(201).json(sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.put('/api/users/:id', upload.single('photo'), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });

  const { name, email, phone, role, status, password } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : existing.photo;
  const hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;

  try {
    db.prepare(`
      UPDATE users SET name = ?, email = ?, phone = ?, role = ?, status = ?, photo = ?, password_hash = ?
      WHERE id = ?
    `).run(
      name ?? existing.name,
      email !== undefined ? (email || null) : existing.email,
      phone !== undefined ? (phone || null) : existing.phone,
      role ?? existing.role,
      status ?? existing.status,
      photo,
      hash,
      req.params.id
    );
    res.json(sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.patch('/api/users/:id/status', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const status = existing.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
});

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Captains ───────────────────────────────────────────────

app.get('/api/captains', (_, res) => {
  const captains = db.prepare('SELECT * FROM captains ORDER BY created_at DESC').all();
  res.json(captains);
});

app.get('/api/captains/:id', (req, res) => {
  const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });
  res.json(captain);
});

app.post('/api/captains', upload.single('photo'), (req, res) => {
  const { name, phone, captain_number } = req.body;
  if (!name || !phone || !captain_number) {
    return res.status(400).json({ error: 'الاسم والهاتف ورقم الكابتن مطلوبة' });
  }
  const id = uuid();
  const photo = req.file ? `/uploads/${req.file.filename}` : '';
  try {
    db.prepare(
      'INSERT INTO captains (id, name, phone, captain_number, photo) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, phone, captain_number, photo);
    res.status(201).json(db.prepare('SELECT * FROM captains WHERE id = ?').get(id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'رقم الهاتف أو رقم الكابتن مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.put('/api/captains/:id', upload.single('photo'), (req, res) => {
  const existing = db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'الكابتن غير موجود' });

  const { name, phone, captain_number } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : existing.photo;

  try {
    db.prepare(
      'UPDATE captains SET name = ?, phone = ?, captain_number = ?, photo = ? WHERE id = ?'
    ).run(name || existing.name, phone || existing.phone, captain_number || existing.captain_number, photo, req.params.id);
    res.json(db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'رقم الهاتف أو رقم الكابتن مستخدم مسبقاً' });
    }
    throw e;
  }
});

app.delete('/api/captains/:id', (req, res) => {
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Shifts ─────────────────────────────────────────────────

app.get('/api/shifts', (req, res) => {
  const { captain_id } = req.query;
  let shifts;
  if (captain_id) {
    shifts = db.prepare('SELECT * FROM shifts WHERE captain_id = ? ORDER BY day_of_week').all(captain_id);
  } else {
    shifts = db.prepare(`
      SELECT s.*, c.name as captain_name, c.captain_number
      FROM shifts s JOIN captains c ON c.id = s.captain_id
      ORDER BY c.name, s.day_of_week
    `).all();
  }
  res.json(shifts.map(s => ({ ...s, day_name: DAYS[s.day_of_week] })));
});

app.put('/api/shifts/captain/:captainId', (req, res) => {
  const { shifts } = req.body;
  if (!Array.isArray(shifts)) return res.status(400).json({ error: 'بيانات الدوام غير صالحة' });

  const captain = db.prepare('SELECT id FROM captains WHERE id = ?').get(req.params.captainId);
  if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });

  const deleteOld = db.prepare('DELETE FROM shifts WHERE captain_id = ?');
  const insert = db.prepare(
    'INSERT INTO shifts (id, captain_id, day_of_week, start_time, end_time, is_active) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    deleteOld.run(req.params.captainId);
    for (const s of shifts) {
      if (s.is_active !== false) {
        insert.run(uuid(), req.params.captainId, s.day_of_week, s.start_time, s.end_time, 1);
      }
    }
  });
  tx();

  const result = db.prepare('SELECT * FROM shifts WHERE captain_id = ? ORDER BY day_of_week').all(req.params.captainId);
  res.json(result.map(s => ({ ...s, day_name: DAYS[s.day_of_week] })));
});

// ─── SMS Messages ───────────────────────────────────────────

app.get('/api/sms/messages', (_, res) => {
  const messages = db.prepare(`
    SELECT m.*, c.name as captain_name, c.phone as captain_phone
    FROM sms_messages m
    LEFT JOIN captains c ON c.id = m.captain_id
    ORDER BY m.created_at DESC
  `).all();
  res.json(messages);
});

app.post('/api/sms/messages', (req, res) => {
  const { title, body, captain_id, scheduled_at, repeat_type } = req.body;
  if (!title || !body || !scheduled_at) {
    return res.status(400).json({ error: 'العنوان والنص ووقت الإرسال مطلوبة' });
  }
  const id = uuid();
  db.prepare(`
    INSERT INTO sms_messages (id, title, body, captain_id, scheduled_at, repeat_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, body, captain_id || null, scheduled_at, repeat_type || 'once');

  res.status(201).json(db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id));
});

app.put('/api/sms/messages/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'الرسالة غير موجودة' });

  const { title, body, captain_id, scheduled_at, repeat_type, is_active } = req.body;
  db.prepare(`
    UPDATE sms_messages SET title = ?, body = ?, captain_id = ?, scheduled_at = ?,
    repeat_type = ?, is_active = ? WHERE id = ?
  `).run(
    title ?? existing.title,
    body ?? existing.body,
    captain_id !== undefined ? (captain_id || null) : existing.captain_id,
    scheduled_at ?? existing.scheduled_at,
    repeat_type ?? existing.repeat_type,
    is_active ?? existing.is_active,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(req.params.id));
});

app.delete('/api/sms/messages/:id', (req, res) => {
  db.prepare('DELETE FROM sms_messages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── SMS Log & Simulator ────────────────────────────────────

app.get('/api/sms/log', (req, res) => {
  const { limit = 50 } = req.query;
  const logs = db.prepare('SELECT * FROM sms_log ORDER BY sent_at DESC LIMIT ?').all(Number(limit));
  res.json(logs);
});

app.post('/api/sms/send-now', (req, res) => {
  const { message_id, captain_id, body } = req.body;

  if (message_id) {
    const msg = db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(message_id);
    if (!msg) return res.status(404).json({ error: 'الرسالة غير موجودة' });

    const queued = smsGw.queueMessageToCaptains(msg);
    db.prepare("UPDATE sms_messages SET last_sent_at = datetime('now') WHERE id = ?").run(msg.id);
    return res.json({ queued: queued.length, messages: queued });
  }

  if (captain_id && body) {
    const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(captain_id);
    if (!captain) return res.status(404).json({ error: 'الكابتن غير موجود' });
    const queued = smsGw.queueSms({
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

app.get('/api/sms/gateway-status', (_, res) => {
  res.json({ stats: smsGw.getGatewayStats(), tokenConfigured: Boolean(smsGw.getGatewayToken()) });
});

// ─── SMS Gateway (بوابة الإرسال) ───────────────────────────

app.get('/api/sms-gateway/stats', requireGatewayAuth, (_, res) => {
  smsGw.touchGatewayHeartbeat();
  res.json({ stats: smsGw.getGatewayStats() });
});

app.get('/api/sms-gateway/pending', requireGatewayAuth, (req, res) => {
  smsGw.touchGatewayHeartbeat();
  const messages = smsGw.getPendingSms(req.query.limit);
  res.json({ messages });
});

app.post('/api/sms-gateway/:id/sent', requireGatewayAuth, (req, res) => {
  const row = smsGw.markSmsSent(req.params.id);
  if (!row) return res.status(404).json({ message: 'الرسالة غير موجودة' });
  res.json({ ok: true, message: row });
});

app.post('/api/sms-gateway/:id/failed', requireGatewayAuth, (req, res) => {
  const row = smsGw.markSmsFailed(req.params.id, req.body?.error);
  if (!row) return res.status(404).json({ message: 'الرسالة غير موجودة' });
  res.json({ ok: true, message: row });
});

app.get('/api/sms/simulator/inbox/:captainId', (req, res) => {
  const logs = db.prepare(`
    SELECT * FROM sms_log WHERE captain_id = ? ORDER BY sent_at DESC LIMIT 30
  `).all(req.params.captainId);
  res.json(logs);
});

// ─── Captain App Login (simple phone lookup) ────────────────

app.post('/api/captain-auth/login', (req, res) => {
  const { phone } = req.body;
  const captain = db.prepare('SELECT * FROM captains WHERE phone = ?').get(phone);
  if (!captain) return res.status(401).json({ error: 'رقم الهاتف غير مسجل' });
  res.json({ captain, token: captain.id });
});

app.get('/api/captain-auth/me/:id', (req, res) => {
  const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id);
  if (!captain) return res.status(404).json({ error: 'غير موجود' });

  const shifts = db.prepare('SELECT * FROM shifts WHERE captain_id = ? AND is_active = 1 ORDER BY day_of_week')
    .all(captain.id)
    .map(s => ({ ...s, day_name: DAYS[s.day_of_week] }));

  const today = new Date().getDay();
  const todayShift = shifts.find(s => s.day_of_week === today);

  res.json({ captain, shifts, todayShift, todayName: DAYS[today] });
});

// ─── Scheduler (checks every 30s) ───────────────────────────

function processScheduledMessages() {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentDay = now.getDay();

  const messages = db.prepare('SELECT * FROM sms_messages WHERE is_active = 1').all();

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
      ? [db.prepare('SELECT * FROM captains WHERE id = ?').get(msg.captain_id)].filter(Boolean)
      : db.prepare('SELECT * FROM captains').all();

    if (targets.length === 0) continue;

    smsGw.queueMessageToCaptains(msg);

    db.prepare("UPDATE sms_messages SET last_sent_at = datetime('now') WHERE id = ?").run(msg.id);

    if (msg.repeat_type === 'once') {
      db.prepare('UPDATE sms_messages SET is_active = 0 WHERE id = ?').run(msg.id);
    }
  }
}

setInterval(processScheduledMessages, 30000);

app.get('/api/health', (_, res) => res.json({ status: 'ok', days: DAYS }));

app.listen(PORT, () => {
  console.log(`🚀 Captain Platform API running on http://localhost:${PORT}`);
});
