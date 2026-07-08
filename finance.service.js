import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute, isMySQL } from './database.js';
import { getDateRange, yemenDateKey } from './attendance.service.js';

function num(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function toDateKey(value) {
  if (!value) return '';
  const raw = String(value);
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return yemenDateKey(d);
}

function inDateRange(value, from, to) {
  const key = toDateKey(value);
  return key && key >= from && key <= to;
}

function isBeforeDate(value, beforeKey) {
  const key = toDateKey(value);
  return key && key < beforeKey;
}

function dayBeforeKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return yemenDateKey(dt);
}

function postingSalesDateKey(posting) {
  if (!posting) return '';
  return posting.sales_date || toDateKey(posting.posted_at);
}

function postingInSalesRange(posting, from, to) {
  const key = postingSalesDateKey(posting);
  return key && key >= from && key <= to;
}

function commissionSalesDateKey(posting) {
  if (!posting) return '';
  return posting.sales_date || toDateKey(posting.posted_at);
}

function commissionInSalesRange(posting, from, to) {
  const key = commissionSalesDateKey(posting);
  return key && key >= from && key <= to;
}

function voucherDateKey(v) {
  if (!v) return '';
  return v.voucher_date || toDateKey(v.created_at);
}

function voucherInDateRange(v, from, to) {
  const key = voucherDateKey(v);
  return key && key >= from && key <= to;
}

async function buildPreviousBalance(captainId, range, config, allVouchers) {
  const from = range.from;
  const priorVouchers = allVouchers.filter(v => voucherDateKey(v) < from);

  const invoiceRows = await queryAll(
    'SELECT total_invoices, transfers_debts FROM finance_invoice_postings WHERE captain_id = ? AND sales_date < ?',
    [captainId, from]
  );
  const commissionRows = await queryAll(
    'SELECT total_commission, rent FROM finance_commission_postings WHERE captain_id = ? AND sales_date < ?',
    [captainId, from]
  );

  const total_invoices = invoiceRows.reduce((s, r) => s + num(r.total_invoices), 0);
  const transfers_debts = invoiceRows.reduce((s, r) => s + num(r.transfers_debts), 0);
  const total_commission = commissionRows.reduce((s, r) => s + num(r.total_commission), 0);
  const rent = commissionRows.reduce((s, r) => s + num(r.rent), 0);

  if (!total_invoices && !transfers_debts && !total_commission && !rent && priorVouchers.length === 0) {
    return null;
  }

  const invoices = total_invoices > 0 ? [{ amount: total_invoices }] : [];
  const summary = buildFinanceSummary(
    { transfers_debts, rent, total_commission },
    invoices,
    config,
    priorVouchers
  );

  if (Math.abs(summary.remaining_for_company) < 0.01) {
    return null;
  }

  return {
    ...summary,
    to: dayBeforeKey(from),
  };
}

export function buildFinanceSummary(finance, invoices, config, vouchers = []) {
  const total_invoices = invoices.reduce((s, row) => s + num(row.amount), 0);
  const transfers_debts = num(finance?.transfers_debts);
  const rent = num(finance?.rent);
  const total_commission = num(finance?.total_commission);
  const company_rate = num(config?.company_commission_rate);
  const company_commission = num(total_commission * company_rate / 100);
  const captain_commission = num(total_commission - company_commission);
  const net_delivery_fees = num(total_commission - company_commission - rent);

  const total_disbursement = vouchers
    .filter(v => v.voucher_type === 'disbursement')
    .reduce((s, v) => s + num(v.amount), 0);
  const total_receipt = vouchers
    .filter(v => v.voucher_type === 'receipt')
    .reduce((s, v) => s + num(v.amount), 0);

  const remaining_for_company = num(
    total_invoices - transfers_debts + company_commission + rent
    + total_disbursement - total_receipt
  );

  return {
    total_invoices,
    transfers_debts,
    rent,
    total_commission,
    company_commission_rate: company_rate,
    company_commission,
    captain_commission,
    net_delivery_fees,
    total_disbursement,
    total_receipt,
    remaining_for_company,
    vouchers: vouchers.map(v => ({
      id: v.id,
      voucher_type: v.voucher_type,
      transfer_group_id: v.transfer_group_id || null,
      transfer_role: v.transfer_group_id
        ? (v.voucher_type === 'disbursement' ? 'from' : 'to')
        : null,
      counterpart_name: v.counterpart_name || '',
      counterpart_number: v.counterpart_number || '',
      amount: num(v.amount),
      note: v.note || '',
      voucher_date: voucherDateKey(v),
      created_at: v.created_at,
    })),
    invoices: invoices.map(row => ({
      id: row.id,
      store_id: row.store_id,
      store_name: row.store_name,
      amount: num(row.amount),
    })),
  };
}

