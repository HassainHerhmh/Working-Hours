import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute, toDbDateTime } from './database.js';
import { getYemenNow } from './shiftReminder.service.js';

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function yemenDateKey(d = getYemenNow()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function daysSinceSaturday(date) {
  return (date.getDay() + 1) % 7;
}

export function getDateRange(period, refDateKey) {
  const ref = parseDateKey(refDateKey || yemenDateKey());
  let from;
  let to;

  if (period === 'week') {
    from = addDays(ref, -daysSinceSaturday(ref));
    to = addDays(from, 6);
  } else if (period === 'month') {
    from = new Date(ref.getFullYear(), ref.getMonth(), 1);
    to = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  } else {
    from = ref;
    to = ref;
  }

  return {
    from: yemenDateKey(from),
    to: yemenDateKey(to),
    dates: enumerateDates(from, to),
  };
}

function enumerateDates(from, to) {
  const dates = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(yemenDateKey(cur));
    cur = addDays(cur, 1);
  }
  return dates;
}

function parseStoredUtcDatetime(value) {
  if (!value) return null;
  const raw = String(value);
  const d = raw.includes('T')
    ? new Date(raw)
    : new Date(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatCheckInTime(checkedInAt) {
  const d = parseStoredUtcDatetime(checkedInAt);
  if (!d) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  let h = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const mins = parts.find(p => p.type === 'minute')?.value || '00';
  const period = h >= 12 ? 'م' : 'ص';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mins} ${period}`;
}

export async function getCheckInStatus(captainId, dateKey = yemenDateKey()) {
  const row = await queryOne(
    'SELECT * FROM attendance_checkins WHERE captain_id = ? AND check_date = ?',
    [captainId, dateKey]
  );
  return {
    checked_in: Boolean(row),
    checked_in_at: row?.checked_in_at || null,
    check_date: dateKey,
  };
}

export async function recordCheckIn(captainId) {
  const captain = await queryOne('SELECT id, name FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const today = getYemenNow();
  const checkDate = yemenDateKey(today);
  const dayOfWeek = today.getDay();

  const shift = await queryOne(
    'SELECT id FROM shifts WHERE captain_id = ? AND day_of_week = ? AND is_active = 1',
    [captainId, dayOfWeek]
  );
  if (!shift) throw new Error('لا يوجد دوام اليوم — لا يمكن تسجيل الحضور');

  const existing = await queryOne(
    'SELECT * FROM attendance_checkins WHERE captain_id = ? AND check_date = ?',
    [captainId, checkDate]
  );
  if (existing) {
    return {
      ok: true,
      already: true,
      checked_in_at: existing.checked_in_at,
      check_date: checkDate,
    };
  }

  const id = uuid();
  const checkedInAt = toDbDateTime(new Date());
  await execute(
    'INSERT INTO attendance_checkins (id, captain_id, check_date, checked_in_at) VALUES (?, ?, ?, ?)',
    [id, captainId, checkDate, checkedInAt]
  );

  const row = await queryOne('SELECT * FROM attendance_checkins WHERE id = ?', [id]);
  return {
    ok: true,
    already: false,
    checked_in_at: row.checked_in_at,
    check_date: checkDate,
  };
}

export async function getAttendanceReport({ period = 'day', date, captain_id }) {
  const range = getDateRange(period, date);
  const captains = captain_id
    ? [await queryOne('SELECT id, name, captain_number FROM captains WHERE id = ?', [captain_id])].filter(Boolean)
    : await queryAll('SELECT id, name, captain_number FROM captains ORDER BY name');

  const checkins = await queryAll(
    `SELECT captain_id, check_date, checked_in_at FROM attendance_checkins
     WHERE check_date >= ? AND check_date <= ?`,
    [range.from, range.to]
  );
  const checkinMap = new Map(checkins.map(c => [`${c.captain_id}:${c.check_date}`, c]));

  const allShifts = await queryAll(
    'SELECT captain_id, day_of_week FROM shifts WHERE is_active = 1'
  );
  const shiftMap = new Map();
  for (const s of allShifts) {
    if (!shiftMap.has(s.captain_id)) shiftMap.set(s.captain_id, new Set());
    shiftMap.get(s.captain_id).add(s.day_of_week);
  }

  const rows = [];
  let present = 0;
  let absent = 0;
  let off = 0;

  for (const captain of captains) {
    const shiftDays = shiftMap.get(captain.id) || new Set();

    for (const dateKey of range.dates) {
      const d = parseDateKey(dateKey);
      const dayOfWeek = d.getDay();
      const hasShift = shiftDays.has(dayOfWeek);
      const checkin = checkinMap.get(`${captain.id}:${dateKey}`);

      let status;
      if (!hasShift) {
        status = 'off';
        off += 1;
      } else if (checkin) {
        status = 'present';
        present += 1;
      } else {
        status = 'absent';
        absent += 1;
      }

      rows.push({
        captain_id: captain.id,
        captain_name: captain.name,
        captain_number: captain.captain_number,
        date: dateKey,
        day_name: DAYS[dayOfWeek],
        status,
        checked_in_at: checkin?.checked_in_at || null,
        checked_in_time: formatCheckInTime(checkin?.checked_in_at),
        has_shift: hasShift,
      });
    }
  }

  const filteredRows = period === 'day'
    ? rows
    : rows.filter(r => r.has_shift);

  return {
    period,
    from: range.from,
    to: range.to,
    summary: { present, absent, off },
    rows: filteredRows,
  };
}
