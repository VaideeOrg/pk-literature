import type { EventBridgeEvent, Handler } from "aws-lambda";
import type { InventoryDecrementRequestedEvent } from "@pk-literature/contracts";
import { resolveSecretEnvVars } from "./common/resolve-secret-env-vars";

// A third Lambda entry point (alongside src/lambda.ts and
// src/eventbridge-handler.ts) - EventBridge invokes this one directly
// on InventoryDecrementRequested, from both apps/api-commerce itself
// (online orders, payments.service.ts's payment.captured handler) and
// apps/medusa (walk-in store orders). Stateless: no database connection
// at all, unlike eventbridge-handler.ts's UserRegistered consumer -
// catalog.inventory only ever gets written through Directus (SPEC-03),
// so this just relays the event's line items to Directus's
// decrement-inventory-stock webhook Flow over HTTP.
//
// Deployed in the private-nat tier (lambda_egress_sg), same as
// src/lambda.ts - it needs real internet egress to reach
// directus.<domain> (a public ALB, not VPC-internal - see directus.tf's
// module "alb_directus").
//
// NOT independently verified against a live Directus instance - the
// webhook Flow's exact `$trigger.body` shape is itself unverified (see
// bootstrap.ts's ensureInventoryDecrementFlow doc comment). If the
// first real invocation 4xxs/5xxs, check the Flow's run log before
// assuming this file's request shape is wrong.
let secretsResolved = false;

export const handler: Handler<EventBridgeEvent<"InventoryDecrementRequested", InventoryDecrementRequestedEvent>> = async (
  event,
) => {
  if (!secretsResolved) {
    await resolveSecretEnvVars();
    secretsResolved = true;
  }

  const directusUrl = process.env.DIRECTUS_URL;
  const flowId = process.env.INVENTORY_DECREMENT_FLOW_ID;
  const secret = process.env.INVENTORY_WEBHOOK_SECRET;
  if (!directusUrl || !flowId || !secret) {
    throw new Error("DIRECTUS_URL, INVENTORY_DECREMENT_FLOW_ID, and INVENTORY_WEBHOOK_SECRET must all be set");
  }

  const { orderId, items } = event.detail;
  const response = await fetch(`${directusUrl}/flows/trigger/${flowId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, secret }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`decrement-inventory-stock webhook failed for order ${orderId}: ${response.status} ${body}`);
  }
};
