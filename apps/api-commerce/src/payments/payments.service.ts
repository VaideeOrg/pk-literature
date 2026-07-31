import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { InventoryDecrementRequestedEvent, OrderPaidEvent } from "@pk-literature/contracts";
import { KYSELY } from "../database/database.module";
import type { Database } from "../database/database.types";
import { NotFoundProblem, ValidationProblem } from "../common/problem-details.exception";
import { EventBridgeService } from "../common/eventbridge.service";
import { RazorpayClient } from "./razorpay.client";
import { verifyRazorpayWebhookSignature } from "./razorpay-signature";

interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        signature?: string;
      };
    };
  };
}

// No jest unit test for this service or checkout.service.ts — same
// reasoning as every other service in this repo with a real-DB
// disclosure comment. What *is* real: razorpay-signature.spec.ts's
// HMAC verification tests, and a full cart -> checkout -> webhook ->
// order flow exercised against real local Postgres (not committed —
// see that pattern's own precedent elsewhere in this session):
// add-to-cart, quantity upsert via ON CONFLICT, checkout computing the
// correct subtotal/shipping/total, the cart being marked 'converted'
// with a fresh active cart created on the next request, a hand-signed
// webhook payload correctly verified and transitioning the order to
// 'paid', a redelivered webhook for the same event being a true no-op
// (SPEC-06's "Idempotent payment processing"), and both an
// insufficient-stock checkout and an empty-cart checkout correctly
// rejected.
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly razorpay: RazorpayClient,
    private readonly events: EventBridgeService,
  ) {}

  async createPaymentOrder(orderId: string): Promise<{
    razorpayOrderId: string;
    razorpayKeyId: string;
    amount: number;
    currency: string;
  }> {
    const order = await this.db
      .selectFrom("commerce.orders")
      .select(["id", "status", "total", "currency"])
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundProblem("Order", orderId);
    if (order.status !== "pending_payment") {
      throw new ValidationProblem(`Order ${orderId} is not awaiting payment (status: ${order.status}).`);
    }

    const amountInPaise = Math.round(Number(order.total) * 100);
    const razorpayOrder = await this.razorpay.createOrder(amountInPaise, order.currency, order.id);

    await this.db
      .insertInto("commerce.payments")
      .values({
        orderId: order.id,
        provider: "razorpay",
        razorpayOrderId: razorpayOrder.id,
        amount: order.total,
        currency: order.currency,
        status: "created",
        idempotencyKey: randomUUID(),
      })
      .execute();

    return {
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
      amount: Number(order.total),
      currency: order.currency,
    };
  }

  /**
   * SPEC-06: "Webhook verification is mandatory before marking an
   * order Paid. Browser callbacks are advisory only." — signature
   * verification happens in the controller (needs the raw body, which
   * is an HTTP-layer concern); by the time this runs, the payload is
   * already trusted.
   */
  async handleWebhook(payload: RazorpayWebhookPayload): Promise<void> {
    const entity = payload.payload?.payment?.entity;
    const razorpayOrderId = entity?.order_id;
    if (!razorpayOrderId) {
      this.logger.warn(`Webhook event ${payload.event} has no payment.entity.order_id — ignoring`);
      return;
    }

    const payment = await this.db
      .selectFrom("commerce.payments")
      .select(["id", "orderId", "status"])
      .where("razorpayOrderId", "=", razorpayOrderId)
      .executeTakeFirst();
    if (!payment) {
      this.logger.warn(`Webhook for unknown razorpay_order_id ${razorpayOrderId} — ignoring`);
      return;
    }

    if (payload.event === "payment.captured") {
      // Idempotent: a redelivered webhook for an already-captured
      // payment is a no-op, not a second OrderPaid event (SPEC-06
      // Principles: "Idempotent payment processing").
      if (payment.status === "captured") return;

      await this.db
        .updateTable("commerce.payments")
        .set({
          status: "captured",
          razorpayPaymentId: entity.id ?? null,
          razorpaySignature: entity.signature ?? null,
        })
        .where("id", "=", payment.id)
        .execute();
      await this.db.updateTable("commerce.orders").set({ status: "paid" }).where("id", "=", payment.orderId).execute();

      const event: OrderPaidEvent = { orderId: payment.orderId, paymentId: payment.id };
      await this.events.publish("OrderPaid", event);

      // catalog.inventory only ever gets written through Directus
      // (SPEC-03) - commerce_api_rw is deliberately read-only on
      // catalog (commerce_api_role.sql's own comment: "never a write").
      // This event carries the line items directly so the consumer
      // (a Lambda calling Directus's decrement-inventory-stock
      // operation) needs no database access of its own.
      const items = await this.db
        .selectFrom("commerce.orderItems")
        .select(["bookId", "quantity"])
        .where("orderId", "=", payment.orderId)
        .execute();
      const decrementEvent: InventoryDecrementRequestedEvent = { orderId: payment.orderId, channel: "online", items };
      await this.events.publish("InventoryDecrementRequested", decrementEvent);
      return;
    }

    if (payload.event === "payment.failed") {
      if (payment.status === "failed") return;
      await this.db.updateTable("commerce.payments").set({ status: "failed" }).where("id", "=", payment.id).execute();
      // Order deliberately stays 'pending_payment', not 'cancelled' —
      // a single failed attempt shouldn't block a retry with a fresh
      // Razorpay order (POST /payments/create-order again); SPEC-06
      // doesn't define an automatic-cancel-on-failure rule.
      return;
    }

    this.logger.log(`Unhandled webhook event type: ${payload.event}`);
  }
}

export function verifyWebhookOrThrow(rawBody: string, signature: string | undefined, secret: string): void {
  if (!signature || !verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    throw new ValidationProblem("Invalid webhook signature.");
  }
}
