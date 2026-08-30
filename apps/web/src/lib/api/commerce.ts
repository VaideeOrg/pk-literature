import type {
  CheckoutRequest,
  CheckoutResponse,
  CreateCartResponse,
  CreatePaymentOrderResponse,
  GetCartResponse,
  GetOrderResponse,
  ListOrdersResponse,
  PayLaterResponse,
  RemoveCartItemResponse,
  UpsertCartItemRequest,
  UpsertCartItemResponse,
} from "@pk-literature/contracts";
import type { Fetcher } from "./fetcher";
import { toQueryString } from "./fetcher";

export function getOrCreateCart(fetcher: Fetcher): Promise<CreateCartResponse> {
  return fetcher("/v1/cart", { method: "POST" });
}

export function getCart(fetcher: Fetcher): Promise<GetCartResponse> {
  return fetcher("/v1/cart");
}

export function upsertCartItem(fetcher: Fetcher, body: UpsertCartItemRequest): Promise<UpsertCartItemResponse> {
  return fetcher("/v1/cart/items", { method: "PATCH", body: JSON.stringify(body) });
}

export function removeCartItem(fetcher: Fetcher, itemId: string): Promise<RemoveCartItemResponse> {
  return fetcher(`/v1/cart/items/${itemId}`, { method: "DELETE" });
}

export function checkout(fetcher: Fetcher, body: CheckoutRequest): Promise<CheckoutResponse> {
  return fetcher("/v1/checkout", { method: "POST", body: JSON.stringify(body) });
}

export function createPaymentOrder(fetcher: Fetcher, orderId: string): Promise<CreatePaymentOrderResponse> {
  return fetcher("/v1/payments/create-order", { method: "POST", body: JSON.stringify({ orderId }) });
}

export function payLater(fetcher: Fetcher, orderId: string): Promise<PayLaterResponse> {
  return fetcher("/v1/payments/pay-later", { method: "POST", body: JSON.stringify({ orderId }) });
}

export function listOrders(fetcher: Fetcher, page = 1, pageSize = 20): Promise<ListOrdersResponse> {
  return fetcher(`/v1/orders${toQueryString({ page, pageSize })}`);
}

export function getOrder(fetcher: Fetcher, orderId: string): Promise<GetOrderResponse> {
  return fetcher(`/v1/orders/${orderId}`);
}
