import type { ColumnType, Generated } from "kysely";
import type { MediaAssetType } from "@pk-literature/domain-types";

// Hand-written against plan/database/ddl/commerce.sql (read/write)
// plus the subset of catalog.sql this service reads (never writes —
// commerce_api_rw is read-only on catalog, migration
// 20260401000003_commerce_api_role.sql). Same CamelCasePlugin
// convention as every other service.

export type CartStatus = "active" | "merged" | "converted" | "abandoned";
export type OrderStatus =
  | "draft"
  | "pending_payment"
  | "paid"
  | "packed"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "refunded"
  | "returned";
export type OrderChannel = "online" | "store_erode" | "store_perundurai";
export type PaymentStatus = "created" | "captured" | "failed" | "refunded";
export type ShipmentStatus = "pending" | "shipped" | "delivered";
export type RefundStatus = "initiated" | "processed" | "failed";

export interface CustomerTable {
  id: Generated<string>;
  email: string | null;
  phone: string | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface AddressTable {
  id: Generated<string>;
  customerId: string | null;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface CartTable {
  id: Generated<string>;
  anonymousId: string | null;
  customerId: string | null;
  status: CartStatus;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface CartItemTable {
  id: Generated<string>;
  cartId: string;
  bookId: string;
  titleSnapshot: string;
  unitPrice: string; // numeric(10,2) — returned as string, same reasoning as every other money column in this repo
  currency: string;
  quantity: number;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface OrderTable {
  id: Generated<string>;
  orderNumber: string;
  customerId: string | null;
  cartId: string | null;
  status: OrderStatus;
  channel: Generated<OrderChannel>;
  subtotal: string;
  shippingCost: string;
  total: string;
  currency: string;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface OrderItemTable {
  id: Generated<string>;
  orderId: string;
  bookId: string;
  titleSnapshot: string;
  unitPrice: string;
  currency: string;
  quantity: number;
}

export interface PaymentTable {
  id: Generated<string>;
  orderId: string;
  provider: string;
  razorpayOrderId: string | null; // NULL for provider='pay_later' - see migration 20260401000009
  razorpayPaymentId: string | null;
  razorpaySignature: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface ShipmentTable {
  id: Generated<string>;
  orderId: string;
  carrier: string | null;
  trackingNumber: string | null;
  status: ShipmentStatus;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface RefundTable {
  id: Generated<string>;
  orderId: string;
  paymentId: string;
  razorpayRefundId: string | null;
  amount: string;
  reason: string | null;
  status: RefundStatus;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

// --- catalog read model — only what checkout/cart display need ---

export interface CatalogBookTable {
  id: string;
  title: string;
  status: string;
  coverAssetId: string | null;
}

export interface CatalogMediaAssetTable {
  id: string;
  assetType: MediaAssetType;
  s3Key: string;
  widthPx: number | null;
  heightPx: number | null;
}

export interface CatalogInventoryTable {
  bookId: string;
  stock: number;
  price: string;
  currency: string;
  availability: string;
}

export interface Database {
  "commerce.customers": CustomerTable;
  "commerce.addresses": AddressTable;
  "commerce.cart": CartTable;
  "commerce.cartItems": CartItemTable;
  "commerce.orders": OrderTable;
  "commerce.orderItems": OrderItemTable;
  "commerce.payments": PaymentTable;
  "commerce.shipments": ShipmentTable;
  "commerce.refunds": RefundTable;
  "catalog.books": CatalogBookTable;
  "catalog.mediaAssets": CatalogMediaAssetTable;
  "catalog.inventory": CatalogInventoryTable;
}