export async function getFinanceConfig() {
  let row = await queryOne('SELECT * FROM finance_config WHERE id = 1');
  if (!row) {
    await execute(
      'INSERT INTO finance_config (id, company_commission_rate) VALUES (1, 20)',
      []
    );
    row = await queryOne('SELECT * FROM finance_config WHERE id = 1');
  }
  return row;
}

export async function saveFinanceConfig({ company_commission_rate }) {
  const rate = num(company_commission_rate);
  if (isMySQL) {
    await execute(
      `INSERT INTO finance_config (id, company_commission_rate) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE company_commission_rate = ?`,
      [rate, rate]
    );
  } else {
    await execute(
      'UPDATE finance_config SET company_commission_rate = ? WHERE id = 1',
      [rate]
    );
  }
  return getFinanceConfig();
}

export async function listStores() {
  return queryAll('SELECT * FROM finance_stores ORDER BY name');
}

export async function createStore(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم المحل مطلوب');
  const id = uuid();
  await execute('INSERT INTO finance_stores (id, name) VALUES (?, ?)', [id, trimmed]);
  return queryOne('SELECT * FROM finance_stores WHERE id = ?', [id]);
}

export async function updateStore(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم المحل مطلوب');
  await execute('UPDATE finance_stores SET name = ? WHERE id = ?', [trimmed, id]);
  return queryOne('SELECT * FROM finance_stores WHERE id = ?', [id]);
}

export async function deleteStore(id) {
  await execute('DELETE FROM captain_store_invoices WHERE store_id = ?', [id]);
  await execute('DELETE FROM finance_stores WHERE id = ?', [id]);
  return { ok: true };
}

async function getCaptainFinanceRow(captainId) {
  let row = await queryOne('SELECT * FROM captain_finances WHERE captain_id = ?', [captainId]);
  if (!row) {
    await execute(
      'INSERT INTO captain_finances (captain_id, transfers_debts, rent, total_commission) VALUES (?, 0, 0, 0)',
      [captainId]
    );
    row = await queryOne('SELECT * FROM captain_finances WHERE captain_id = ?', [captainId]);
  }
  return row;
}

async function getCaptainInvoices(captainId, dateFilter) {
  let sql = `
    SELECT i.id, i.store_id, i.amount, i.sales_date, s.name AS store_name
    FROM captain_store_invoices i
    JOIN finance_stores s ON s.id = i.store_id
    WHERE i.captain_id = ?`;
  const params = [captainId];

  if (typeof dateFilter === 'string') {
    sql += ' AND i.sales_date = ?';
    params.push(dateFilter);
  } else if (dateFilter?.from && dateFilter?.to) {
    sql += ' AND i.sales_date >= ? AND i.sales_date <= ?';
    params.push(dateFilter.from, dateFilter.to);
  } else if (dateFilter?.before) {
    sql += ' AND i.sales_date < ?';
    params.push(dateFilter.before);
  }

  sql += ' ORDER BY s.name';
  return queryAll(sql, params);
}

async function getCaptainVouchers(captainId) {
  return queryAll(
    `SELECT v.*, tc.name AS counterpart_name, tc.captain_number AS counterpart_number
     FROM finance_vouchers v
     LEFT JOIN captains tc ON tc.id = v.counterpart_captain_id
     WHERE v.captain_id = ?
     ORDER BY v.created_at DESC`,
    [captainId]
  );
}

