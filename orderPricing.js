export function num(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export function normalizeDiscountPercent(value) {
  const pct = num(value);
  return Math.min(100, Math.max(0, pct));
}

export function normalizeDateKey(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function isDiscountActiveForDate(record, orderDate) {
  if (!record) return false;
  const pct = normalizeDiscountPercent(record.discount_percent);
  if (pct <= 0) return false;

  const orderKey = normalizeDateKey(orderDate);
  if (!orderKey) return false;

  const mode = String(record.date_mode || 'day').toLowerCase();
  if (mode === 'range') {
    const from = normalizeDateKey(record.discount_from);
    const to = normalizeDateKey(record.discount_to);
    if (!from || !to) return false;
    const safeFrom = from <= to ? from : to;
    const safeTo = from <= to ? to : from;
    return orderKey >= safeFrom && orderKey <= safeTo;
  }

  const targetDate = normalizeDateKey(record.discount_date);
  if (!targetDate) return false;
  return orderKey === targetDate;
}

export function pickDiscountsForDate(discounts, orderDate) {
  const storeMap = new Map();
  let deliveryPercent = 0;

  for (const row of discounts || []) {
    if (!isDiscountActiveForDate(row, orderDate)) continue;
    const pct = normalizeDiscountPercent(row.discount_percent);
    if (pct <= 0) continue;

    const type = String(row.discount_type || 'store').toLowerCase();
    if (type === 'store' && row.store_id) {
      storeMap.set(row.store_id, Math.max(storeMap.get(row.store_id) || 0, pct));
    } else if (type === 'delivery') {
      deliveryPercent = Math.max(deliveryPercent, pct);
    }
  }

  return { storeMap, deliveryPercent };
}

export function resolveStoreDiscountPercent(discountPercent, discountDate, orderDate) {
  const pct = normalizeDiscountPercent(discountPercent);
  if (pct <= 0) return 0;
  return isDiscountActiveForDate(
    { discount_percent: pct, date_mode: 'day', discount_date: discountDate },
    orderDate
  ) ? pct : 0;
}

export function itemStorePricing(invoiceAmount, isExternal, discountPercent = 0) {
  const gross = num(invoiceAmount);
  if (isExternal) {
    return { gross, discount_percent: 0, discount_amount: 0, net: gross };
  }
  const discount_percent = normalizeDiscountPercent(discountPercent);
  const discount_amount = num(gross * discount_percent / 100);
  return {
    gross,
    discount_percent,
    discount_amount,
    net: num(gross - discount_amount),
  };
}

export function summarizeOrderPricing(items = [], deliveryFee = 0, deliveryDiscountPercent = 0) {
  let invoice_total = 0;
  let store_discount_total = 0;
  let invoice_total_net = 0;
  let external_total = 0;
  const discountMap = new Map();

  for (const item of items) {
    const isExternal = Boolean(item.is_external);
    const pricing = itemStorePricing(
      item.invoice_amount,
      isExternal,
      item.store_discount_percent ?? item.discount_percent ?? 0
    );

    if (isExternal) {
      external_total += pricing.net;
      continue;
    }

    invoice_total += pricing.gross;
    invoice_total_net += pricing.net;
    store_discount_total += pricing.discount_amount;

    if (pricing.discount_amount > 0) {
      const key = item.store_id || item.store_name || 'unknown';
      const prev = discountMap.get(key) || {
        store_id: item.store_id,
        store_name: item.store_name || 'محل',
        discount_percent: pricing.discount_percent,
        discount_amount: 0,
      };
      prev.discount_amount = num(prev.discount_amount + pricing.discount_amount);
      discountMap.set(key, prev);
    }
  }

  const delivery_fee_gross = num(deliveryFee);
  const delivery_discount_percent = normalizeDiscountPercent(deliveryDiscountPercent);
  const delivery_discount_amount = num(delivery_fee_gross * delivery_discount_percent / 100);
  const delivery_fee = num(delivery_fee_gross - delivery_discount_amount);

  return {
    invoice_total,
    store_discount_total,
    invoice_total_net,
    external_total,
    delivery_fee_gross,
    delivery_discount_percent,
    delivery_discount_amount,
    delivery_fee,
    grand_total: num(invoice_total_net + external_total + delivery_fee),
    store_discounts: Array.from(discountMap.values()),
  };
}

export function orderTransfersDebtsAmount(order, summary) {
  const payment = String(order?.payment_type || 'cash').trim().toLowerCase();
  if (payment !== 'transfer' && payment !== 'credit') return 0;
  const invoiceNet = summary?.invoice_total_net ?? summary?.invoice_total ?? 0;
  const external = summary?.external_total ?? 0;
  const delivery = summary?.delivery_fee ?? order?.delivery_fee ?? 0;
  return num(num(invoiceNet) + num(external) + num(delivery));
}
