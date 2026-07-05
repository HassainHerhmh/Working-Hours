import db from './db.js';
import { v4 as uuid } from 'uuid';

const GATEWAY_ONLINE_SECONDS = 90;
const DEFAULT_TOKEN = 'captain-sms-gateway-2026';

export function getGatewayToken() {
  return process.env.SMS_GATEWAY_TOKEN || DEFAULT_TOKEN;
}

export function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00967')) digits = digits.slice(2);
  if (digits.startsWith('967') && digits.length >= 12) return digits;
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 9) return `967${digits}`;
  return digits;
}

export function touchGatewayHeartbeat() {
  db.prepare(`
    INSERT INTO sms_gateway_heartbeat (id, last_seen_at) VALUES (1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')
  `).run();
}

export function isGatewayOnline() {
  const row = db.prepare('SELECT last_seen_at FROM sms_gateway_heartbeat WHERE id = 1').get();
  if (!row?.last_seen_at) return false;
  const ageMs = Date.now() - new Date(row.last_seen_at + 'Z').getTime();
  return ageMs <= GATEWAY_ONLINE_SECONDS * 1000;
}

export function getGatewayStats() {
  const pending = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'pending'").get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'sent'").get().c;
  const failed = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'failed'").get().c;
  return { pending, sent, failed, online: isGatewayOnline() };
}

export function queueSms({ recipientPhone, message, messageId = null, captainId = null, captainName = null, smsType = 'shift' }) {
  const phone = normalizePhone(recipientPhone);
  if (phone.length < 11) throw new Error('رقم الهاتف غير صالح');

  const id = uuid();
  db.prepare(`
    INSERT INTO sms_queue (id, recipient_phone, message, message_id, captain_id, captain_name, sms_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, phone, message, messageId, captainId, captainName, smsType);

  return db.prepare('SELECT * FROM sms_queue WHERE id = ?').get(id);
}

export function getPendingSms(limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return db.prepare(`
    SELECT id, recipient_phone, message, message_id, captain_id, captain_name, sms_type, created_at
    FROM sms_queue WHERE status = 'pending'
    ORDER BY created_at ASC LIMIT ?
  `).all(safeLimit).map(row => ({
    id: row.id,
    recipientPhone: row.recipient_phone,
    message: row.message,
    messageId: row.message_id,
    captainId: row.captain_id,
    captainName: row.captain_name,
    smsType: row.sms_type,
    categoryName: row.sms_type === 'shift' ? 'دوام الكباتن' : row.sms_type,
    createdAt: row.created_at
  }));
}

export function markSmsSent(id) {
  const row = db.prepare("SELECT * FROM sms_queue WHERE id = ? AND status = 'pending'").get(id);
  if (!row) return null;

  db.prepare(`
    UPDATE sms_queue SET status = 'sent', sent_at = datetime('now'), error_message = NULL WHERE id = ?
  `).run(id);

  const logId = uuid();
  db.prepare(`
    INSERT INTO sms_log (id, message_id, captain_id, captain_name, captain_phone, body, status, source)
    VALUES (?, ?, ?, ?, ?, ?, 'sent', 'gateway')
  `).run(logId, row.message_id, row.captain_id, row.captain_name, row.recipient_phone, row.message);

  return db.prepare('SELECT * FROM sms_queue WHERE id = ?').get(id);
}

export function markSmsFailed(id, errorMessage = '') {
  const row = db.prepare("SELECT * FROM sms_queue WHERE id = ? AND status = 'pending'").get(id);
  if (!row) return null;

  db.prepare(`
    UPDATE sms_queue SET status = 'failed', error_message = ?, sent_at = datetime('now') WHERE id = ?
  `).run(String(errorMessage).slice(0, 500), id);

  return db.prepare('SELECT * FROM sms_queue WHERE id = ?').get(id);
}

export function queueMessageToCaptains(msg) {
  const targets = msg.captain_id
    ? [db.prepare('SELECT * FROM captains WHERE id = ?').get(msg.captain_id)].filter(Boolean)
    : db.prepare('SELECT * FROM captains').all();

  const queued = [];
  for (const c of targets) {
    queued.push(queueSms({
      recipientPhone: c.phone,
      message: msg.body,
      messageId: msg.id,
      captainId: c.id,
      captainName: c.name,
      smsType: 'shift'
    }));
  }
  return queued;
}