export async function getCaptainBalancesMap() {
  const config = await getFinanceConfig();
  const invoiceRows = await queryAll(
    `SELECT captain_id,
      COALESCE(SUM(total_invoices), 0) AS total_invoices,
      COALESCE(SUM(transfers_debts), 0) AS transfers_debts
     FROM finance_invoice_postings
     GROUP BY captain_id`
  );
  const commissionRows = await queryAll(
    `SELECT captain_id,
      COALESCE(SUM(total_commission), 0) AS total_commission,
      COALESCE(SUM(rent), 0) AS rent
     FROM finance_commission_postings
     GROUP BY captain_id`
  );
  const voucherRows = await queryAll('SELECT * FROM finance_vouchers');

  const map = new Map();
  for (const row of invoiceRows) {
    map.set(row.captain_id, {
      total_invoices: num(row.total_invoices),
      transfers_debts: num(row.transfers_debts),
      total_commission: 0,
      rent: 0,
      vouchers: [],
    });
  }
  for (const row of commissionRows) {
    const current = map.get(row.captain_id) || {
      total_invoices: 0,
      transfers_debts: 0,
      total_commission: 0,
      rent: 0,
      vouchers: [],
    };
    current.total_commission = num(row.total_commission);
    current.rent = num(row.rent);
    map.set(row.captain_id, current);
  }
  for (const voucher of voucherRows) {
    const current = map.get(voucher.captain_id) || {
      total_invoices: 0,
      transfers_debts: 0,
      total_commission: 0,
      rent: 0,
      vouchers: [],
    };
    current.vouchers.push(voucher);
    map.set(voucher.captain_id, current);
  }

  const balances = {};
  for (const [captainId, row] of map.entries()) {
    const summary = buildFinanceSummary(
      {
        transfers_debts: row.transfers_debts,
        rent: row.rent,
        total_commission: row.total_commission,
      },
      row.total_invoices > 0 ? [{ amount: row.total_invoices }] : [],
      config,
      row.vouchers
    );
    balances[captainId] = summary.remaining_for_company;
  }
  return balances;
}

export async function getCaptainFinance(captainId, { period, date, sales_date } = {}) {
  const captain = await queryOne('SELECT id, name, captain_number FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const finance = await getCaptainFinanceRow(captainId);
  const allVouchers = await getCaptainVouchers(captainId);
  const config = await getFinanceConfig();
  const normalizedSalesDate = sales_date ? normalizeSalesDate(sales_date) : null;

  let range = null;
  if (period && ['day', 'week', 'month'].includes(period)) {
    range = getDateRange(period, date);
  }

  let invoices = [];
  let transfers_debts = 0;
  let orders_count = 0;
  let rent = num(finance?.rent);
  let total_commission = num(finance?.total_commission);
  let total_invoices = 0;
  let vouchers = allVouchers;
  let previous_balance = null;

  if (normalizedSalesDate) {
    const posting = await queryOne(
      'SELECT * FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
      [captainId, normalizedSalesDate]
    );
    invoices = await getCaptainInvoices(captainId, normalizedSalesDate);
    transfers_debts = posting ? num(posting.transfers_debts) : 0;
    orders_count = posting ? Number(posting.orders_count || 0) : 0;
    total_invoices = posting
      ? num(posting.total_invoices)
      : invoices.reduce((s, row) => s + num(row.amount), 0);

    const commissionPosting = await queryOne(
      'SELECT * FROM finance_commission_postings WHERE captain_id = ? AND sales_date = ?',
      [captainId, normalizedSalesDate]
    );
    rent = commissionPosting ? num(commissionPosting.rent) : 0;
    total_commission = commissionPosting ? num(commissionPosting.total_commission) : 0;
    vouchers = [];
  } else if (range) {
    vouchers = allVouchers.filter(v => voucherInDateRange(v, range.from, range.to));

    const postingsInRange = await queryAll(
      'SELECT * FROM finance_invoice_postings WHERE captain_id = ? AND sales_date >= ? AND sales_date <= ?',
      [captainId, range.from, range.to]
    );
    transfers_debts = postingsInRange.reduce((s, p) => s + num(p.transfers_debts), 0);
    orders_count = postingsInRange.reduce((s, p) => s + Number(p.orders_count || 0), 0);
    total_invoices = postingsInRange.reduce((s, p) => s + num(p.total_invoices), 0);
    invoices = await getCaptainInvoices(captainId, { from: range.from, to: range.to });

    const commissionInRange = await queryAll(
      'SELECT * FROM finance_commission_postings WHERE captain_id = ? AND sales_date >= ? AND sales_date <= ?',
      [captainId, range.from, range.to]
    );
    if (commissionInRange.length) {
      rent = commissionInRange.reduce((s, p) => s + num(p.rent), 0);
      total_commission = commissionInRange.reduce((s, p) => s + num(p.total_commission), 0);
    } else {
      rent = 0;
      total_commission = 0;
    }

    if (period === 'day' || period === 'week') {
      previous_balance = await buildPreviousBalance(captainId, range, config, allVouchers);
    }
  } else {
    invoices = await getCaptainInvoices(captainId);
    transfers_debts = num(finance?.transfers_debts);
    total_invoices = invoices.reduce((s, row) => s + num(row.amount), 0);
  }

  const summary = buildFinanceSummary(
    { ...finance, transfers_debts, rent, total_commission },
    invoices,
    config,
    vouchers
  );

  return {
    captain,
    finance,
    config,
    period: period || null,
    from: range?.from || null,
    to: range?.to || null,
    sales_date: normalizedSalesDate,
    previous_balance,
    orders_count,
    ...summary,
    total_invoices,
  };
}

export async function saveCaptainFinance(captainId, data) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const sales_date = normalizeSalesDate(data.sales_date);

  await getCaptainFinanceRow(captainId);

  if (Array.isArray(data.invoices)) {
    await execute(
      'DELETE FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ?',
      [captainId, sales_date]
    );
    let totalInvoices = 0;
    for (const inv of data.invoices) {
      const amount = num(inv.amount);
      if (!inv.store_id || amount <= 0) continue;
      totalInvoices += amount;
      await execute(
        'INSERT INTO captain_store_invoices (id, captain_id, store_id, amount, sales_date) VALUES (?, ?, ?, ?, ?)',
        [uuid(), captainId, inv.store_id, amount, sales_date]
      );
    }
    await recordInvoicePosting(
      captainId,
      totalInvoices,
      Number(data.orders_count || 0),
      num(data.transfers_debts),
      sales_date
    );
  }

  return getCaptainFinance(captainId, { sales_date });
}

