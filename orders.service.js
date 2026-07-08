import { v4 as uuid } from 'uuid';
import { execute, queryAll, queryOne, isMySQL } from './database.js';

function num(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function str(v) {
  return String(v || '').trim();
}

const ORDER_STATUSES = ['new', 'assigned', 'in_progress', 'on_delivery', 'done', 'cancelled'];
const PAYMENT_TYPES = ['cash', 'transfer', 'credit'];

const CAPTAIN_STATUS_FLOW = {
  new: 'in_progress',
  assigned: 'in_progress',
  in_progress: 'on_delivery',
  on_delivery: ['done', 'cancelled'],
};

function normalizeStatus(v) {
  const status = str(v).toLowerCase();
  return ORDER_STATUSES.includes(status) ? status : 'new';
}

function normalizePaymentType(v) {
  const payment = str(v).toLowerCase();
  return PAYMENT_TYPES.includes(payment) ? payment : 'cash';
}

async function upsertCustomer(payload) {
  const customerName = str(payload.customer_name || payload.name);
  if (!customerName) throw new Error('اسم العميل مطلوب');

  const customerPhone = str(payload.customer_phone || payload.phone);
  const addressText = str(payload.address_text);
  const mapLink = str(payload.map_link);
  const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";

  let customer = null;
  if (customerPhone) {
    customer = await queryOne('SELECT * FROM customers WHERE phone = ? ORDER BY created_at DESC LIMIT 1', [customerPhone]);
  }
  if (!customer) {
    customer = await queryOne('SELECT * FROM customers WHERE name = ? ORDER BY created_at DESC LIMIT 1', [customerName]);
  }

  if (!customer) {
    const id = uuid();
    await execute(
      'INSERT INTO customers (id, name, phone, address_text, map_link) VALUES (?, ?, ?, ?, ?)',
      [id, customerName, customerPhone, addressText, mapLink]
    );
    return queryOne('SELECT * FROM customers WHERE id = ?', [id]);
  }

  await execute(
    `UPDATE customers
     SET name = ?, phone = ?, address_text = ?, map_link = ?, updated_at = ${updatedAt}
     WHERE id = ?`,
    [
      customerName,
      customerPhone || customer.phone || '',
      addressText || customer.address_text || '',
      mapLink || customer.map_link || '',
      customer.id,
    ]
  );
  return queryOne('SELECT * FROM customers WHERE id = ?', [customer.id]);
}

async function attachItems(orders) {
  if (!orders.length) return orders;
  const placeholders = orders.map(() => '?').join(', ');
  const rows = await queryAll(
    `SELECT oi.*, s.name AS finance_store_name
     FROM order_items oi
     LEFT JOIN finance_stores s ON s.id = oi.store_id
     WHERE oi.order_id IN (${placeholders})
     ORDER BY oi.created_at ASC`,
    orders.map(o => o.id)
  );
  const map = new Map();
  for (const row of rows) {
    const current = map.get(row.order_id) || [];
    current.push({
      id: row.id,
      store_id: row.store_id,
      store_name: row.finance_store_name || row.store_name || 'بدون محل',
      details: row.details || '',
    });
    map.set(row.order_id, current);
  }
  return orders.map(order => ({ ...order, items: map.get(order.id) || [] }));
}

function withDisplayNumbers(orders) {
  return orders.map((order, index) => ({ ...order, display_number: index + 1 }));
}

export async function listCustomers(queryText = '') {
  const q = `%${str(queryText)}%`;
  const rows = await queryAll(
    `SELECT *
     FROM customers
     WHERE name LIKE ? OR phone LIKE ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 30`,
    [q, q]
  );
  return rows;
}

export async function listOrders({ status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    where = 'WHERE o.status = ?';
    params.push(normalizeStatus(status));
  }
  const rows = await queryAll(
    `SELECT o.*, c.name AS captain_name, c.captain_number
     FROM \`orders\` o
     LEFT JOIN captains c ON c.id = o.captain_id
     ${where}
     ORDER BY o.created_at DESC`,
    params
  );
  return attachItems(rows);
}

export async function listCaptainOrders(captainId, { status } = {}) {
  const params = [captainId];
  let where = 'WHERE o.captain_id = ?';
  if (status) {
    where += ' AND o.status = ?';
    params.push(normalizeStatus(status));
  } else {
    where += " AND o.status NOT IN ('done', 'cancelled')";
  }
  const rows = await queryAll(
    `SELECT o.*
     FROM \`orders\` o
     ${where}
     ORDER BY o.created_at DESC`,
    params
  );
  const withItems = await attachItems(rows);
  return withDisplayNumbers(withItems);
}

function orderUserFields(payload) {
  return {
    userId: str(payload.user_id) || null,
    userName: str(payload.user_name) || '',
  };
}

export async function createOrder(payload) {
  const customer = await upsertCustomer(payload);
  const detailsRows = Array.isArray(payload.items) ? payload.items : [];
  const validItems = detailsRows
    .map((row) => ({
      store_id: str(row.store_id) || null,
      details: str(row.details),
    }))
    .filter(row => row.details);
  if (!validItems.length) throw new Error('أدخل تفاصيل الطلب');

  const orderId = uuid();
  const orderAddress = str(payload.address_text) || customer.address_text || '';
  const orderMap = str(payload.map_link) || customer.map_link || '';
  const { userId, userName: rawUserName } = orderUserFields(payload);
  const userName = rawUserName || 'مستخدم';
  await execute(
    `INSERT INTO \`orders\`
      (id, customer_id, customer_name, customer_phone, address_text, map_link, delivery_fee, captain_id, status, payment_type,
       created_by_user_id, created_by_user_name, updated_by_user_id, updated_by_user_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      customer.id,
      customer.name,
      customer.phone || '',
      orderAddress,
      orderMap,
      num(payload.delivery_fee),
      payload.captain_id || null,
      normalizeStatus(payload.status || 'new'),
      normalizePaymentType(payload.payment_type),
      userId,
      userName,
      userId,
      userName,
    ]
  );

  for (const item of validItems) {
    let storeName = 'بدون محل';
    if (item.store_id) {
      const store = await queryOne('SELECT name FROM finance_stores WHERE id = ?', [item.store_id]);
      storeName = store?.name || storeName;
    }
    await execute(
      'INSERT INTO order_items (id, order_id, store_id, store_name, details) VALUES (?, ?, ?, ?, ?)',
      [uuid(), orderId, item.store_id, storeName, item.details]
    );
  }

  const rows = await listOrders({});
  return rows.find(r => r.id === orderId) || null;
}

export async function updateOrder(orderId, payload) {
  const existing = await queryOne('SELECT * FROM `orders` WHERE id = ?', [orderId]);
  if (!existing) throw new Error('الطلب غير موجود');

  const customerName = str(payload.customer_name) || existing.customer_name;
  const customerPhone = str(payload.customer_phone) || existing.customer_phone || '';
  const customer = await upsertCustomer({
    name: customerName,
    phone: customerPhone,
    address_text: str(payload.address_text) || existing.address_text,
    map_link: str(payload.map_link) || existing.map_link,
  });

  const detailsRows = Array.isArray(payload.items) ? payload.items : null;
  const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
  const { userId, userName: rawUserName } = orderUserFields(payload);
  const nextUserName = rawUserName || existing.updated_by_user_name || existing.created_by_user_name || '';
  await execute(
    `UPDATE \`orders\`
     SET customer_id = ?, customer_name = ?, customer_phone = ?, address_text = ?, map_link = ?,
         delivery_fee = ?, captain_id = ?, status = ?, payment_type = ?, updated_at = ${updatedAt},
         updated_by_user_id = ?, updated_by_user_name = ?
     WHERE id = ?`,
    [
      customer.id,
      customer.name,
      customer.phone || '',
      str(payload.address_text) || customer.address_text || '',
      str(payload.map_link) || customer.map_link || '',
      payload.delivery_fee !== undefined ? num(payload.delivery_fee) : num(existing.delivery_fee),
      payload.captain_id !== undefined ? (payload.captain_id || null) : existing.captain_id,
      payload.status ? normalizeStatus(payload.status) : normalizeStatus(existing.status),
      payload.payment_type !== undefined ? normalizePaymentType(payload.payment_type) : normalizePaymentType(existing.payment_type),
      userId || existing.updated_by_user_id || existing.created_by_user_id || null,
      nextUserName,
      orderId,
    ]
  );

  if (detailsRows) {
    const validItems = detailsRows
      .map((row) => ({
        store_id: str(row.store_id) || null,
        details: str(row.details),
      }))
      .filter(row => row.details);

    await execute('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    for (const item of validItems) {
      let storeName = 'بدون محل';
      if (item.store_id) {
        const store = await queryOne('SELECT name FROM finance_stores WHERE id = ?', [item.store_id]);
        storeName = store?.name || storeName;
      }
      await execute(
        'INSERT INTO order_items (id, order_id, store_id, store_name, details) VALUES (?, ?, ?, ?, ?)',
        [uuid(), orderId, item.store_id, storeName, item.details]
      );
    }
  }

  const rows = await listOrders({});
  return rows.find(r => r.id === orderId) || null;
}

function assertCaptainStatusTransition(currentStatus, nextStatus) {
  const current = normalizeStatus(currentStatus);
  const next = normalizeStatus(nextStatus);
  const allowed = CAPTAIN_STATUS_FLOW[current];
  if (!allowed) {
    throw new Error('لا يمكن تحديث حالة هذا الطلب');
  }
  if (Array.isArray(allowed)) {
    if (!allowed.includes(next)) throw new Error('انتقال الحالة غير مسموح');
    return next;
  }
  if (allowed !== next) throw new Error('انتقال الحالة غير مسموح');
  return next;
}

export async function updateCaptainOrderStatus(captainId, orderId, nextStatus) {
  const existing = await queryOne('SELECT * FROM `orders` WHERE id = ? AND captain_id = ?', [orderId, captainId]);
  if (!existing) throw new Error('الطلب غير موجود أو غير معيّن لك');

  const status = assertCaptainStatusTransition(existing.status, nextStatus);
  const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
  await execute(
    `UPDATE \`orders\` SET status = ?, updated_at = ${updatedAt} WHERE id = ?`,
    [status, orderId]
  );

  const order = await queryOne('SELECT * FROM `orders` WHERE id = ?', [orderId]);
  const [enriched] = await attachItems([order]);
  return enriched;
}
