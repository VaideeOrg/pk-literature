import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { searchCatalogBooks } from "../../../lib/commerce-orders.repository";

// Backs the store-order creation form's book picker - read-only
// against catalog (migration 20260401000008_medusa_app_catalog_read.sql).
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q) {
    res.status(200).json({ books: [] });
    return;
  }
  const books = await searchCatalogBooks(q, 10);
  res.status(200).json({ books });
}