function normalizeSalesDate(value) {
  const key = String(value || yemenDateKey()).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : yemenDateKey();
}

async function recordInvoicePosting(captainId, totalInvoices, ordersCount, transfersDebts, salesDate) {
  if (totalInvoices <= 0 && transfersDebts <= 0 && Number(ordersCount || 0) <= 0) return;

  const sales_date = normalizeSalesDate(salesDate);
  const existing = await queryOne(
    'SELECT id FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, sales_date]
  );

  if (existing) {
    await execute(
      `UPDATE finance_invoice_postings SET total_invoices = ?, orders_count = ?, transfers_debts = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"} WHERE id = ?`,
      [num(totalInvoices), Number(ordersCount || 0), num(transfersDebts), existing.id]
    );
  } else {
    await execute(
      'INSERT INTO finance_invoice_postings (id, captain_id, total_invoices, orders_count, transfers_debts, sales_date) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), captainId, num(totalInvoices), Number(ordersCount || 0), num(transfersDebts), sales_date]
    );
  }
}

export async function listInvoicePostings() {
  return queryAll(`
    SELECT p.*, c.name AS captain_name, c.captain_number
    FROM finance_invoice_postings p
    JOIN captains c ON c.id = p.captain_id
    ORDER BY p.posted_at DESC
  `);
}

export async function deleteInvoicePosting(postingId) {
  const posting = await queryOne('SELECT * FROM finance_invoice_postings WHERE id = ?', [postingId]);
  if (!posting) throw new Error('سجل الترحيل غير موجود');

  const salesDate = posting.sales_date || toDateKey(posting.posted_at);
  await execute(
    'DELETE FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ?',
    [posting.captain_id, salesDate]
  );
  await execute('DELETE FROM finance_invoice_postings WHERE id = ?', [postingId]);
  return { ok: true, captain_id: posting.captain_id, sales_date: salesDate };
}

async function recordCommissionPosting(captainId, totalCommission, rent, salesDate) {
  if (totalCommission <= 0 && rent <= 0) return;

  const sales_date = normalizeSalesDate(salesDate);
  const existing = await queryOne(
    'SELECT id FROM finance_commission_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, sales_date]
  );

  if (existing) {
    await execute(
      `UPDATE finance_commission_postings SET total_commission = ?, rent = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"} WHERE id = ?`,
      [num(totalCommission), num(rent), existing.id]
    );
  } else {
    await execute(
      'INSERT INTO finance_commission_postings (id, captain_id, total_commission, rent, sales_date) VALUES (?, ?, ?, ?, ?)',
      [uuid(), captainId, num(totalCommission), num(rent), sales_date]
    );
  }
}

export async function saveCaptainCommission(captainId, { total_commission, rent, sales_date }) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const totalCommission = num(total_commission);
  const rentAmount = num(rent);
  const normalizedDate = normalizeSalesDate(sales_date);

  await getCaptainFinanceRow(captainId);
  await recordCommissionPosting(captainId, totalCommission, rentAmount, normalizedDate);

  return getCaptainFinance(captainId, { sales_date: normalizedDate });
}

