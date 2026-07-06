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

function buildPreviousBalance(range, posting, commissionPosting, allInvoices, allVouchers, config) {
  const from = range.from;
  const priorVouchers = allVouchers.filter(v => isBeforeDate(v.created_at, from));
  const postingBefore = posting && isBeforeDate(posting.posted_at, from);
  const commissionBefore = commissionPosting && isBeforeDate(commissionPosting.posted_at, from);

  if (!postingBefore && !commissionBefore && priorVouchers.length === 0) {
    return null;
  }

  const invoices = postingBefore ? allInvoices : [];
  const summary = buildFinanceSummary(
    {
      transfers_debts: postingBefore ? num(posting.transfers_debts) : 0,
      rent: commissionBefore ? num(commissionPosting.rent) : 0,
      total_commission: commissionBefore ? num(commissionPosting.total_commission) : 0,
    },
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
      amount: num(v.amount),
      note: v.note || '',
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

async function getCaptainInvoices(captainId) {
  return queryAll(`
    SELECT i.id, i.store_id, i.amount, s.name AS store_name
    FROM captain_store_invoices i
    JOIN finance_stores s ON s.id = i.store_id
    WHERE i.captain_id = ?
    ORDER BY s.name
  `, [captainId]);
}

async function getCaptainVouchers(captainId) {
  return queryAll(
    'SELECT * FROM finance_vouchers WHERE captain_id = ? ORDER BY created_at DESC',
    [captainId]
  );
}

export async function getCaptainFinance(captainId, { period, date } = {}) {
  const captain = await queryOne('SELECT id, name, captain_number FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const finance = await getCaptainFinanceRow(captainId);
  const allInvoices = await getCaptainInvoices(captainId);
  const allVouchers = await getCaptainVouchers(captainId);
  const posting = await queryOne(
    'SELECT * FROM finance_invoice_postings WHERE captain_id = ?',
    [captainId]
  );
  const commissionPosting = await queryOne(
    'SELECT * FROM finance_commission_postings WHERE captain_id = ?',
    [captainId]
  );
  const config = await getFinanceConfig();

  let range = null;
  if (period && ['day', 'week', 'month'].includes(period)) {
    range = getDateRange(period, date);
  }

  let invoices = allInvoices;
  let transfers_debts = num(finance?.transfers_debts);
  let total_invoices = invoices.reduce((s, row) => s + num(row.amount), 0);
  let vouchers = allVouchers;
  let previous_balance = null;

  if (range) {
    vouchers = allVouchers.filter(v => inDateRange(v.created_at, range.from, range.to));
    const postingInRange = posting && inDateRange(posting.posted_at, range.from, range.to);
    if (postingInRange) {
      transfers_debts = num(posting.transfers_debts);
      total_invoices = num(posting.total_invoices);
      invoices = allInvoices;
    } else {
      transfers_debts = 0;
      total_invoices = 0;
      invoices = [];
    }

    if (period === 'day' || period === 'week') {
      previous_balance = buildPreviousBalance(
        range,
        posting,
        commissionPosting,
        allInvoices,
        allVouchers,
        config
      );
    }
  }

  const summary = buildFinanceSummary(
    { ...finance, transfers_debts },
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
    previous_balance,
    ...summary,
    total_invoices,
  };
}

export async function saveCaptainFinance(captainId, data) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  await getCaptainFinanceRow(captainId);
  await execute(
    `UPDATE captain_finances SET transfers_debts = ?, rent = ?, total_commission = ? WHERE captain_id = ?`,
    [
      num(data.transfers_debts),
      num(data.rent),
      num(data.total_commission),
      captainId,
    ]
  );

  if (Array.isArray(data.invoices)) {
    await execute('DELETE FROM captain_store_invoices WHERE captain_id = ?', [captainId]);
    let totalInvoices = 0;
    for (const inv of data.invoices) {
      const amount = num(inv.amount);
      if (!inv.store_id || amount <= 0) continue;
      totalInvoices += amount;
      await execute(
        'INSERT INTO captain_store_invoices (id, captain_id, store_id, amount) VALUES (?, ?, ?, ?)',
        [uuid(), captainId, inv.store_id, amount]
      );
    }
    await recordInvoicePosting(captainId, totalInvoices, num(data.transfers_debts));
  }

  return getCaptainFinance(captainId);
}

async function recordInvoicePosting(captainId, totalInvoices, transfersDebts) {
  if (totalInvoices <= 0 && transfersDebts <= 0) return;

  const existing = await queryOne(
    'SELECT id FROM finance_invoice_postings WHERE captain_id = ?',
    [captainId]
  );

  if (existing) {
    await execute(
      `UPDATE finance_invoice_postings SET total_invoices = ?, transfers_debts = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"} WHERE captain_id = ?`,
      [num(totalInvoices), num(transfersDebts), captainId]
    );
  } else {
    await execute(
      'INSERT INTO finance_invoice_postings (id, captain_id, total_invoices, transfers_debts) VALUES (?, ?, ?, ?)',
      [uuid(), captainId, num(totalInvoices), num(transfersDebts)]
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

  await execute('DELETE FROM captain_store_invoices WHERE captain_id = ?', [posting.captain_id]);
  await execute(
    'UPDATE captain_finances SET transfers_debts = 0 WHERE captain_id = ?',
    [posting.captain_id]
  );
  await execute('DELETE FROM finance_invoice_postings WHERE id = ?', [postingId]);
  return { ok: true, captain_id: posting.captain_id };
}

async function recordCommissionPosting(captainId, totalCommission, rent) {
  if (totalCommission <= 0 && rent <= 0) return;

  const existing = await queryOne(
    'SELECT id FROM finance_commission_postings WHERE captain_id = ?',
    [captainId]
  );

  if (existing) {
    await execute(
      `UPDATE finance_commission_postings SET total_commission = ?, rent = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"} WHERE captain_id = ?`,
      [num(totalCommission), num(rent), captainId]
    );
  } else {
    await execute(
      'INSERT INTO finance_commission_postings (id, captain_id, total_commission, rent) VALUES (?, ?, ?, ?)',
      [uuid(), captainId, num(totalCommission), num(rent)]
    );
  }
}

export async function saveCaptainCommission(captainId, { total_commission, rent }) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const totalCommission = num(total_commission);
  const rentAmount = num(rent);

  await getCaptainFinanceRow(captainId);
  await execute(
    'UPDATE captain_finances SET rent = ?, total_commission = ? WHERE captain_id = ?',
    [rentAmount, totalCommission, captainId]
  );
  await recordCommissionPosting(captainId, totalCommission, rentAmount);

  return getCaptainFinance(captainId);
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

  await execute(
    'UPDATE captain_finances SET rent = 0, total_commission = 0 WHERE captain_id = ?',
    [posting.captain_id]
  );
  await execute('DELETE FROM finance_commission_postings WHERE id = ?', [postingId]);
  return { ok: true, captain_id: posting.captain_id };
}

export async function createVoucher(captainId, { voucher_type, amount, note }) {
  const captain = await queryOne('SELECT id FROM captains WHERE id = ?', [captainId]);
  if (!captain) throw new Error('الكابتن غير موجود');

  const type = voucher_type === 'receipt' ? 'receipt' : 'disbursement';
  const amt = num(amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  const id = uuid();
  await execute(
    'INSERT INTO finance_vouchers (id, captain_id, voucher_type, amount, note) VALUES (?, ?, ?, ?, ?)',
    [id, captainId, type, amt, String(note || '').trim()]
  );
  return queryOne('SELECT * FROM finance_vouchers WHERE id = ?', [id]);
}

export async function deleteVoucher(voucherId) {
  await execute('DELETE FROM finance_vouchers WHERE id = ?', [voucherId]);
  return { ok: true };
}

export async function listCaptainVouchers(captainId) {
  return getCaptainVouchers(captainId);
}
