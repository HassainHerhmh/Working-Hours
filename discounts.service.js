import { v4 as uuid } from 'uuid';
import { queryAll, queryOne, execute } from './database.js';
import {
  normalizeDateKey,
  normalizeDiscountPercent,
  isDiscountActiveForDate,
  pickDiscountsForDate,
} from './orderPricing.js';

function normalizeSalesDate(value) {
  const key = normalizeDateKey(value);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error('تاريخ غير صالح');
  }
  return key;
}

async function normalizePayload(payload = {}) {
  const discount_type = String(payload.discount_type || 'store').trim().toLowerCase();
  if (!['store', 'delivery'].includes(discount_type)) {
    throw new Error('نوع الخصم غير صالح');
  }

  const discount_percent = normalizeDiscountPercent(payload.discount_percent);
  if (discount_percent <= 0) throw new Error('نسبة الخصم مطلوبة');

  const date_mode = String(payload.date_mode || 'day').trim().toLowerCase();
  if (!['day', 'range'].includes(date_mode)) {
    throw new Error('طريقة تحديد التاريخ غير صالحة');
  }

  let store_id = null;
  if (discount_type === 'store') {
    store_id = String(payload.store_id || '').trim();
    if (!store_id) throw new Error('المحل مطلوب لخصم المحلات');
    const store = await queryOne('SELECT id FROM finance_stores WHERE id = ?', [store_id]);
    if (!store) throw new Error('المحل غير موجود');
  }

  let discount_date = null;
  let discount_from = null;
  let discount_to = null;

  if (date_mode === 'day') {
    discount_date = normalizeSalesDate(payload.discount_date);
  } else {
    discount_from = normalizeSalesDate(payload.discount_from);
    discount_to = normalizeSalesDate(payload.discount_to);
    if (discount_from > discount_to) {
      [discount_from, discount_to] = [discount_to, discount_from];
    }
  }

  return {
    discount_type,
    store_id,
    discount_percent,
    date_mode,
    discount_date,
    discount_from,
    discount_to,
    note: String(payload.note || '').trim(),
  };
}

function mapDiscountRow(row) {
  return {
    id: row.id,
    discount_type: row.discount_type,
    store_id: row.store_id || null,
    store_name: row.store_name || '',
    discount_percent: normalizeDiscountPercent(row.discount_percent),
    date_mode: row.date_mode || 'day',
    discount_date: row.discount_date || null,
    discount_from: row.discount_from || null,
    discount_to: row.discount_to || null,
    note: row.note || '',
    created_at: row.created_at,
  };
}

export async function listDiscounts() {
  const rows = await queryAll(`
    SELECT d.*, s.name AS store_name
    FROM finance_discounts d
    LEFT JOIN finance_stores s ON s.id = d.store_id
    ORDER BY d.created_at DESC
  `);
  return rows.map(mapDiscountRow);
}

function afterDiscountMutation() {
  invalidateDiscountsCache();
}

export async function createDiscount(payload) {
  const data = await normalizePayload(payload);
  const id = uuid();
  await execute(
    `INSERT INTO finance_discounts
      (id, discount_type, store_id, discount_percent, date_mode, discount_date, discount_from, discount_to, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.discount_type,
      data.store_id,
      data.discount_percent,
      data.date_mode,
      data.discount_date,
      data.discount_from,
      data.discount_to,
      data.note,
    ]
  );
  const row = await queryOne(`
    SELECT d.*, s.name AS store_name
    FROM finance_discounts d
    LEFT JOIN finance_stores s ON s.id = d.store_id
    WHERE d.id = ?
  `, [id]);
  afterDiscountMutation();
  return mapDiscountRow(row);
}

export async function updateDiscount(id, payload) {
  const existing = await queryOne('SELECT id FROM finance_discounts WHERE id = ?', [id]);
  if (!existing) throw new Error('الخصم غير موجود');
  const data = await normalizePayload(payload);
  await execute(
    `UPDATE finance_discounts
     SET discount_type = ?, store_id = ?, discount_percent = ?, date_mode = ?,
         discount_date = ?, discount_from = ?, discount_to = ?, note = ?
     WHERE id = ?`,
    [
      data.discount_type,
      data.store_id,
      data.discount_percent,
      data.date_mode,
      data.discount_date,
      data.discount_from,
      data.discount_to,
      data.note,
      id,
    ]
  );
  const row = await queryOne(`
    SELECT d.*, s.name AS store_name
    FROM finance_discounts d
    LEFT JOIN finance_stores s ON s.id = d.store_id
    WHERE d.id = ?
  `, [id]);
  afterDiscountMutation();
  return mapDiscountRow(row);
}

export async function deleteDiscount(id) {
  const existing = await queryOne('SELECT id FROM finance_discounts WHERE id = ?', [id]);
  if (!existing) throw new Error('الخصم غير موجود');
  await execute('DELETE FROM finance_discounts WHERE id = ?', [id]);
  afterDiscountMutation();
  return { ok: true };
}

let discountsCache = null;
let discountsCacheAt = 0;
const CACHE_MS = 5000;

export async function getAllDiscountsCached(force = false) {
  const now = Date.now();
  if (!force && discountsCache && (now - discountsCacheAt) < CACHE_MS) {
    return discountsCache;
  }
  discountsCache = await listDiscounts();
  discountsCacheAt = now;
  return discountsCache;
}

export function invalidateDiscountsCache() {
  discountsCache = null;
  discountsCacheAt = 0;
}

export async function resolveDiscountsForOrderDate(orderDate, discountsList = null) {
  const list = discountsList || await getAllDiscountsCached();
  return pickDiscountsForDate(list, orderDate);
}

export { isDiscountActiveForDate, pickDiscountsForDate };