export async function listCommissionPostings() {
  return queryAll(`
    SELECT p.*, c.name AS captain_name, c.captain_number
    FROM finance_commission_postings p
    JOIN captains c ON c.id = p.captain_id
    ORDER BY p.posted_at DESC
  `);
}

export async function deleteCommissionPosting(postingId) {
  const posting = await queryOne('SELECT * FROM finance_commission_postings WHERE id = ?', [postingId]);
  if (!posting) throw new Error('سجل العمولة غير موجود');

  await execute('DELETE FROM finance_commission_postings WHERE id = ?', [postingId]);
  return { ok: true, captain_id: posting.captain_id, sales_date: posting.sales_date };
}

export async function createVoucher(captainId, { voucher_type, amount, note, voucher_date }) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const type = voucher_type === 'receipt' ? 'receipt' : 'disbursement';
  const amt = num(amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  const id = uuid();
  const dateKey = normalizeSalesDate(voucher_date);
  await execute(
    'INSERT INTO finance_vouchers (id, captain_id, voucher_type, amount, note, voucher_date) VALUES (?, ?, ?, ?, ?, ?)',
    [id, captainId, type, amt, String(note || '').trim(), dateKey]
  );
  return queryOne('SELECT * FROM finance_vouchers WHERE id = ?', [id]);
}

async function assertCaptainExists(captainId, label = 'الكابتن') {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error(`${label} غير موجود`);
  return captain;
}

function buildTransferNote(note, fromName, toName) {
  const base = String(note || '').trim();
  const suffix = `تحويل من ${fromName} إلى ${toName}`;
  return base ? `${base} — ${suffix}` : suffix;
}

function mapTransferRow(v) {
  return {
    id: v.id,
    transfer_group_id: v.transfer_group_id,
    voucher_type: 'transfer',
    amount: num(v.amount),
    note: v.note || '',
    voucher_date: voucherDateKey(v),
    created_at: v.created_at,
    from_captain_id: v.captain_id,
    from_captain_name: v.captain_name,
    from_captain_number: v.captain_number,
    to_captain_id: v.counterpart_captain_id,
    to_captain_name: v.counterpart_name,
    to_captain_number: v.counterpart_number,
    captain_id: v.captain_id,
    captain_name: v.captain_name,
    captain_number: v.captain_number,
  };
}

function normalizeVoucherList(rows) {
  const out = [];
  const seenTransfers = new Set();
  for (const v of rows) {
    if (v.transfer_group_id) {
      if (v.voucher_type !== 'disbursement') continue;
      if (seenTransfers.has(v.transfer_group_id)) continue;
      seenTransfers.add(v.transfer_group_id);
      out.push(mapTransferRow(v));
    } else {
      out.push(v);
    }
  }
  return out;
}

const voucherListSql = `
  SELECT v.*, c.name AS captain_name, c.captain_number,
    tc.name AS counterpart_name, tc.captain_number AS counterpart_number
  FROM finance_vouchers v
  JOIN captains c ON c.id = v.captain_id
  LEFT JOIN captains tc ON tc.id = v.counterpart_captain_id
`;

