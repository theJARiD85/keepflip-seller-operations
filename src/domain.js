import { createHash } from 'node:crypto';

export class SellerError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function ensure(condition, code, message, status = 400) {
  if (!condition) throw new SellerError(code, message, status);
}
export function object(value) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'Expected an object.');
  return value;
}
export function only(value, keys) {
  object(value);
  ensure(Object.keys(value).every(key => keys.includes(key)), 'INVALID_INPUT', 'Unsupported fields. Do not include buyer information.');
}
export function string(value, label, max = 120, optional = false) {
  if (optional && (value == null || value === '')) return null;
  ensure(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\x00-\x1f]/.test(value), 'INVALID_INPUT', label + ' is invalid.');
  return value.trim();
}
export function id(value) {
  ensure(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(value), 'INVALID_INPUT', 'Invalid resource ID.');
  return value;
}
export function integer(value, label, max = 1_000_000_000, min = 0) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', label + ' must be a whole number in range.');
  return value;
}
export function date(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'INVALID_INPUT', label + ' must be an ISO date/time.');
  return new Date(value).toISOString();
}
export function currency(value) {
  ensure(typeof value === 'string' && /^[A-Z]{3}$/.test(value), 'INVALID_INPUT', 'Use a three-letter currency code.');
  try { ensure(new Intl.NumberFormat('en', { style: 'currency', currency: value }).resolvedOptions().maximumFractionDigits === 2, 'INVALID_INPUT', 'P0 supports currencies with two decimal places.'); }
  catch { throw new SellerError('INVALID_INPUT', 'Unsupported currency.'); }
  return value;
}
export const moneyKeys = ['costBasisCents', 'feesCents', 'shippingCostCents', 'refundsCents', 'otherCostsCents', 'payoutCents'];
export function money(value) {
  only(value, moneyKeys);
  ensure(moneyKeys.every(key => Object.hasOwn(value, key)), 'INVALID_INPUT', 'Provide every reconciliation amount; use null for unknown.');
  return Object.fromEntries(moneyKeys.map(key => [key, value[key] === null ? null : integer(value[key], key)]));
}
export function margin(order) {
  const unknown = moneyKeys.filter(key => key !== 'payoutCents' && order.money[key] === null);
  const netRevenueCents = order.money.refundsCents === null ? null : order.saleCents + order.shippingChargedCents - order.money.refundsCents;
  const profitCents = unknown.length ? null : netRevenueCents - order.money.costBasisCents - order.money.feesCents - order.money.shippingCostCents - order.money.otherCostsCents;
  return { status: unknown.length ? 'incomplete' : 'reconciled', unknown, netRevenueCents, profitCents,
    marginPercent: profitCents !== null && netRevenueCents > 0 ? Math.round(profitCents / netRevenueCents * 10000) / 100 : null,
    payoutCents: order.money.payoutCents, payoutKnown: order.money.payoutCents !== null };
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const eventId = (owner, key) => 'e' + digest([owner, key]).slice(0,35);

export function normalizeCreate(input) {
  only(input, ['itemId', 'quantity', 'channel', 'saleCents', 'shippingChargedCents', 'currency', 'soldAt', 'shipBy', 'feesCents', 'shippingExpenseCents', 'refundCents', 'payoutCents', 'packingNotes']);
  const optionalMoney = (value, label) => value == null ? null : integer(value, label);
  return { itemId: id(input.itemId), quantity: integer(input.quantity, 'Quantity', 100000, 1),
    channel: string(input.channel, 'Sales channel', 40), saleCents: integer(input.saleCents, 'Item sale total'),
    shippingChargedCents: integer(input.shippingChargedCents, 'Shipping charged'), currency: currency(input.currency),
    soldAt: date(input.soldAt, 'Sold at'), shipBy: date(input.shipBy, 'Ship by', true),
    feesCents: optionalMoney(input.feesCents, 'Marketplace fees'), shippingExpenseCents: optionalMoney(input.shippingExpenseCents, 'Shipping expense'),
    refundCents: optionalMoney(input.refundCents, 'Refund amount'), payoutCents: optionalMoney(input.payoutCents, 'Payout'),
    packingNotes: typeof input.packingNotes === 'string' ? input.packingNotes.trim().slice(0, 2000) || null : null };
}export function updateOrder(order, action, input, now) {
  if (action === 'fulfillment') {
    only(input, ['shipBy', 'packingLocation', 'packed', 'carrier', 'trackingNumber']);
    ensure(order.status !== 'shipped', 'ALREADY_SHIPPED', 'Shipped fulfillment details are locked.', 409);
    ensure(typeof input.packed === 'boolean', 'INVALID_INPUT', 'Packed must be true or false.');
    order.shipBy = date(input.shipBy, 'Ship by', true);
    order.packingLocation = string(input.packingLocation, 'Packing location', 120, true);
    order.carrier = string(input.carrier, 'Carrier', 60, true);
    order.trackingNumber = string(input.trackingNumber, 'Tracking number', 100, true);
    ensure(!order.trackingNumber || /^[A-Za-z0-9 ._-]+$/.test(order.trackingNumber), 'INVALID_INPUT', 'Invalid tracking number.');
    order.status = input.packed ? 'packed' : 'awaiting_packing';
    order.packedAt = input.packed ? (order.packedAt || now) : null;
  } else if (action === 'ship') {
    only(input, ['shippedAt', 'untracked']);
    ensure(order.status === 'packed', 'NOT_PACKED', 'Confirm packing before marking shipped.', 409);
    ensure(typeof input.untracked === 'boolean', 'INVALID_INPUT', 'Confirm whether shipment is untracked.');
    ensure(input.untracked || (order.carrier && order.trackingNumber), 'TRACKING_REQUIRED', 'Add carrier and tracking or explicitly confirm untracked shipping.');
    ensure(!input.untracked || !order.trackingNumber, 'INVALID_INPUT', 'Remove tracking before confirming an untracked shipment.');
    const shippedAt = date(input.shippedAt, 'Shipped at');
    ensure(Date.parse(shippedAt) >= Date.parse(order.soldAt) && Date.parse(shippedAt) <= Date.parse(now) + 60000, 'INVALID_INPUT', 'Shipping time must be between sale time and now.');
    order.status = 'shipped'; order.shippedAt = shippedAt; order.untracked = input.untracked;
  } else if (action === 'reconcile') {
    order.money = money(input);
  } else throw new SellerError('NOT_FOUND', 'Unknown operation.', 404);
  order.updatedAt = now;
  return order;
}
export function publicOrder(row) {
  const o = JSON.parse(row.snapshotJson);
  // Strict allowlist: never return a raw inventory, provider, subscription or database row.
  return { id: row.$id, version: row.version, itemId: o.itemId, title: o.title, sku: o.sku,
    storageLocation: o.storageLocation, packingLocation: o.packingLocation, quantity: o.quantity,
    channel: o.channel, source: o.source, saleCents: o.saleCents, shippingChargedCents: o.shippingChargedCents,
    currency: o.currency, soldAt: o.soldAt, shipBy: o.shipBy, status: o.status, packedAt: o.packedAt,
    carrier: o.carrier, trackingNumber: o.trackingNumber, shippedAt: o.shippedAt, untracked: o.untracked,
    createdAt: o.createdAt, updatedAt: o.updatedAt, money: money(o.money), margin: margin(o) };
}
