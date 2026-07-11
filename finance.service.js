import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute, isMySQL } from './database.js';
import { getDateRange, yemenDateKey } from './attendance.service.js';
import { itemStorePricing, summarizeOrderPricing, orderTransfersDebtsAmount as pricingTransfersDebts, num as pricingNum, resolveStoreDiscountPercent } from './orderPricing.js';

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
      order_id: row.order_id || null,
      order_number: row.order_number || '',
      source: row.order_id ? 'order' : 'manual',
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

export async function createStore(name, discount_percent = 0, discount_from_date = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم المحل مطلوب');
  const id = uuid();
  const discount = pricingNum(discount_percent);
  const fromDate = discount > 0 && discount_from_date
    ? normalizeSalesDate(discount_from_date)
    : null;
  if (discount > 0 && !fromDate) {
    throw new Error('تاريخ الخصم مطلوب عند تفعيل الخصم');
  }
  await execute(
    'INSERT INTO finance_stores (id, name, discount_percent, discount_from_date) VALUES (?, ?, ?, ?)',
    [id, trimmed, discount, fromDate]
  );
  return queryOne('SELECT * FROM finance_stores WHERE id = ?', [id]);
}

export async function updateStore(id, payload = {}) {
  const existing = await queryOne('SELECT * FROM finance_stores WHERE id = ?', [id]);
  if (!existing) throw new Error('المحل غير موجود');

  const trimmed = payload.name !== undefined ? String(payload.name || '').trim() : existing.name;
  if (!trimmed) throw new Error('اسم المحل مطلوب');

  const discount = payload.discount_percent !== undefined
    ? pricingNum(payload.discount_percent)
    : pricingNum(existing.discount_percent);

  let fromDate = payload.discount_from_date !== undefined
    ? (payload.discount_from_date ? normalizeSalesDate(payload.discount_from_date) : null)
    : (existing.discount_from_date || null);

  if (discount <= 0) {
    fromDate = null;
  } else if (!fromDate) {
    throw new Error('تاريخ الخصم مطلوب عند تفعيل الخصم');
  }

  await execute(
    'UPDATE finance_stores SET name = ?, discount_percent = ?, discount_from_date = ? WHERE id = ?',
    [trimmed, discount, fromDate, id]
  );
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
    SELECT i.id, i.store_id, i.amount, i.sales_date, i.order_id, s.name AS store_name
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

  sql += ' ORDER BY s.name ASC, i.created_at ASC';
  return queryAll(sql, params);
}

async function enrichInvoiceLines(invoices) {
  const orderDisplayMap = await buildOrderDisplayNumberMap();
  return (invoices || []).map((row) => ({
    ...row,
    order_number: row.order_id ? String(orderDisplayMap.get(row.order_id) || '') : '',
    source: row.order_id ? 'order' : 'manual',
  }));
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
    let posting = await queryOne(
      'SELECT * FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
      [captainId, normalizedSalesDate]
    );
    if (posting) {
      await reconcileCaptainDayFinance(captainId, normalizedSalesDate);
      posting = await queryOne(
        'SELECT * FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
        [captainId, normalizedSalesDate]
      );
    }
    await cleanupDuplicateManualInvoices(captainId, normalizedSalesDate);
    total_invoices = await syncInvoicePostingTotal(captainId, normalizedSalesDate);
    invoices = await getCaptainInvoices(captainId, normalizedSalesDate);
    transfers_debts = posting
      ? num(posting.transfers_debts)
      : await computeTransfersDebtsFromOrders(captainId, normalizedSalesDate);
    orders_count = posting ? Number(posting.orders_count || 0) : 0;

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

  invoices = await enrichInvoiceLines(invoices);

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
      "DELETE FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ? AND (order_id IS NULL OR order_id = '')",
      [captainId, sales_date]
    );
    for (const inv of data.invoices) {
      const amount = num(inv.amount);
      if (!inv.store_id || amount <= 0) continue;
      await execute(
        'INSERT INTO captain_store_invoices (id, captain_id, store_id, amount, sales_date, order_id) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), captainId, inv.store_id, amount, sales_date, null]
      );
    }
    await cleanupDuplicateManualInvoices(captainId, sales_date);
    const totalInvoices = await syncInvoicePostingTotal(captainId, sales_date);
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

function normalizePaymentType(value) {
  const key = String(value || '').trim().toLowerCase();
  return ['cash', 'transfer', 'credit'].includes(key) ? key : 'cash';
}

