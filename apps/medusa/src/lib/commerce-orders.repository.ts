import { getCommerceDb } from "./commerce-db";

// Mirrors commerce.order_status exactly (apps/api-commerce/migrations/
// 20260401000002_commerce_orders.sql) - kept as a plain literal union
// here rather than importing @pk-literature/domain-types, since this
// admin surface is intentionally self-contained (apps/medusa has no
// other workspace-package dependency today; see README.md's scope-
// boundary section).
export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "paid",
  "packed",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "refunded",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: string;
  total: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  itemCount: number;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: string;
  subtotal: string;
  shippingCost: string;
  total: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  updatedAt: string;
  items: { id: string; bookId: string; titleSnapshot: string; unitPrice: string; currency: string; quantity: number }[];
  shippingAddress: AddressRow | null;
  billingAddress: AddressRow | null;
  payments: { id: string; provider: string; razorpayOrderId: string; razorpayPaymentId: string | null; amount: string; currency: string; status: string; createdAt: string }[];
  shipments: { id: string; carrier: string | null; trackingNumber: string | null; status: string; shippedAt: string | null; deliveredAt: string | null; createdAt: string }[];
  refunds: { id: string; amount: string; reason: string | null; status: string; createdAt: string }[];
}

interface AddressRow {
  id: string;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
}

export async function listOrders(params: {
  status?: string;
  channel?: string;
  q?: string;
  limit: number;
  offset: number;
}): Promise<{ orders: OrderListRow[]; count: number }> {
  const db = getCommerceDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    values.push(params.status);
    conditions.push(`o.status = $${values.length}`);
  }
  if (params.channel) {
    values.push(params.channel);
    conditions.push(`o.channel = $${values.length}`);
  }
  if (params.q) {
    values.push(`%${params.q}%`);
    conditions.push(`(o.order_number ILIKE $${values.length} OR o.contact_email ILIKE $${values.length})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await db.query<{ count: string }>(
    `SELECT count(*) FROM commerce.orders o ${where}`,
    values,
  );

  values.push(params.limit, params.offset);
  const rowsResult = await db.query(
    `
    SELECT
      o.id, o.order_number, o.status, o.channel, o.total, o.currency,
      o.contact_email, o.contact_phone, o.created_at,
      (SELECT count(*) FROM commerce.order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM commerce.orders o
    ${where}
    ORDER BY o.created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values,
  );

  return {
    count: Number(countResult.rows[0]?.count ?? 0),
    orders: rowsResult.rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      status: r.status,
      channel: r.channel,
      total: r.total,
      currency: r.currency,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      itemCount: Number(r.item_count),
      createdAt: r.created_at,
    })),
  };
}

