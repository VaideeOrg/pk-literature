import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ORDER_STATUSES, updateOrderStatus, type OrderStatus } from "../../../../../lib/commerce-orders.repository";

interface UpdateStatusBody {
  status?: string;
}

export async function POST(req: MedusaRequest<UpdateStatusBody>, res: MedusaResponse): Promise<void> {
  const status = req.body.status;
  if (!status || !ORDER_STATUSES.includes(status as OrderStatus)) {
    res.status(400).json({ message: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
    return;
  }

  const updated = await updateOrderStatus(req.params.id!, status as OrderStatus);
  if (!updated) {
    res.status(404).json({ message: `Order ${req.params.id} not found` });
    return;
  }
  res.status(200).json({ success: true });
}
