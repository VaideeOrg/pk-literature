import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { createShipment } from "../../../../../lib/commerce-orders.repository";

interface CreateShipmentBody {
  carrier?: string;
  trackingNumber?: string;
}

export async function POST(req: MedusaRequest<CreateShipmentBody>, res: MedusaResponse): Promise<void> {
  const shipment = await createShipment(req.params.id!, {
    carrier: req.body.carrier ?? null,
    trackingNumber: req.body.trackingNumber ?? null,
  });
  if (!shipment) {
    res.status(404).json({ message: `Order ${req.params.id} not found` });
    return;
  }
  res.status(201).json({ shipment });
}
