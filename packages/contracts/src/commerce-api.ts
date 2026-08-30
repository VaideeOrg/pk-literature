// Request/response shapes for the Commerce API (SPEC-06, SPEC-16). See
// apps/api-commerce. Anonymous-first (SPEC-06 Principles: "Anonymous
// checkout supported") — every route here identifies the caller via
// the same X-Anonymous-Id header convention as apps/api-feed/
// apps/api-search, not a login (SPEC-07/Identity, Phase 7, hasn't
// landed yet).

import type { Address, Cart, Order, OrderSummary } from "@pk-literature/domain-types";
import type { PaginatedResponse, PaginationQuery } from "./pagination";

// POST /cart, GET /cart
export type GetCartResponse = Cart;
export type CreateCartResponse = Cart;

// PATCH /cart/items
export interface UpsertCartItemRequest {
  bookId: string;
  quantity: number;
}
export type UpsertCartItemResponse = Cart;

// DELETE /cart/items/{id}
export type RemoveCartItemResponse = Cart;

// POST /checkout
export interface CheckoutRequest {
  shippingAddress: Address;
  billingAddress?: Address;
  contactEmail: string;
  contactPhone: string;
}
export type CheckoutResponse = Order;

// POST /payments/create-order — enough for the client to open
// Razorpay's own Checkout widget (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/),
// which needs the Razorpay order id, amount, currency, and the
// publishable key id. Never the key *secret* — that never leaves the
// Lambda.
export interface CreatePaymentOrderRequest {
  orderId: string;
}
export interface CreatePaymentOrderResponse {
  razorpayOrderId: string;
  razorpayKeyId: string;
  amount: number;
  currency: string;
}

// POST /payments/pay-later — the zero-gateway alternative to
// /payments/create-order (puthagakadai.sg: no payment gateway
// configured at all). No Razorpay round trip and nothing further for
// the client to do — placing this call is the entire payment step;
// see apps/api-commerce/src/payments/payments.service.ts's payLater()
// for what happens server-side. Feature-gated by FEATURE_PAY_LATER,
// off by default (puthagakadai.com), on by default (puthagakadai.sg).
export interface PayLaterRequest {
  orderId: string;
}
export interface PayLaterResponse {
  orderId: string;
  provider: "pay_later";
}

// POST /payments/webhook — Razorpay's own payload shape (not ours to
// define; apps/api-commerce/src/payments/razorpay-webhook.dto.ts
// types only the fields it actually reads), verified via the
// X-Razorpay-Signature header before anything in the body is trusted
// (SPEC-06: "Webhook verification is mandatory before marking an
// order Paid").
export interface WebhookAck {
  received: true;
}

// GET /orders
export type ListOrdersQuery = PaginationQuery;
export type ListOrdersResponse = PaginatedResponse<OrderSummary>;

// GET /orders/{id}
export type GetOrderResponse = Order;
