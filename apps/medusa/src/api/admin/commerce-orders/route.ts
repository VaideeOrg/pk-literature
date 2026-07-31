import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listOrders } from "../../../lib/commerce-orders.repository";

// Custom admin route, not a Medusa module - queries apps/api-commerce's
// own `commerce.orders` directly (commerce-orders.repository.ts) rather
// than Medusa's own Order module, which stays pointed at its separate,
// unused `medusa` schema. Automatically covered by Medusa's built-in
// "/admin*" auth middleware (api/middlewares.js), same as every native
// admin route - no extra auth wiring needed here.
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const limit = Number(req.query.limit ?? 20);
  const offset = Number(req.query.offset ?? 0);

  const { orders, count } = await listOrders({ status, q, limit, offset });
  res.status(200).json({ orders, count, limit, offset });
}
