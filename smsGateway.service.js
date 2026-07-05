import { queryAll, queryOne, execute, isMySQL, nowExpr } from './database.js';
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

export async function touchGatewayHeartbeat() {
  const now = nowExpr();
  if (isMySQL) {
    await execute(
      `INSERT INTO sms_gateway_heartbeat (id, last_seen_at) VALUES (1, ${now})
       ON DUPLICATE KEY UPDATE last_seen_at = ${now}`
    );
  } else {
    await execute(
      `INSERT INTO sms_gateway_heartbeat (id, last_seen_at) VALUES (1, ${now})
       ON CONFLICT(id) DO UPDATE SET last_seen_at = ${now}`
    );
  }
}

function toTimestamp(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const raw = String(value);
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T')).getTime();
}

export async function isGatewayOnline() {
  const row = await queryOne('SELECT last_seen_at FROM sms_gateway_heartbeat WHERE id = 1');
  if (!row?.last_seen_at) return false;
  const seenAt = toTimestamp(row.last_seen_at);
  if (Number.isNaN(seenAt)) return false;
  return Date.now() - seenAt <= GATEWAY_ONLINE_SECONDS * 1000;
}

export async function getGatewayStats() {
  const pending = Number((await queryOne("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'pending'")).c);
  const sent = Number((await queryOne("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'sent'")).c);
  const failed = Number((await queryOne("SELECT COUNT(*) as c FROM sms_queue WHERE status = 'failed'")).c);
  return { pending, sent, failed, online: await isGatewayOnline() };
}

export async function queueSms({ recipientPhone, message, messageId = null, captainId = null, captainName = null, smsType = 'shift' }) {
  const phone = normalizePhone(recipientPhone);
  if (phone.length < 11) throw new Error('رقم الهاتف غير صالح');

  const id = uuid();
  await execute(`
    INSERT INTO sms_queue (id, recipient_phone, message, message_id, captain_id, captain_name, sms_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [id, phone, message, messageId, captainId, captainName, smsType]);

  return queryOne('SELECT * FROM sms_queue WHERE id = ?', [id]);
}

export async function getPendingSms(limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const rows = await queryAll(`
    SELECT id, recipient_phone, message, message_id, captain_id, captain_name, sms_type, created_at
    FROM sms_queue WHERE status = 'pending'
    ORDER BY created_at ASC LIMIT ${safeLimit}
  `);
  return rows.map(row => ({
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

export async function markSmsSent(id) {
  const row = await queryOne("SELECT * FROM sms_queue WHERE id = ? AND status = 'pending'", [id]);
  if (!row) return null;

  await execute(`
    UPDATE sms_queue SET status = 'sent', sent_at = ${nowExpr()}, error_message = NULL WHERE id = ?
  `, [id]);

  const logId = uuid();
  await execute(`
    INSERT INTO sms_log (id, message_id, captain_id, captain_name, captain_phone, body, status, source)
    VALUES (?, ?, ?, ?, ?, ?, 'sent', 'gateway')
  `, [logId, row.message_id, row.captain_id, row.captain_name, row.recipient_phone, row.message]);

  return queryOne('SELECT * FROM sms_queue WHERE id = ?', [id]);
}

export async function markSmsFailed(id, errorMessage = '') {
  const row = await queryOne("SELECT * FROM sms_queue WHERE id = ? AND status = 'pending'", [id]);
  if (!row) return null;

  await execute(`
    UPDATE sms_queue SET status = 'failed', error_message = ?, sent_at = ${nowExpr()} WHERE id = ?
  `, [String(errorMessage).slice(0, 500), id]);

  return queryOne('SELECT * FROM sms_queue WHERE id = ?', [id]);
}

export async function queueMessageToCaptains(msg) {
  const targets = msg.captain_id
    ? [await queryOne('SELECT * FROM captains WHERE id = ?', [msg.captain_id])].filter(Boolean)
    : await queryAll('SELECT * FROM captains');

  const queued = [];
  for (const c of targets) {
    queued.push(await queueSms({
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