function isNonCashPaymentType(paymentType) {
  const key = normalizePaymentType(paymentType);
  return key === 'transfer' || key === 'credit';
}

function orderTransfersDebtsAmount(order, invoiceTotal = null, externalTotal = null) {
  if (!isNonCashPaymentType(order?.payment_type)) return 0;
  const summary = {
    invoice_total_net: invoiceTotal,
    invoice_total: invoiceTotal,
    external_total: externalTotal,
    delivery_fee: order?.delivery_fee,
  };
  return pricingTransfersDebts(order, summary);
}

async function getPostedOrderItemsForCaptain(captainId) {
  return queryAll(
    `SELECT oi.order_id, oi.store_id, oi.store_name, oi.invoice_amount, oi.is_external,
      s.discount_percent AS store_discount_percent,
      s.discount_from_date AS store_discount_from_date,
      o.payment_type, o.delivery_fee, o.done_at, o.updated_at
     FROM order_items oi
     INNER JOIN \`orders\` o ON o.id = oi.order_id
     LEFT JOIN finance_stores s ON s.id = oi.store_id
     WHERE o.captain_id = ? AND o.status = 'done' AND o.finance_posted_at IS NOT NULL`,
    [captainId]
  );
}

function summarizePostedOrder(order, items) {
  const orderItems = items.map((row) => ({
    store_id: row.store_id,
    store_name: row.store_name,
    invoice_amount: pricingNum(row.invoice_amount),
    is_external: Boolean(row.is_external),
    store_discount_percent: resolveStoreDiscountPercent(
      row.store_discount_percent,
      row.store_discount_from_date,
      row.done_at || row.updated_at
    ),
  }));
  return summarizeOrderPricing(orderItems, order.delivery_fee);
}

async function getPostedDoneOrdersWithTotals(captainId) {
  return queryAll(
    `SELECT o.id, o.payment_type, o.delivery_fee, o.done_at, o.updated_at,
      (SELECT COALESCE(SUM(CASE WHEN is_external = 0 THEN invoice_amount ELSE 0 END), 0) FROM order_items WHERE order_id = o.id) AS invoice_total,
      (SELECT COALESCE(SUM(CASE WHEN is_external = 1 THEN invoice_amount ELSE 0 END), 0) FROM order_items WHERE order_id = o.id) AS external_total
     FROM \`orders\` o
     WHERE o.captain_id = ? AND o.status = 'done' AND o.finance_posted_at IS NOT NULL`,
    [captainId]
  );
}

function groupItemsByOrderId(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.order_id) || [];
    list.push(row);
    map.set(row.order_id, list);
  }
  return map;
}

async function computeTransfersDebtsFromOrders(captainId, salesDate) {
  const orders = await getPostedDoneOrdersWithTotals(captainId);
  const itemsByOrder = groupItemsByOrderId(await getPostedOrderItemsForCaptain(captainId));
  let total = 0;
  for (const order of orders) {
    const orderDate = toDateKey(order.done_at || order.updated_at);
    if (orderDate !== salesDate) continue;
    const summary = summarizePostedOrder(order, itemsByOrder.get(order.id) || []);
    total += pricingTransfersDebts(order, summary);
  }
  return num(total);
}

async function computeStoreInvoiceLinesFromOrders(captainId, salesDate) {
  const rows = await queryAll(
    `SELECT oi.order_id, oi.store_id, oi.invoice_amount, oi.is_external,
      s.discount_percent AS store_discount_percent,
      s.discount_from_date AS store_discount_from_date,
      o.done_at, o.updated_at
     FROM order_items oi
     INNER JOIN \`orders\` o ON o.id = oi.order_id
     LEFT JOIN finance_stores s ON s.id = oi.store_id
     WHERE o.captain_id = ? AND o.status = 'done' AND o.finance_posted_at IS NOT NULL
       AND oi.is_external = 0 AND oi.store_id IS NOT NULL AND oi.invoice_amount > 0`,
    [captainId]
  );

  const lines = [];
  for (const row of rows) {
    const orderDate = toDateKey(row.done_at || row.updated_at);
    if (orderDate !== salesDate) continue;
    const pricing = itemStorePricing(
      row.invoice_amount,
      false,
      resolveStoreDiscountPercent(
        row.store_discount_percent,
        row.store_discount_from_date,
        row.done_at || row.updated_at
      )
    );
    if (pricing.net <= 0) continue;
    lines.push({
      store_id: row.store_id,
      order_id: row.order_id,
      amount: pricing.net,
    });
  }
  return lines;
}

