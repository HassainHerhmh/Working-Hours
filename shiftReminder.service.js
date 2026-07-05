import { queryAll, queryOne, execute, isMySQL, nowExpr } from './database.js';
import * as smsGw from './smsGateway.service.js';

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const DEFAULT_BODY_WORK =
  'مرحباً {name}، غداً {day} دوامك: الفترة الأولى {period1} — الفترة الثانية {period2}';
const DEFAULT_BODY_OFF = 'مرحباً {name}، غداً {day} يوم إجازة — لا يوجد دوام';

export function getYemenNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Aden' }));
}

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

function formatTime12Ar(time) {
  const normalized = normalizeTime(time);
  if (!normalized) return '';
  const [hStr, mStr] = normalized.split(':');
  let h = Number(hStr);
  const mins = Number(mStr);
  if (Number.isNaN(h)) return time;
  const period = h >= 12 ? 'م' : 'ص';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  if (mins === 0) return `${h} ${period}`;
  return `${h}:${String(mins).padStart(2, '0')} ${period}`;
}

function formatTimeRangeAr(start, end) {
  return `${formatTime12Ar(start)} — ${formatTime12Ar(end)}`;
}

function enrichShift(shift) {
  if (!shift) return null;
  const period_count = Number(shift.period_count) === 1 ? 1 : 2;
  const period1_start = normalizeTime(shift.start_time);
  const period1_end = normalizeTime(shift.period1_end || '12:00');
  const break_minutes = Number(
    shift.break_minutes ?? Math.round(Number(shift.break_hours ?? 2) * 60)
  );
  const period2_start = normalizeTime(shift.period2_start || '14:00');
  const period2_end = normalizeTime(shift.end_time);
  const break_hours = Math.floor(break_minutes / 60);
  const break_mins = break_minutes % 60;
  let breakLabel = break_mins ? `${break_hours}س ${break_mins}د` : `${break_hours}س`;
  if (!break_hours && break_mins) breakLabel = `${break_mins}د`;
  const schedule_label = period_count === 1
    ? formatTimeRangeAr(period1_start, period2_end)
    : `${formatTimeRangeAr(period1_start, period1_end)} | راحة ${breakLabel} | ${formatTimeRangeAr(period2_start, period2_end)}`;
  return {
    period_count,
    period1_start,
    period1_end: period_count === 1 ? period2_end : period1_end,
    period2_start,
    period2_end,
    break_label: breakLabel,
    schedule_label,
  };
}

function applyTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

export async function getShiftReminderConfig() {
  let row = await queryOne('SELECT * FROM shift_reminder_config WHERE id = 1');
  if (!row) {
    await execute(
      `INSERT INTO shift_reminder_config (id, send_time, body_work, body_off, is_active)
       VALUES (1, '09:00', ?, ?, 0)`,
      [DEFAULT_BODY_WORK, DEFAULT_BODY_OFF]
    );
    row = await queryOne('SELECT * FROM shift_reminder_config WHERE id = 1');
  }
  return row;
}

export async function saveShiftReminderConfig(data) {
  const existing = await getShiftReminderConfig();
  const send_time = normalizeTime(data.send_time || existing.send_time || '09:00');
  const body_work = (data.body_work ?? existing.body_work ?? DEFAULT_BODY_WORK).trim();
  const body_off = (data.body_off ?? existing.body_off ?? DEFAULT_BODY_OFF).trim();
  const is_active = data.is_active !== undefined ? (data.is_active ? 1 : 0) : existing.is_active;

  if (isMySQL) {
    await execute(
      `INSERT INTO shift_reminder_config (id, send_time, body_work, body_off, is_active)
       VALUES (1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE send_time = ?, body_work = ?, body_off = ?, is_active = ?`,
      [send_time, body_work, body_off, is_active, send_time, body_work, body_off, is_active]
    );
  } else {
    await execute(
      `UPDATE shift_reminder_config SET send_time = ?, body_work = ?, body_off = ?, is_active = ? WHERE id = 1`,
      [send_time, body_work, body_off, is_active]
    );
  }
  return getShiftReminderConfig();
}

export function buildTomorrowMessage(captain, tomorrowShift, config) {
  const tomorrow = getYemenNow();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayName = DAYS[tomorrow.getDay()];

  const vars = {
    name: captain.name,
    day: dayName,
    period1: '',
    period2: '',
    schedule: '',
    break: '',
  };

  if (tomorrowShift) {
    const s = enrichShift(tomorrowShift);
    vars.period1 = formatTimeRangeAr(s.period1_start, s.period1_end);
    vars.period2 = s.period_count === 1 ? '' : formatTimeRangeAr(s.period2_start, s.period2_end);
    vars.schedule = s.schedule_label;
    vars.break = s.period_count === 1 ? '' : s.break_label;
    return applyTemplate(config.body_work, vars);
  }

  return applyTemplate(config.body_off, vars);
}

export async function processShiftReminders() {
  const config = await getShiftReminderConfig();
  if (!config.is_active) return;

  const now = getYemenNow();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const sendTime = normalizeTime(config.send_time);

  if (currentTime !== sendTime) return;

  const todayKey = yemenDateKey(now);
  if (config.last_sent_date === todayKey) return;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDay = tomorrow.getDay();

  const captains = await queryAll('SELECT * FROM captains');
  let queued = 0;

  for (const captain of captains) {
    const shift = await queryOne(
      'SELECT * FROM shifts WHERE captain_id = ? AND day_of_week = ? AND is_active = 1',
      [captain.id, tomorrowDay]
    );
    const body = buildTomorrowMessage(captain, shift, config);
    await smsGw.queueSms({
      recipientPhone: captain.phone,
      message: body,
      messageId: null,
      captainId: captain.id,
      captainName: captain.name,
      smsType: 'shift_reminder',
    });
    queued++;
  }

  await execute('UPDATE shift_reminder_config SET last_sent_date = ? WHERE id = 1', [todayKey]);
  if (queued > 0) {
    console.log(`📩 Shift reminders queued: ${queued} captains at ${sendTime} (Yemen)`);
  }
}

export const SHIFT_REMINDER_PLACEHOLDERS = [
  { key: '{name}', label: 'اسم الكابتن' },
  { key: '{day}', label: 'اسم يوم الغد' },
  { key: '{period1}', label: 'الفترة الأولى' },
  { key: '{period2}', label: 'الفترة الثانية' },
  { key: '{schedule}', label: 'الجدول الكامل' },
  { key: '{break}', label: 'وقت الراحة' },
];
