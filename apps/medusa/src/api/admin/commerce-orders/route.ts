import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { createStoreOrder, listOrders, ORDER_CHANNELS, type OrderChannel } from "../../../lib/commerce-orders.repository";
import { publishEvent } from "../../../lib/eventbridge";

// Custom admin route, not a Medusa module - queries apps/api-commerce's
// own `commerce.orders` directly (commerce-orders.repository.ts) rather
// than Medusa's own Order module, which stays pointed at its separate,
// unused `medusa` schema. Automatically covered by Medusa's built-in
// "/admin*" auth middleware (api/middlewares.js), same as every native
// admin route - no extra auth wiring needed here.
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const limit = Number(req.query.limit ?? 20);
  const offset = Number(req.query.offset ?? 0);

  const { orders, count } = await listOrders({ status, channel, q, limit, offset });
  res.status(200).json({ orders, count, limit, offset });
}

interface CreateStoreOrderBody {
  channel?: string;
  contactEmail?: string;
  contactPhone?: string;
  items?: { bookId: string; titleSnapshot: string; unitPrice: number; currency: string; quantity: number }[];
}

const STORE_CHANNELS = ORDER_CHANNELS.filter((c): c is Exclude<OrderChannel, "online"> => c !== "online");

// Logs a walk-in sale at one of the physical stores - see
// commerce-orders.repository.ts's createStoreOrder() for why this
// skips cart/checkout/Razorpay and lands straight at 'completed'.
export async function POST(req: MedusaRequest<CreateStoreOrderBody>, res: MedusaResponse): Promise<void> {
  const { channel, contactEmail, contactPhone, items } = req.body;

  if (!channel || !STORE_CHANNELS.includes(channel as (typeof STORE_CHANNELS)[number])) {
    res.status(400).json({ message: `channel must be one of: ${STORE_CHANNELS.join(", ")}` });
    return;
  }
  if (!items || items.length === 0) {
    res.status(400).json({ message: "items must be a non-empty array" });
    return;
  }

  const order = await createStoreOrder({
    channel: channel as (typeof STORE_CHANNELS)[number],
    contactEmail: contactEmail ?? null,
    contactPhone: contactPhone ?? null,
    items,
  });

  await publishEvent("InventoryDecrementRequested", { orderId: order.id, channel, items: order.items });

  res.status(201).json({ order });
}