async function replaceOrderInvoiceLinesForDay(captainId, salesDate, lines) {
  await execute(
    "DELETE FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ? AND order_id IS NOT NULL AND order_id != ''",
    [captainId, salesDate]
  );
  for (const line of lines) {
    await execute(
      'INSERT INTO captain_store_invoices (id, captain_id, store_id, amount, sales_date, order_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), captainId, line.store_id, line.amount, salesDate, line.order_id]
    );
  }
}

async function cleanupDuplicateManualInvoices(captainId, salesDate) {
  const lines = await getCaptainInvoices(captainId, salesDate);
  const orderSumByStore = new Map();
  for (const line of lines) {
    if (!line.order_id) continue;
    orderSumByStore.set(
      line.store_id,
      num((orderSumByStore.get(line.store_id) || 0) + line.amount)
    );
  }

  for (const line of lines) {
    if (line.order_id) continue;
    const orderSum = orderSumByStore.get(line.store_id) || 0;
    if (orderSum <= 0) continue;
    const manualAmount = num(line.amount);
    const isLegacyAggregate = Math.abs(manualAmount - orderSum) < 0.02
      || manualAmount >= orderSum * 0.95;
    if (isLegacyAggregate) {
      await execute('DELETE FROM captain_store_invoices WHERE id = ?', [line.id]);
    }
  }
}

async function syncInvoicePostingTotal(captainId, salesDate) {
  const normalizedDate = normalizeSalesDate(salesDate);
  const lines = await getCaptainInvoices(captainId, normalizedDate);
  const total = lines.reduce((sum, row) => sum + num(row.amount), 0);
  const posting = await queryOne(
    'SELECT id, total_invoices FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, normalizedDate]
  );
  if (posting && num(posting.total_invoices) !== total) {
    await execute(
      'UPDATE finance_invoice_postings SET total_invoices = ? WHERE id = ?',
      [total, posting.id]
    );
  }
  return total;
}

export async function reconcileCaptainDayFinance(captainId, salesDate) {
  const normalizedDate = normalizeSalesDate(salesDate);
  const posting = await queryOne(
    'SELECT id, total_invoices, orders_count, transfers_debts FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, normalizedDate]
  );
  if (!posting) return null;

  const orders = await getPostedDoneOrdersWithTotals(captainId);
  const itemsByOrder = groupItemsByOrderId(await getPostedOrderItemsForCaptain(captainId));
  let totalInvoices = 0;
  let ordersCount = 0;
  let transfersDebts = 0;
  let deliveryFees = 0;

  for (const order of orders) {
    const orderDate = toDateKey(order.done_at || order.updated_at);
    if (orderDate !== normalizedDate) continue;
    const summary = summarizePostedOrder(order, itemsByOrder.get(order.id) || []);
    ordersCount += 1;
    totalInvoices += summary.invoice_total_net;
    transfersDebts += pricingTransfersDebts(order, summary);
    deliveryFees += summary.delivery_fee;
  }

  if (ordersCount === 0) return null;

  const manualTotalRow = await queryOne(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ? AND (order_id IS NULL OR order_id = '')",
    [captainId, normalizedDate]
  );
  totalInvoices = num(totalInvoices + num(manualTotalRow?.total));

  const postingChanged = num(posting.total_invoices) !== totalInvoices
    || Number(posting.orders_count || 0) !== ordersCount
    || num(posting.transfers_debts) !== transfersDebts;

  if (postingChanged) {
    await execute(
      'UPDATE finance_invoice_postings SET total_invoices = ?, orders_count = ?, transfers_debts = ? WHERE id = ?',
      [totalInvoices, ordersCount, transfersDebts, posting.id]
    );
  }

  const orderLines = await computeStoreInvoiceLinesFromOrders(captainId, normalizedDate);
  await replaceOrderInvoiceLinesForDay(captainId, normalizedDate, orderLines);
  await cleanupDuplicateManualInvoices(captainId, normalizedDate);
  await syncInvoicePostingTotal(captainId, normalizedDate);

  const commissionPosting = await queryOne(
    'SELECT id, total_commission, rent FROM finance_commission_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, normalizedDate]
  );
  if (commissionPosting && num(commissionPosting.total_commission) !== deliveryFees) {
    await execute(
      'UPDATE finance_commission_postings SET total_commission = ? WHERE id = ?',
      [deliveryFees, commissionPosting.id]
    );
  }

  return {
    total_invoices: totalInvoices,
    orders_count: ordersCount,
    transfers_debts: transfersDebts,
    delivery_fees: deliveryFees,
  };
}

