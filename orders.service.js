import { v4 as uuid } from 'uuid';
import { execute, queryAll, queryOne, isMySQL } from './database.js';
import { postCompletedOrderFinance } from './finance.service.js';

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
  in_progress: ['on_delivery', 'cancelled'],
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

const STATUS_TIMESTAMP_COL = {
  assigned: 'assigned_at',
  in_progress: 'in_progress_at',
  on_delivery: 'on_delivery_at',
  done: 'done_at',
  cancelled: 'cancelled_at',
};

async function touchStatusTimestamp(orderId, status, existing = {}) {
  const col = STATUS_TIMESTAMP_COL[normalizeStatus(status)];
  if (!col || existing[col]) return;
  const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
  await execute(`UPDATE \`orders\` SET ${col} = ${updatedAt} WHERE id = ?`, [orderId]);
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
      invoice_amount: num(row.invoice_amount),
    });
    map.set(row.order_id, current);
  }
  return orders.map((order) => {
    const items = map.get(order.id) || [];
    const invoice_total = items.reduce((sum, item) => sum + num(item.invoice_amount), 0);
    const delivery_fee = num(order.delivery_fee);
    return {
      ...order,
      items,
      invoice_total,
      grand_total: num(invoice_total + delivery_fee),
    };
  });
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
  if (status && status !== 'all') {
    where += ' AND o.status = ?';
    params.push(normalizeStatus(status));
  } else {
    where += " AND o.status != 'new'";
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

async function notifyCaptainOrderAssigned(captainId, { customerName, addressText } = {}) {
  if (!captainId) return;

  const captain = await queryOne('SELECT id, name, phone FROM captains WHERE id = ?', [captainId]);
  if (!captain) return;

  const body = `طلب جديد معيّن لك — العميل: ${customerName || '—'}${addressText ? ` — ${addressText}` : ''}`;
  const logId = uuid();

  await execute(
    `INSERT INTO sms_log (id, message_id, captain_id, captain_name, captain_phone, body, status, source)
     VALUES (?, NULL, ?, ?, ?, ?, 'sent', 'order')`,
    [logId, captain.id, captain.name, captain.phone || '', body]
  );
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

  await touchStatusTimestamp(orderId, normalizeStatus(payload.status || 'new'), {});

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

  if (payload.captain_id) {
    await notifyCaptainOrderAssigned(payload.captain_id, {
      customerName: customer.name,
      addressText: orderAddress,
    });
  }

  const rows = await listOrders({});
  return rows.find(r => r.id === orderId) || null;
}

export async function updateOrder(orderId, payload) {
  const existing = await queryOne('SELECT * FROM `orders` WHERE id = ?', [orderId]);
  if (!existing) throw new Error('الطلب غير موجود');

  const existingStatus = normalizeStatus(existing.status);
  const isLocked = existingStatus === 'done' || existingStatus === 'cancelled';
  if (
    isLocked
    && payload.captain_id !== undefined
    && (payload.captain_id || null) !== (existing.captain_id || null)
  ) {
    throw new Error('لا يمكن تغيير الكابتن لطلب مكتمل أو ملغي');
  }

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
  const nextStatus = payload.status ? normalizeStatus(payload.status) : normalizeStatus(existing.status);
  const prevCaptainId = existing.captain_id || null;
  const nextCaptainId = payload.captain_id !== undefined ? (payload.captain_id || null) : prevCaptainId;
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
      nextCaptainId,
      nextStatus,
      payload.payment_type !== undefined ? normalizePaymentType(payload.payment_type) : normalizePaymentType(existing.payment_type),
      userId || existing.updated_by_user_id || existing.created_by_user_id || null,
      nextUserName,
      orderId,
    ]
  );

  if (nextStatus !== normalizeStatus(existing.status)) {
    await touchStatusTimestamp(orderId, nextStatus, existing);
  }

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

  if (nextCaptainId && nextCaptainId !== prevCaptainId) {
    await notifyCaptainOrderAssigned(nextCaptainId, {
      customerName: customer.name,
      addressText: str(payload.address_text) || customer.address_text || existing.address_text || '',
    });
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
  const captain = await queryOne('SELECT name FROM captains WHERE id = ?', [captainId]);
  const updatedAt = isMySQL ? 'NOW()' : "datetime('now')";
  await execute(
    `UPDATE \`orders\` SET status = ?, updated_at = ${updatedAt}, updated_by_user_id = ?, updated_by_user_name = ? WHERE id = ?`,
    [status, captainId, captain?.name || 'كابتن', orderId]
  );

  await touchStatusTimestamp(orderId, status, existing);

  const order = await queryOne('SELECT * FROM `orders` WHERE id = ?', [orderId]);
  const [enriched] = await attachItems([order]);

  if (status === 'done') {
    await postCompletedOrderFinance(enriched);
  }

  return enriched;
}

export async function updateCaptainOrderItems(captainId, orderId, items) {
  const existing = await queryOne('SELECT * FROM `orders` WHERE id = ? AND captain_id = ?', [orderId, captainId]);
  if (!existing) throw new Error('الطلب غير موجود أو غير معيّن لك');

  const status = normalizeStatus(existing.status);
  if (!['assigned', 'in_progress', 'on_delivery'].includes(status)) {
    throw new Error('لا يمكن تعديل الفاتورة في هذه الحالة');
  }

  const rows = Array.isArray(items) ? items : [];
  for (const row of rows) {
    const itemId = str(row.id);
    if (!itemId) continue;
    await execute(
      'UPDATE order_items SET invoice_amount = ? WHERE id = ? AND order_id = ?',
      [num(row.invoice_amount), itemId, orderId]
    );
  }

  const order = await queryOne('SELECT * FROM `orders` WHERE id = ?', [orderId]);
  const [enriched] = await attachItems([order]);
  return enriched;
}
