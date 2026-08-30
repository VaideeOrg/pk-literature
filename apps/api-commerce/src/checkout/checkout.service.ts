import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Address, Order } from "@pk-literature/domain-types";
import { KYSELY } from "../database/database.module";
import type { Database } from "../database/database.types";
import { CartService } from "../cart/cart.service";
import { EventBridgeService } from "../common/eventbridge.service";
import { ValidationProblem } from "../common/problem-details.exception";
import type { CheckoutRequest, OrderCreatedEvent } from "@pk-literature/contracts";
import { OrdersService } from "../orders/orders.service";

// No dedicated shipping-rate table or logic exists anywhere in this
// repo yet (SPEC-06 doesn't define one) — a flat rate stands in for
// real shipping-cost calculation, which is out of scope for this
// phase. Disclosed here rather than silently hardcoded with no
// explanation.
//
// Configurable via SHIPPING_COST (plain number, in the order's own
// currency — same one-value-per-deployment shape as FEATURE_PAY_LATER)
// because the flat rate itself differs by storefront: puthagakadai.com
// defaults to 50 (INR), puthagakadai.sg's Terraform overrides this to
// "3" (SGD).
const FLAT_SHIPPING_COST = Number(process.env.SHIPPING_COST ?? "50");

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly cart: CartService,
    private readonly orders: OrdersService,
    private readonly events: EventBridgeService,
  ) {}

  async checkout(anonymousId: string | undefined, request: CheckoutRequest): Promise<Order> {
    const { cartId, items } = await this.cart.getActiveCartForCheckout(anonymousId);
    if (items.length === 0) {
      throw new ValidationProblem("Cart is empty.");
    }

    await this.validateInventory(items);

    const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const total = subtotal + FLAT_SHIPPING_COST;
    const currency = items[0]!.currency;

    const shippingAddressId = await this.insertAddress(request.shippingAddress);
    const billingAddressId = request.billingAddress ? await this.insertAddress(request.billingAddress) : shippingAddressId;

    const orderId = await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .insertInto("commerce.orders")
        .values({
          orderNumber: generateOrderNumber(),
          cartId,
          // SPEC-06's Order Lifecycle starts at Draft -> Pending
          // Payment; this API creates the order already in
          // pending_payment rather than persisting a separate Draft
          // row first — the Checkout Flow diagram goes straight from
          // "Review Cart"/"Shipping Address" to "Create Razorpay
          // Order", with nothing in between that a persisted Draft
          // state would represent. Draft stays a valid, reachable
          // status (e.g. for a future "save cart as draft order"
          // feature) — just not one this endpoint produces.
          status: "pending_payment",
          channel: "online",
          subtotal: String(subtotal),
          shippingCost: String(FLAT_SHIPPING_COST),
          total: String(total),
          currency,
          shippingAddressId,
          billingAddressId,
          contactEmail: request.contactEmail,
          contactPhone: request.contactPhone,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("commerce.orderItems")
        .values(
          items.map((item) => ({
            orderId: order.id,
            bookId: item.bookId,
            titleSnapshot: item.titleSnapshot,
            unitPrice: String(item.unitPrice),
            currency: item.currency,
            quantity: item.quantity,
          })),
        )
        .execute();

      await trx.updateTable("commerce.cart").set({ status: "converted" }).where("id", "=", cartId).execute();

      return order.id;
    });

    const event: OrderCreatedEvent = { orderId, customerId: null, total };
    await this.events.publish("OrderCreated", event);

    return this.orders.getById(orderId);
  }

  private async validateInventory(
    items: { bookId: string; titleSnapshot: string; quantity: number }[],
  ): Promise<void> {
    const bookIds = items.map((i) => i.bookId);
    const inventoryRows = await this.db
      .selectFrom("catalog.inventory")
      .select(["bookId", "stock", "availability"])
      .where("bookId", "in", bookIds)
      .execute();
    const byBookId = new Map(inventoryRows.map((r) => [r.bookId, r]));

    for (const item of items) {
      const inventory = byBookId.get(item.bookId);
      if (!inventory || inventory.availability !== "in_stock" || inventory.stock < item.quantity) {
        throw new ValidationProblem(
          `"${item.titleSnapshot}" is no longer available in the requested quantity.`,
        );
      }
    }
  }

  private async insertAddress(address: Address): Promise<string> {
    const row = await this.db
      .insertInto("commerce.addresses")
      .values({
        recipientName: address.recipientName,
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
        phone: address.phone,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

function generateOrderNumber(): string {
  return `ORD-${randomBytes(4).toString("hex").toUpperCase()}`;
}