export async function postCompletedOrderFinance(order) {
  if (!order?.captain_id) throw new Error('الكابتن غير موجود للطلب');
  if (order.finance_posted_at) {
    return { skipped: true, reason: 'already_posted' };
  }

  const captainId = order.captain_id;
  const salesDate = normalizeSalesDate(order.done_at || order.updated_at || order.created_at);
  const orderItems = Array.isArray(order.items) ? order.items : [];
  const summary = summarizeOrderPricing(orderItems, order.delivery_fee);
  const invoiceOnlyTotal = summary.invoice_total_net;

  await execute('DELETE FROM captain_store_invoices WHERE captain_id = ? AND order_id = ?', [captainId, order.id]);
  for (const item of orderItems) {
    if (item.is_external || !item.store_id) continue;
    const pricing = itemStorePricing(item.invoice_amount, false, item.store_discount_percent);
    if (pricing.net <= 0) continue;

    await execute(
      'INSERT INTO captain_store_invoices (id, captain_id, store_id, amount, sales_date, order_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), captainId, item.store_id, pricing.net, salesDate, order.id]
    );
  }

  const deliveryFee = summary.delivery_fee;
  const transfersDebtsAmount = pricingTransfersDebts(order, summary);

  const posting = await queryOne(
    'SELECT id, total_invoices, orders_count, transfers_debts FROM finance_invoice_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, salesDate]
  );

  if (posting) {
    await execute(
      `UPDATE finance_invoice_postings
       SET total_invoices = ?, orders_count = ?, transfers_debts = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"}
       WHERE id = ?`,
      [
        num(num(posting.total_invoices) + invoiceOnlyTotal),
        Number(posting.orders_count || 0) + 1,
        num(num(posting.transfers_debts) + transfersDebtsAmount),
        posting.id,
      ]
    );
  } else {
    await execute(
      'INSERT INTO finance_invoice_postings (id, captain_id, total_invoices, orders_count, transfers_debts, sales_date) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), captainId, invoiceOnlyTotal, 1, transfersDebtsAmount, salesDate]
    );
  }

  if (deliveryFee > 0) {
    await incrementCommissionPosting(captainId, deliveryFee, salesDate);
  }

  const postedAt = isMySQL ? 'NOW()' : "datetime('now')";
  await execute(
    `UPDATE \`orders\` SET finance_posted_at = ${postedAt} WHERE id = ?`,
    [order.id]
  );

  return {
    sales_date: salesDate,
    invoice_total: invoiceOnlyTotal,
    delivery_fee: deliveryFee,
    transfers_debts_amount: transfersDebtsAmount,
  };
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
  const rows = await queryAll(`
    SELECT p.*, c.name AS captain_name, c.captain_number
    FROM finance_invoice_postings p
    JOIN captains c ON c.id = p.captain_id
    ORDER BY p.posted_at DESC
  `);
  const seen = new Set();
  for (const row of rows) {
    const salesDate = row.sales_date || toDateKey(row.posted_at);
    const key = `${row.captain_id}:${salesDate}`;
    if (!salesDate || seen.has(key)) continue;
    seen.add(key);
    await reconcileCaptainDayFinance(row.captain_id, salesDate);
  }
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
  const captainId = posting.captain_id;

  const orders = await queryAll(
    `SELECT id, delivery_fee, done_at, updated_at
     FROM \`orders\`
     WHERE captain_id = ? AND status = 'done' AND finance_posted_at IS NOT NULL`,
    [captainId]
  );

  let deliveryReversal = 0;
  for (const order of orders) {
    const orderDate = toDateKey(order.done_at || order.updated_at);
    if (orderDate !== salesDate) continue;
    deliveryReversal = num(deliveryReversal + num(order.delivery_fee));
    await execute('UPDATE `orders` SET finance_posted_at = NULL WHERE id = ?', [order.id]);
  }

  if (deliveryReversal > 0) {
    await decrementCommissionPosting(captainId, deliveryReversal, salesDate);
  }

  await execute(
    'DELETE FROM captain_store_invoices WHERE captain_id = ? AND sales_date = ?',
    [captainId, salesDate]
  );
  await execute('DELETE FROM finance_invoice_postings WHERE id = ?', [postingId]);
  return { ok: true, captain_id: captainId, sales_date: salesDate };
}