export async function getOrderDetail(id: string): Promise<OrderDetail | null> {
  const db = getCommerceDb();

  const orderResult = await db.query(
    `
    SELECT
      o.id, o.order_number, o.status, o.channel, o.subtotal, o.shipping_cost, o.total,
      o.currency, o.contact_email, o.contact_phone, o.created_at, o.updated_at,
      o.shipping_address_id, o.billing_address_id
    FROM commerce.orders o
    WHERE o.id = $1
    `,
    [id],
  );
  const order = orderResult.rows[0];
  if (!order) return null;

  const [itemsResult, addressesResult, paymentsResult, shipmentsResult, refundsResult] = await Promise.all([
    db.query(
      `SELECT id, book_id, title_snapshot, unit_price, currency, quantity FROM commerce.order_items WHERE order_id = $1 ORDER BY id`,
      [id],
    ),
    db.query<AddressRowSql>(
      `SELECT id, recipient_name, line1, line2, city, state, postal_code, country, phone FROM commerce.addresses WHERE id = ANY($1::uuid[])`,
      [[order.shipping_address_id, order.billing_address_id].filter(Boolean)],
    ),
    db.query(
      `SELECT id, provider, razorpay_order_id, razorpay_payment_id, amount, currency, status, created_at FROM commerce.payments WHERE order_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
    db.query(
      `SELECT id, carrier, tracking_number, status, shipped_at, delivered_at, created_at FROM commerce.shipments WHERE order_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
    db.query(
      `SELECT id, amount, reason, status, created_at FROM commerce.refunds WHERE order_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
  ]);

  const addressesById = new Map(addressesResult.rows.map((a) => [a.id, mapAddress(a)]));

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    channel: order.channel,
    subtotal: order.subtotal,
    shippingCost: order.shipping_cost,
    total: order.total,
    currency: order.currency,
    contactEmail: order.contact_email,
    contactPhone: order.contact_phone,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: itemsResult.rows.map((r) => ({
      id: r.id,
      bookId: r.book_id,
      titleSnapshot: r.title_snapshot,
      unitPrice: r.unit_price,
      currency: r.currency,
      quantity: r.quantity,
    })),
    shippingAddress: order.shipping_address_id ? (addressesById.get(order.shipping_address_id) ?? null) : null,
    billingAddress: order.billing_address_id ? (addressesById.get(order.billing_address_id) ?? null) : null,
    payments: paymentsResult.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      razorpayOrderId: r.razorpay_order_id,
      razorpayPaymentId: r.razorpay_payment_id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at,
    })),
    shipments: shipmentsResult.rows.map((r) => ({
      id: r.id,
      carrier: r.carrier,
      trackingNumber: r.tracking_number,
      status: r.status,
      shippedAt: r.shipped_at,
      deliveredAt: r.delivered_at,
      createdAt: r.created_at,
    })),
    refunds: refundsResult.rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}

interface AddressRowSql {
  id: string;
  recipient_name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string;
}

function mapAddress(a: AddressRowSql): AddressRow {
  return {
    id: a.id,
    recipientName: a.recipient_name,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postalCode: a.postal_code,
    country: a.country,
    phone: a.phone,
  };
}

export async function updateOrderStatus(id: string, status: OrderStatus): Promise<boolean> {
  const db = getCommerceDb();
  const result = await db.query(`UPDATE commerce.orders SET status = $2 WHERE id = $1`, [id, status]);
  return (result.rowCount ?? 0) > 0;
}

// Creating a shipment record also advances the order's own status to
// 'shipped' - commerce.orders.status and commerce.shipments.status are
// two separate columns with no DB trigger linking them (see
// 20260401000002_commerce_orders.sql), so this admin action keeps them
// in sync deliberately rather than leaving an order stuck at 'paid'/
// 'packed' after a shipment's been recorded.
export async function createShipment(
  orderId: string,
  input: { carrier: string | null; trackingNumber: string | null },
): Promise<{ id: string } | null> {
  const db = getCommerceDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const orderExists = await client.query(`SELECT id FROM commerce.orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (orderExists.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const shipmentResult = await client.query(
      `INSERT INTO commerce.shipments (order_id, carrier, tracking_number, status, shipped_at) VALUES ($1, $2, $3, 'shipped', now()) RETURNING id`,
      [orderId, input.carrier, input.trackingNumber],
    );
    await client.query(`UPDATE commerce.orders SET status = 'shipped' WHERE id = $1`, [orderId]);
    await client.query("COMMIT");
    return { id: shipmentResult.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Mirrors commerce.order_channel exactly (apps/api-commerce/migrations/
// 20260401000007_orders_channel.sql).
export const ORDER_CHANNELS = ["online", "store_erode", "store_perundurai"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export interface CatalogBookSearchRow {
  id: string;
  title: string;
  isbn13: string | null;
  price: string | null;
  currency: string | null;
  stock: number | null;
}

// Read-only against catalog (migration 20260401000008_medusa_app_catalog_read.sql)
// - only ever used to populate the store-order creation form's book
// picker and prefill a price, never written back to directly.
export async function searchCatalogBooks(q: string, limit: number): Promise<CatalogBookSearchRow[]> {
  const db = getCommerceDb();
  const result = await db.query(
    `
    SELECT b.id, b.title, b.isbn13, i.price, i.currency, i.stock
    FROM catalog.books b
    LEFT JOIN catalog.inventory i ON i.book_id = b.id
    WHERE b.status = 'published' AND (b.title ILIKE $1 OR b.isbn13 = $2)
    ORDER BY b.title
    LIMIT $3
    `,
    [`%${q}%`, q, limit],
  );
  return result.rows;
}

export interface CreateStoreOrderInput {
  channel: Exclude<OrderChannel, "online">;
  contactEmail: string | null;
  contactPhone: string | null;
  items: { bookId: string; titleSnapshot: string; unitPrice: number; currency: string; quantity: number }[];
}

// A walk-in sale, logged by a store keeper after the fact - already
// paid for in person, so this skips cart/checkout/Razorpay entirely
// and lands straight at 'completed' (no packed/shipped/delivered
// steps for a customer who already walked out with the book). No
// shipping cost - nothing is being shipped.
export async function createStoreOrder(
  input: CreateStoreOrderInput,
): Promise<{ id: string; orderNumber: string; items: { bookId: string; quantity: number }[] }> {
  if (input.items.length === 0) {
    throw new Error("A store order needs at least one item.");
  }

  const db = getCommerceDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const currency = input.items[0]!.currency;
    const subtotal = input.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const orderNumber = `ORD-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;

    const orderResult = await client.query(
      `
      INSERT INTO commerce.orders (order_number, status, channel, subtotal, shipping_cost, total, currency, contact_email, contact_phone)
      VALUES ($1, 'completed', $2, $3, 0, $3, $4, $5, $6)
      RETURNING id, order_number
      `,
      [orderNumber, input.channel, subtotal, currency, input.contactEmail, input.contactPhone],
    );
    const order = orderResult.rows[0];

    for (const item of input.items) {
      await client.query(
        `INSERT INTO commerce.order_items (order_id, book_id, title_snapshot, unit_price, currency, quantity) VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.bookId, item.titleSnapshot, item.unitPrice, item.currency, item.quantity],
      );
    }

    await client.query("COMMIT");
    return {
      id: order.id,
      orderNumber: order.order_number,
      items: input.items.map((i) => ({ bookId: i.bookId, quantity: i.quantity })),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