export async function createTransferVoucher({ from_captain_id, to_captain_id, amount, note, voucher_date }) {
  if (!from_captain_id || !to_captain_id) throw new Error('اختر الكابتنين');
  if (from_captain_id === to_captain_id) throw new Error('لا يمكن التحويل لنفس الكابتن');

  await assertCaptainExists(from_captain_id, 'الكابتن المُرسِل');
  await assertCaptainExists(to_captain_id, 'الكابتن المستلم');

  const amt = num(amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  const fromCaptain = await queryOne('SELECT name FROM captains WHERE id = ?', [from_captain_id]);
  const toCaptain = await queryOne('SELECT name FROM captains WHERE id = ?', [to_captain_id]);
  const dateKey = normalizeSalesDate(voucher_date);
  const transferNote = buildTransferNote(note, fromCaptain.name, toCaptain.name);
  const groupId = uuid();
  const fromVoucherId = uuid();
  const toVoucherId = uuid();

  await execute(
    `INSERT INTO finance_vouchers
      (id, captain_id, voucher_type, amount, note, voucher_date, transfer_group_id, counterpart_captain_id)
     VALUES (?, ?, 'disbursement', ?, ?, ?, ?, ?)`,
    [fromVoucherId, from_captain_id, amt, transferNote, dateKey, groupId, to_captain_id]
  );
  await execute(
    `INSERT INTO finance_vouchers
      (id, captain_id, voucher_type, amount, note, voucher_date, transfer_group_id, counterpart_captain_id)
     VALUES (?, ?, 'receipt', ?, ?, ?, ?, ?)`,
    [toVoucherId, to_captain_id, amt, transferNote, dateKey, groupId, from_captain_id]
  );

  const row = await queryOne(
    `${voucherListSql} WHERE v.transfer_group_id = ? AND v.voucher_type = 'disbursement'`,
    [groupId]
  );
  return mapTransferRow(row);
}

export async function updateTransferVoucher(groupId, { from_captain_id, to_captain_id, amount, note, voucher_date }) {
  const pair = await queryAll(
    'SELECT * FROM finance_vouchers WHERE transfer_group_id = ?',
    [groupId]
  );
  if (pair.length !== 2) throw new Error('سند التحويل غير موجود');

  if (!from_captain_id || !to_captain_id) throw new Error('اختر الكابتنين');
  if (from_captain_id === to_captain_id) throw new Error('لا يمكن التحويل لنفس الكابتن');

  await assertCaptainExists(from_captain_id, 'الكابتن المُرسِل');
  await assertCaptainExists(to_captain_id, 'الكابتن المستلم');

  const amt = num(amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  const fromCaptain = await queryOne('SELECT name FROM captains WHERE id = ?', [from_captain_id]);
  const toCaptain = await queryOne('SELECT name FROM captains WHERE id = ?', [to_captain_id]);
  const dateKey = normalizeSalesDate(voucher_date || pair[0].voucher_date);
  const transferNote = buildTransferNote(note, fromCaptain.name, toCaptain.name);

  await execute(
    `UPDATE finance_vouchers
     SET captain_id = ?, amount = ?, note = ?, voucher_date = ?, counterpart_captain_id = ?
     WHERE transfer_group_id = ? AND voucher_type = 'disbursement'`,
    [from_captain_id, amt, transferNote, dateKey, to_captain_id, groupId]
  );
  await execute(
    `UPDATE finance_vouchers
     SET captain_id = ?, amount = ?, note = ?, voucher_date = ?, counterpart_captain_id = ?
     WHERE transfer_group_id = ? AND voucher_type = 'receipt'`,
    [to_captain_id, amt, transferNote, dateKey, from_captain_id, groupId]
  );

  const row = await queryOne(
    `${voucherListSql} WHERE v.transfer_group_id = ? AND v.voucher_type = 'disbursement'`,
    [groupId]
  );
  return mapTransferRow(row);
}

export async function updateVoucher(voucherId, { voucher_type, amount, note, voucher_date, captain_id }) {
  const row = await queryOne('SELECT * FROM finance_vouchers WHERE id = ?', [voucherId]);
  if (!row) throw new Error('السند غير موجود');
  if (row.transfer_group_id) throw new Error('استخدم تعديل سند التحويل');

  const type = voucher_type === 'receipt' ? 'receipt' : 'disbursement';
  const amt = num(amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  let captainId = row.captain_id;
  if (captain_id && captain_id !== row.captain_id) {
    const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captain_id]);
    if (!captain) throw new Error('الكابتن غير موجود');
    captainId = captain_id;
  }

  const dateKey = normalizeSalesDate(voucher_date || row.voucher_date);
  await execute(
    'UPDATE finance_vouchers SET captain_id = ?, voucher_type = ?, amount = ?, note = ?, voucher_date = ? WHERE id = ?',
    [captainId, type, amt, String(note || '').trim(), dateKey, voucherId]
  );
  return queryOne('SELECT * FROM finance_vouchers WHERE id = ?', [voucherId]);
}

export async function deleteVoucher(voucherId) {
  const row = await queryOne('SELECT * FROM finance_vouchers WHERE id = ?', [voucherId]);
  if (row?.transfer_group_id) {
    await execute('DELETE FROM finance_vouchers WHERE transfer_group_id = ?', [row.transfer_group_id]);
  } else {
    await execute('DELETE FROM finance_vouchers WHERE id = ?', [voucherId]);
  }
  return { ok: true };
}

export async function listCaptainVouchers(captainId) {
  return getCaptainVouchers(captainId);
}

export async function listAllVouchers(captainId) {
  let rows;
  if (captainId) {
    rows = await queryAll(
      `${voucherListSql}
       WHERE v.captain_id = ? OR v.counterpart_captain_id = ?
       ORDER BY v.voucher_date DESC, v.created_at DESC`,
      [captainId, captainId]
    );
  } else {
    rows = await queryAll(
      `${voucherListSql}
       ORDER BY v.voucher_date DESC, v.created_at DESC`
    );
  }
  return normalizeVoucherList(rows);
}

function getReportRange(period = 'day', date, from, to) {
  if (period === 'range' && from && to) {
    const safeFrom = String(from).slice(0, 10);
    const safeTo = String(to).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(safeFrom) && /^\d{4}-\d{2}-\d{2}$/.test(safeTo)) {
      return safeFrom <= safeTo
        ? { from: safeFrom, to: safeTo }
        : { from: safeTo, to: safeFrom };
    }
  }
  return getDateRange(['day', 'week', 'month'].includes(period) ? period : 'day', date);
}