async function incrementCommissionPosting(captainId, commissionDelta, salesDate) {
  const delta = num(commissionDelta);
  if (delta <= 0) return;

  const sales_date = normalizeSalesDate(salesDate);
  const existing = await queryOne(
    'SELECT id, total_commission, rent FROM finance_commission_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, sales_date]
  );

  if (existing) {
    await execute(
      `UPDATE finance_commission_postings
       SET total_commission = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"}
       WHERE id = ?`,
      [num(num(existing.total_commission) + delta), existing.id]
    );
  } else {
    await execute(
      'INSERT INTO finance_commission_postings (id, captain_id, total_commission, rent, sales_date) VALUES (?, ?, ?, ?, ?)',
      [uuid(), captainId, delta, 0, sales_date]
    );
  }
}

async function decrementCommissionPosting(captainId, commissionDelta, salesDate) {
  const delta = num(commissionDelta);
  if (delta <= 0) return;

  const sales_date = normalizeSalesDate(salesDate);
  const existing = await queryOne(
    'SELECT id, total_commission, rent FROM finance_commission_postings WHERE captain_id = ? AND sales_date = ?',
    [captainId, sales_date]
  );
  if (!existing) return;

  const nextTotal = num(num(existing.total_commission) - delta);
  if (nextTotal <= 0 && num(existing.rent) <= 0) {
    await execute('DELETE FROM finance_commission_postings WHERE id = ?', [existing.id]);
  } else {
    await execute(
      `UPDATE finance_commission_postings
       SET total_commission = ?, posted_at = ${isMySQL ? 'NOW()' : "datetime('now')"}
       WHERE id = ?`,
      [Math.max(0, nextTotal), existing.id]
    );
  }
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

const PAYMENT_LABELS = { cash: 'كاش', transfer: 'حوالة', credit: 'آجل' };

function balanceStatus(balance) {
  return num(balance) >= 0 ? 'له' : 'عليه';
}

function applyBalanceChange(balance, debit, credit) {
  return num(num(balance) + num(credit) - num(debit));
}

function buildStatementRow(row) {
  const balance = num(row.balance);
  return {
    journal_date: row.journal_date || '',
    reference_type: row.reference_type || '',
    reference_id: row.reference_id ?? '',
    account_name: row.account_name || '',
    debit: num(row.debit),
    credit: num(row.credit),
    balance,
    balance_status: balanceStatus(balance),
    notes: row.notes || '',
    is_opening: !!row.is_opening,
  };
}

async function buildOrderDisplayNumberMap() {
  const rows = await queryAll('SELECT id FROM `orders` ORDER BY created_at DESC');
  const map = new Map();
  rows.forEach((row, index) => map.set(row.id, index + 1));
  return map;
}

export async function getCaptainAccountStatement({
  captain_id,
  period = 'month',
  date,
  from,
  to,
  mode = 'detailed',
  include_opening = true,
}) {
  if (!captain_id) throw new Error('الكابتن مطلوب');

  const range = getReportRange(period, date, from, to);
  const config = await getFinanceConfig();
  const companyRate = num(config.company_commission_rate);

  const captain = await queryOne(
    'SELECT id, name, captain_number FROM captains WHERE id = ?',
    [captain_id]
  );
  if (!captain) throw new Error('الكابتن غير موجود');

  const allVouchers = await queryAll(
    `SELECT v.*, c.name AS counterpart_name, c.captain_number AS counterpart_number
     FROM finance_vouchers v
     LEFT JOIN captains c ON c.id = v.counterpart_captain_id
     WHERE v.captain_id = ?
     ORDER BY v.voucher_date ASC, v.created_at ASC`,
    [captain_id]
  );

  const events = [];
  let openingBalance = 0;
  const orderDisplayMap = await buildOrderDisplayNumberMap();
  const activeInvoiceDates = new Set(
    (await queryAll(
      'SELECT sales_date, posted_at FROM finance_invoice_postings WHERE captain_id = ?',
      [captain_id]
    )).map((row) => row.sales_date || toDateKey(row.posted_at))
  );
  const deliveryByDate = new Map();

  if (include_opening) {
    const prev = await buildPreviousBalance(captain_id, range, config, allVouchers);
    if (prev) {
      openingBalance = num(-prev.remaining_for_company);
      const openingDate = prev.to || dayBeforeKey(range.from);
      events.push({
        sort_key: `${openingDate}T00:00:00.000|00`,
        journal_date: openingDate,
        reference_type: 'opening',
        reference_id: '',
        account_name: captain.name,
        debit: openingBalance < 0 ? Math.abs(openingBalance) : 0,
        credit: openingBalance >= 0 ? openingBalance : 0,
        notes: `رصيد سابق حتى ${openingDate}`,
        is_opening: true,
        preset_balance: openingBalance,
      });
    }
  }

  if (mode === 'detailed') {
    const shownInvoiceByDate = new Map();
    const shownTransfersByDate = new Map();
    const shownStoreInvoiceKeys = new Set();

    const orders = await queryAll(
      `SELECT o.*
       FROM \`orders\` o
       WHERE o.captain_id = ? AND o.status = 'done' AND o.finance_posted_at IS NOT NULL
       ORDER BY COALESCE(o.done_at, o.updated_at) ASC`,
      [captain_id]
    );
    const itemsByOrder = groupItemsByOrderId(await getPostedOrderItemsForCaptain(captain_id));

    for (const order of orders) {
      const orderDate = toDateKey(order.done_at || order.updated_at);
      if (!inDateRange(orderDate, range.from, range.to)) continue;
      if (!activeInvoiceDates.has(orderDate)) continue;

      const orderRef = String(orderDisplayMap.get(order.id) || '');
      const summary = summarizePostedOrder(order, itemsByOrder.get(order.id) || []);
      const orderItems = itemsByOrder.get(order.id) || [];
      const externalTotal = summary.external_total;
      const deliveryFee = summary.delivery_fee;
      const paymentType = normalizePaymentType(order.payment_type);

      for (const item of orderItems) {
        if (Boolean(item.is_external) || !item.store_id) continue;
        const pricing = itemStorePricing(
          item.invoice_amount,
          false,
          resolveStoreDiscountPercent(
            item.store_discount_percent,
            item.store_discount_from_date,
            order.done_at || order.updated_at
          )
        );
        if (pricing.net <= 0) continue;
        const storeName = item.store_name || 'محل';
        shownStoreInvoiceKeys.add(`${orderDate}|${item.store_id}`);
        shownInvoiceByDate.set(
          orderDate,
          num((shownInvoiceByDate.get(orderDate) || 0) + pricing.net)
        );
        events.push({
          sort_key: `${orderDate}T12:00:00.000|10|${orderRef}|${item.store_id}`,
          journal_date: orderDate,
          reference_type: 'order',
          reference_id: orderRef,
          account_name: storeName,
          debit: pricing.net,
          credit: 0,
          notes: `فاتورة ${storeName} — طلب #${orderRef} — ${order.customer_name || ''} — ${PAYMENT_LABELS[paymentType] || paymentType}`,
        });
      }

      if (isNonCashPaymentType(paymentType)) {
        const orderTotal = pricingTransfersDebts(order, summary);
        if (orderTotal > 0) {
          shownTransfersByDate.set(
            orderDate,
            num((shownTransfersByDate.get(orderDate) || 0) + orderTotal)
          );
          events.push({
            sort_key: `${orderDate}T12:00:01.000|11|${orderRef}`,
            journal_date: orderDate,
            reference_type: paymentType === 'transfer' ? 'transfer' : 'credit',
            reference_id: orderRef,
            account_name: captain.name,
            debit: 0,
            credit: orderTotal,
            notes: paymentType === 'transfer'
              ? `حوالة طلب #${orderRef} — ${order.customer_name || ''}${externalTotal > 0 && summary.invoice_total_net === 0 ? ' — طلب خارجي' : ''}`
              : `آجل طلب #${orderRef} — ${order.customer_name || ''}${externalTotal > 0 && summary.invoice_total_net === 0 ? ' — طلب خارجي' : ''}`,
          });
        }
      }

      if (deliveryFee > 0) {
        deliveryByDate.set(orderDate, num((deliveryByDate.get(orderDate) || 0) + deliveryFee));
        const companyShare = num(deliveryFee * companyRate / 100);
        if (companyShare > 0) {
          events.push({
            sort_key: `${orderDate}T12:00:02.000|12|${orderRef}`,
            journal_date: orderDate,
            reference_type: 'company_commission',
            reference_id: orderRef,
            account_name: captain.name,
            debit: companyShare,
            credit: 0,
            notes: `عمولة طلب #${orderRef}`,
          });
        }
      }
    }

    const manualPostings = await queryAll(
      `SELECT * FROM finance_invoice_postings
       WHERE captain_id = ? AND sales_date >= ? AND sales_date <= ?
       ORDER BY sales_date ASC`,
      [captain_id, range.from, range.to]
    );
    const storeInvoicesInRange = await enrichInvoiceLines(
      await getCaptainInvoices(captain_id, { from: range.from, to: range.to })
    );
    const storeInvoicesByDate = new Map();
    for (const inv of storeInvoicesInRange) {
      const salesDate = inv.sales_date || toDateKey(inv.created_at);
      if (!storeInvoicesByDate.has(salesDate)) storeInvoicesByDate.set(salesDate, []);
      storeInvoicesByDate.get(salesDate).push(inv);
    }

    for (const posting of manualPostings) {
      const salesDate = posting.sales_date || toDateKey(posting.posted_at);
      if (!inDateRange(salesDate, range.from, range.to)) continue;

      const storeLines = storeInvoicesByDate.get(salesDate) || [];
      for (const inv of storeLines) {
        if (inv.order_id) continue;
        if (shownStoreInvoiceKeys.has(`${salesDate}|${inv.store_id}`)) continue;
        const amount = num(inv.amount);
        if (amount <= 0) continue;
        events.push({
          sort_key: `${salesDate}T08:30:00.000|10|${inv.store_id}|manual`,
          journal_date: salesDate,
          reference_type: 'invoice_posting',
          reference_id: '',
          account_name: inv.store_name || captain.name,
          debit: amount,
          credit: 0,
          notes: inv.store_name
            ? `فاتورة يدوية — ${inv.store_name} — يوم ${salesDate}`
            : `فاتورة يدوية — يوم ${salesDate}`,
        });
      }

      const postingTransfers = num(posting.transfers_debts);
      const shownTransfers = num(shownTransfersByDate.get(salesDate) || 0);
      const ordersCount = Number(posting.orders_count || 0);

      if (postingTransfers > shownTransfers + 0.001) {
        const manualTransfers = num(postingTransfers - shownTransfers);
        events.push({
          sort_key: `${salesDate}T08:00:01.000|11|credit-manual`,
          journal_date: salesDate,
          reference_type: 'credit',
          reference_id: ordersCount ? String(ordersCount) : '',
          account_name: captain.name,
          debit: 0,
          credit: manualTransfers,
          notes: `حوالات + آجل يدوية يوم ${salesDate}`,
        });
      }
    }
  } else {
    const transfersDebtsByDate = new Map();
    const ordersForTransfers = await queryAll(
      `SELECT o.id, o.payment_type, o.delivery_fee, o.done_at, o.updated_at
       FROM \`orders\` o
       WHERE o.captain_id = ? AND o.status = 'done' AND o.finance_posted_at IS NOT NULL`,
      [captain_id]
    );
    const transferItemsByOrder = groupItemsByOrderId(await getPostedOrderItemsForCaptain(captain_id));
    for (const order of ordersForTransfers) {
      const orderDate = toDateKey(order.done_at || order.updated_at);
      if (!inDateRange(orderDate, range.from, range.to)) continue;
      const summary = summarizePostedOrder(order, transferItemsByOrder.get(order.id) || []);
      const amt = pricingTransfersDebts(order, summary);
      if (amt > 0) {
        transfersDebtsByDate.set(orderDate, num((transfersDebtsByDate.get(orderDate) || 0) + amt));
      }
    }

    const postings = await queryAll(
      `SELECT * FROM finance_invoice_postings
       WHERE captain_id = ? AND sales_date >= ? AND sales_date <= ?
       ORDER BY sales_date ASC`,
      [captain_id, range.from, range.to]
    );

    for (const posting of postings) {
      const salesDate = posting.sales_date || toDateKey(posting.posted_at);
      const totalInvoices = num(posting.total_invoices);
      const transfersDebts = transfersDebtsByDate.get(salesDate) ?? num(posting.transfers_debts);
      const ordersCount = Number(posting.orders_count || 0);

      if (totalInvoices > 0) {
        events.push({
          sort_key: `${salesDate}T08:00:00.000|10|inv`,
          journal_date: salesDate,
          reference_type: 'invoice_posting',
          reference_id: ordersCount || '',
          account_name: captain.name,
          debit: totalInvoices,
          credit: 0,
          notes: ordersCount
            ? `ترحيل فواتير — ${ordersCount} طلب`
            : 'ترحيل فواتير يومي',
        });
      }

      if (transfersDebts > 0) {
        events.push({
          sort_key: `${salesDate}T08:00:01.000|11|credit`,
          journal_date: salesDate,
          reference_type: 'credit',
          reference_id: ordersCount || '',
          account_name: captain.name,
          debit: 0,
          credit: transfersDebts,
          notes: `حوالات + آجل يوم ${salesDate}`,
        });
      }
    }
  }

  const commissionPostings = await queryAll(
    `SELECT * FROM finance_commission_postings
     WHERE captain_id = ? AND sales_date >= ? AND sales_date <= ?
     ORDER BY sales_date ASC`,
    [captain_id, range.from, range.to]
  );

  for (const posting of commissionPostings) {
    const salesDate = commissionSalesDateKey(posting);
    const totalCommission = num(posting.total_commission);
    const rent = num(posting.rent);
    if (totalCommission <= 0 && rent <= 0) continue;

    const postedDelivery = mode === 'detailed' ? num(deliveryByDate.get(salesDate) || 0) : 0;
    const manualCommission = mode === 'detailed'
      ? Math.max(0, num(totalCommission - postedDelivery))
      : totalCommission;
    const companyCommission = num(manualCommission * companyRate / 100);

    if (companyCommission > 0) {
      events.push({
        sort_key: `${salesDate}T09:00:01.000|21|company`,
        journal_date: salesDate,
        reference_type: 'company_commission',
        reference_id: '',
        account_name: captain.name,
        debit: companyCommission,
        credit: 0,
        notes: mode === 'detailed'
          ? `عمولة يدوية يوم ${salesDate} (${companyRate}%)`
          : `عمولة الشركة (${companyRate}%) — يوم ${salesDate}`,
      });
    }

    if (rent > 0) {
      events.push({
        sort_key: `${salesDate}T09:00:02.000|22|rent`,
        journal_date: salesDate,
        reference_type: 'rent',
        reference_id: '',
        account_name: captain.name,
        debit: rent,
        credit: 0,
        notes: `إيجار يوم ${salesDate}`,
      });
    }
  }

  const periodVouchers = allVouchers.filter(v => voucherInDateRange(v, range.from, range.to));
  for (const voucher of periodVouchers) {
    const voucherDate = voucherDateKey(voucher);
    const amount = num(voucher.amount);
    if (amount <= 0) continue;

    const isTransfer = !!voucher.transfer_group_id;
    const isReceipt = voucher.voucher_type === 'receipt';
    let referenceType = isReceipt ? 'receipt' : 'disbursement';
    let notes = voucher.note || '';

    if (isTransfer) {
      referenceType = isReceipt ? 'transfer_in' : 'transfer_out';
      const counterpart = voucher.counterpart_name
        ? `${voucher.counterpart_name}${voucher.counterpart_number ? ` (${voucher.counterpart_number})` : ''}`
        : '';
      notes = notes || (isReceipt
        ? `تحويل من ${counterpart || 'كابتن'}`
        : `تحويل إلى ${counterpart || 'كابتن'}`);
    } else {
      notes = notes || (isReceipt ? 'سند قبض' : 'سند صرف');
    }

    events.push({
      sort_key: `${voucherDate}T10:00:00.000|30|${voucher.id}`,
      journal_date: voucherDate,
      reference_type: referenceType,
      reference_id: voucher.id?.slice(0, 8) || '',
      account_name: captain.name,
      debit: isReceipt ? 0 : amount,
      credit: isReceipt ? amount : 0,
      notes,
    });
  }

  events.sort((a, b) => String(a.sort_key).localeCompare(String(b.sort_key)));

  let running = openingBalance;
  const rows = [];
  for (const event of events) {
    if (event.is_opening) {
      running = num(event.preset_balance);
      rows.push(buildStatementRow({ ...event, balance: running }));
      continue;
    }
    running = applyBalanceChange(running, event.debit, event.credit);
    rows.push(buildStatementRow({ ...event, balance: running }));
  }

  const totalDebit = rows.reduce((sum, row) => sum + (row.is_opening ? 0 : num(row.debit)), 0);
  const totalCredit = rows.reduce((sum, row) => sum + (row.is_opening ? 0 : num(row.credit)), 0);
  const closingBalance = rows.length ? num(rows[rows.length - 1].balance) : openingBalance;

  return {
    success: true,
    period,
    from: range.from,
    to: range.to,
    mode,
    captain,
    rows,
    summary: {
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      closing_status: balanceStatus(closingBalance),
      total_debit: num(totalDebit),
      total_credit: num(totalCredit),
      entries_count: rows.filter(r => !r.is_opening).length,
    },
  };
}
