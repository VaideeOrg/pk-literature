import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getOrderDetail } from "../../../../lib/commerce-orders.repository";

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const order = await getOrderDetail(req.params.id!);
  if (!order) {
    res.status(404).json({ message: `Order ${req.params.id} not found` });
    return;
  }
  res.status(200).json({ order });
}