export async function getSalesReport({ period = 'day', date, from, to, captain_id }) {
  const range = getReportRange(period, date, from, to);
  const config = await getFinanceConfig();
  const companyRate = num(config.company_commission_rate);

  const rows = await queryAll(
    `SELECT p.*, c.name AS captain_name, c.captain_number
     FROM finance_invoice_postings p
     JOIN captains c ON c.id = p.captain_id
     WHERE p.sales_date >= ? AND p.sales_date <= ?
     ${captain_id ? 'AND p.captain_id = ?' : ''}
     ORDER BY p.sales_date DESC, c.name ASC`,
    captain_id ? [range.from, range.to, captain_id] : [range.from, range.to]
  );

  const commissionRows = await queryAll(
    `SELECT captain_id, sales_date, total_commission, rent
     FROM finance_commission_postings
     WHERE sales_date >= ? AND sales_date <= ?
     ${captain_id ? 'AND captain_id = ?' : ''}`,
    captain_id ? [range.from, range.to, captain_id] : [range.from, range.to]
  );

  const voucherRows = await queryAll(
    `SELECT captain_id, voucher_type, amount, voucher_date
     FROM finance_vouchers
     WHERE voucher_date >= ? AND voucher_date <= ?
     ${captain_id ? 'AND captain_id = ?' : ''}`,
    captain_id ? [range.from, range.to, captain_id] : [range.from, range.to]
  );

  const commissionMap = new Map();
  for (const row of commissionRows) {
    commissionMap.set(`${row.captain_id}:${row.sales_date}`, row);
  }

  const voucherMap = new Map();
  for (const row of voucherRows) {
    const key = `${row.captain_id}:${voucherDateKey(row)}`;
    const current = voucherMap.get(key) || { disbursement: 0, receipt: 0 };
    if (row.voucher_type === 'disbursement') current.disbursement += num(row.amount);
    else current.receipt += num(row.amount);
    voucherMap.set(key, current);
  }

  const mappedRows = rows.map((row) => {
    const total_invoices = num(row.total_invoices);
    const orders_count = Number(row.orders_count || 0);
    const transfers_debts = num(row.transfers_debts);
    const commission = commissionMap.get(`${row.captain_id}:${row.sales_date}`);
    const vouchers = voucherMap.get(`${row.captain_id}:${row.sales_date}`) || { disbursement: 0, receipt: 0 };
    const total_commission = num(commission?.total_commission);
    const rent = num(commission?.rent);
    const company_commission = num(total_commission * companyRate / 100);
    const captain_net_commission = num(total_commission - company_commission - rent);
    const remaining_for_company = num(
      total_invoices - transfers_debts + company_commission + rent
      + vouchers.disbursement - vouchers.receipt
    );

    return {
      ...row,
      total_invoices,
      orders_count,
      transfers_debts,
      total_commission,
      rent,
      company_commission,
      captain_net_commission,
      remaining_for_company,
    };
  });

  const summary = mappedRows.reduce((acc, row) => {
    acc.total_invoices += row.total_invoices;
    acc.orders_count += row.orders_count;
    acc.transfers_debts += row.transfers_debts;
    acc.total_commission += row.total_commission;
    acc.rent += row.rent;
    acc.company_commission += row.company_commission;
    acc.captain_net_commission += row.captain_net_commission;
    acc.remaining_for_company += row.remaining_for_company;
    return acc;
  }, {
    total_invoices: 0,
    orders_count: 0,
    transfers_debts: 0,
    total_commission: 0,
    rent: 0,
    company_commission: 0,
    captain_net_commission: 0,
    remaining_for_company: 0,
  });

  return {
    period,
    from: range.from,
    to: range.to,
    company_commission_rate: companyRate,
    rows: mappedRows,
    summary,
  };
}

