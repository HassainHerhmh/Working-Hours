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

function resolveAttendanceStatus({ hasShift, checkin, override }) {
  if (override?.status) return override.status;
  if (!hasShift) return 'off';
  if (checkin) return 'present';
  return 'absent';
}

async function loadCaptainsForReport({ captain_id, group_id } = {}) {
  let sql = `
    SELECT c.id, c.name, c.captain_number, c.group_id, g.name AS group_name
    FROM captains c
    LEFT JOIN captain_groups g ON g.id = c.group_id
    WHERE 1=1`;
  const params = [];
  if (captain_id) {
    sql += ' AND c.id = ?';
    params.push(captain_id);
  }
  if (group_id) {
    sql += ' AND c.group_id = ?';
    params.push(group_id);
  }
  sql += ' ORDER BY g.name ASC, c.name ASC';
  return queryAll(sql, params);
}

async function loadOverrideMap(from, to, captainIds = null) {
  let sql = `
    SELECT captain_id, check_date, status, note
    FROM attendance_overrides
    WHERE check_date >= ? AND check_date <= ?`;
  const params = [from, to];
  if (captainIds?.length) {
    sql += ` AND captain_id IN (${captainIds.map(() => '?').join(',')})`;
    params.push(...captainIds);
  }
  const rows = await queryAll(sql, params);
  return new Map(rows.map((row) => [`${row.captain_id}:${row.check_date}`, row]));
}

function bumpStatusSummary(summary, status) {
  if (status === 'present') summary.present += 1;
  else if (status === 'absent') summary.absent += 1;
  else if (status === 'excused') summary.excused += 1;
  else summary.off += 1;
}

function emptyStatusSummary() {
  return { present: 0, absent: 0, excused: 0, off: 0 };
}

export async function saveAttendanceOverride({ captain_id, check_date, status, note }) {
  const valid = ['present', 'absent', 'excused', 'off'];
  if (!captain_id || !check_date) throw new Error('الكابتن والتاريخ مطلوبان');
  if (!valid.includes(status)) throw new Error('حالة التحضير غير صالحة');

  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captain_id]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const existing = await queryOne(
    'SELECT id FROM attendance_overrides WHERE captain_id = ? AND check_date = ?',
    [captain_id, check_date]
  );
  if (existing) {
    await execute(
      'UPDATE attendance_overrides SET status = ?, note = ? WHERE id = ?',
      [status, note || '', existing.id]
    );
  } else {
    await execute(
      'INSERT INTO attendance_overrides (id, captain_id, check_date, status, note) VALUES (?, ?, ?, ?, ?)',
      [uuid(), captain_id, check_date, status, note || '']
    );
  }
  return { ok: true };
}

export async function clearAttendanceOverride(captain_id, check_date) {
  await execute(
    'DELETE FROM attendance_overrides WHERE captain_id = ? AND check_date = ?',
    [captain_id, check_date]
  );
  return { ok: true };
}

export async function getAttendanceReport({ period = 'day', date, captain_id, group_id }) {
  const range = getDateRange(period, date);
  const captains = await loadCaptainsForReport({ captain_id, group_id });
  const captainIds = captains.map((c) => c.id);
  const overrideMap = await loadOverrideMap(range.from, range.to, captainIds.length ? captainIds : null);

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
  const summary = emptyStatusSummary();

  for (const captain of captains) {
    const shiftDays = shiftMap.get(captain.id) || new Set();

    for (const dateKey of range.dates) {
      const d = parseDateKey(dateKey);
      const dayOfWeek = d.getDay();
      const hasShift = shiftDays.has(dayOfWeek);
      const checkin = checkinMap.get(`${captain.id}:${dateKey}`);
      const override = overrideMap.get(`${captain.id}:${dateKey}`);
      const status = resolveAttendanceStatus({ hasShift, checkin, override });

      bumpStatusSummary(summary, status);

      rows.push({
        captain_id: captain.id,
        captain_name: captain.name,
        captain_number: captain.captain_number,
        group_id: captain.group_id || null,
        group_name: captain.group_name || '',
        date: dateKey,
        day_name: DAYS[dayOfWeek],
        status,
        checked_in_at: checkin?.checked_in_at || null,
        checked_in_time: formatCheckInTime(checkin?.checked_in_at),
        has_shift: hasShift,
        is_manual: Boolean(override),
        note: override?.note || '',
      });
    }
  }

  const filteredRows = period === 'day'
    ? rows
    : rows.filter(r => r.has_shift || r.is_manual);

  return {
    period,
    from: range.from,
    to: range.to,
    summary,
    rows: filteredRows,
  };
}

export async function getAttendanceMonthlyMatrix({ date, captain_id, group_id }) {
  const range = getDateRange('month', date);
  const captains = await loadCaptainsForReport({ captain_id, group_id });
  const captainIds = captains.map((c) => c.id);
  const overrideMap = await loadOverrideMap(range.from, range.to, captainIds.length ? captainIds : null);

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

  const days = range.dates.map((dateKey) => {
    const d = parseDateKey(dateKey);
    return {
      date: dateKey,
      day: d.getDate(),
      day_name: DAYS[d.getDay()],
      day_of_week: d.getDay(),
    };
  });

  const rows = captains.map((captain) => {
    const shiftDays = shiftMap.get(captain.id) || new Set();
    const summary = emptyStatusSummary();

    const cells = days.map((day) => {
      const hasShift = shiftDays.has(day.day_of_week);
      const checkin = checkinMap.get(`${captain.id}:${day.date}`);
      const override = overrideMap.get(`${captain.id}:${day.date}`);
      const status = resolveAttendanceStatus({ hasShift, checkin, override });
      bumpStatusSummary(summary, status);

      return {
        date: day.date,
        day: day.day,
        day_name: day.day_name,
        status,
        has_shift: hasShift,
        checked_in_at: checkin?.checked_in_at || null,
        checked_in_time: formatCheckInTime(checkin?.checked_in_at),
        is_manual: Boolean(override),
        note: override?.note || '',
      };
    });

    return {
      captain_id: captain.id,
      captain_name: captain.name,
      captain_number: captain.captain_number,
      group_id: captain.group_id || null,
      group_name: captain.group_name || '',
      summary,
      cells,
    };
  });

  const summary = rows.reduce((acc, row) => {
    acc.present += row.summary.present;
    acc.absent += row.summary.absent;
    acc.excused += row.summary.excused;
    acc.off += row.summary.off;
    return acc;
  }, emptyStatusSummary());

  return {
    period: 'month',
    from: range.from,
    to: range.to,
    days,
    rows,
    summary,
  };
}