export async function getCommissionReport({ period = 'day', date, from, to, captain_id }) {
  const range = getReportRange(period, date, from, to);
  const config = await getFinanceConfig();
  const rows = await queryAll(
    `SELECT p.*, c.name AS captain_name, c.captain_number
     FROM finance_commission_postings p
     JOIN captains c ON c.id = p.captain_id
     WHERE p.sales_date >= ? AND p.sales_date <= ?
     ${captain_id ? 'AND p.captain_id = ?' : ''}
     ORDER BY p.sales_date DESC, c.name ASC`,
    captain_id ? [range.from, range.to, captain_id] : [range.from, range.to]
  );

  const mappedRows = rows.map((row) => {
    const total_commission = num(row.total_commission);
    const rent = num(row.rent);
    const company_commission = num(total_commission * num(config.company_commission_rate) / 100);
    return {
      ...row,
      total_commission,
      rent,
      company_commission,
      captain_commission: num(total_commission - company_commission),
      net_delivery_fees: num(total_commission - company_commission - rent),
    };
  });

  const summary = mappedRows.reduce((acc, row) => {
    acc.total_commission += row.total_commission;
    acc.rent += row.rent;
    acc.company_commission += row.company_commission;
    acc.captain_commission += row.captain_commission;
    acc.net_delivery_fees += row.net_delivery_fees;
    return acc;
  }, {
    total_commission: 0,
    rent: 0,
    company_commission: 0,
    captain_commission: 0,
    net_delivery_fees: 0,
  });

  return {
    period,
    from: range.from,
    to: range.to,
    company_commission_rate: num(config.company_commission_rate),
    rows: mappedRows,
    summary,
  };
}

export async function getRentReport({ period = 'day', date, from, to, captain_id }) {
  const commissionReport = await getCommissionReport({ period, date, from, to, captain_id });
  return {
    period: commissionReport.period,
    from: commissionReport.from,
    to: commissionReport.to,
    rows: commissionReport.rows
      .filter(row => num(row.rent) !== 0)
      .map(row => ({
        id: row.id,
        captain_id: row.captain_id,
        captain_name: row.captain_name,
        captain_number: row.captain_number,
        sales_date: row.sales_date,
        posted_at: row.posted_at,
        rent: row.rent,
      })),
    summary: {
      total_rent: commissionReport.summary.rent,
    },
  };
}

export async function getStoresReport({ period = 'day', date, from, to }) {
  const range = getReportRange(period, date, from, to);
  const rows = await queryAll(
    `SELECT s.id AS store_id, s.name AS store_name, i.sales_date,
        c.id AS captain_id, c.name AS captain_name, c.captain_number, i.amount
     FROM captain_store_invoices i
     JOIN finance_stores s ON s.id = i.store_id
     JOIN captains c ON c.id = i.captain_id
     WHERE i.sales_date >= ? AND i.sales_date <= ?
     ORDER BY i.sales_date DESC, s.name ASC, c.name ASC`,
    [range.from, range.to]
  );

  const byStore = new Map();
  for (const row of rows) {
    const current = byStore.get(row.store_id) || {
      store_id: row.store_id,
      store_name: row.store_name,
      total_sales: 0,
      captain_ids: new Set(),
      entries: [],
    };
    current.total_sales += num(row.amount);
    current.captain_ids.add(row.captain_id);
    current.entries.push({
      captain_id: row.captain_id,
      captain_name: row.captain_name,
      captain_number: row.captain_number,
      sales_date: row.sales_date,
      amount: num(row.amount),
    });
    byStore.set(row.store_id, current);
  }

  const stores = Array.from(byStore.values()).map((store) => ({
    store_id: store.store_id,
    store_name: store.store_name,
    total_sales: num(store.total_sales),
    captains_count: store.captain_ids.size,
    entries_count: store.entries.length,
    entries: store.entries,
  }));

  const summary = stores.reduce((acc, store) => {
    acc.total_sales += store.total_sales;
    acc.entries_count += store.entries_count;
    return acc;
  }, { total_sales: 0, entries_count: 0, stores_count: stores.length });

  return { period, from: range.from, to: range.to, stores, summary };
}
