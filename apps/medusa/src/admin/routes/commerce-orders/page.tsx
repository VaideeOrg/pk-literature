import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { defineRouteConfig } from "@medusajs/admin-sdk";

// Custom admin page reading apps/api-commerce's real commerce.orders
// directly (via src/api/admin/commerce-orders/**), not Medusa's own
// built-in Order module - see ../../../README.md's scope-boundary
// section. Deliberately plain HTML/inline styles rather than
// @medusajs/ui components: this repo has never independently verified
// @medusajs/ui's exact component API against a live build (unlike
// admin-sdk's defineRouteConfig, confirmed straight from node_modules'
// own .d.ts), and getting the page working correctly matters more here
// than matching Medusa's native visual polish exactly.
//
// react-router-dom is pinned in package.json to the exact version
// @medusajs/dashboard itself depends on (6.30.4) - Medusa's admin
// shell provides the Router context this page's <Link>/useParams rely
// on, and a mismatched react-router-dom version would resolve to a
// second, disconnected React context instead of hooking into it.

interface OrderListRow {
  id: string;
  orderNumber: string;
  status: string;
  total: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  itemCount: number;
  createdAt: string;
}

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  "",
  "draft",
  "pending_payment",
  "paid",
  "packed",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "refunded",
  "returned",
];

function CommerceOrdersPage() {
  const [orders, setOrders] = useState<OrderListRow[]>([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set("status", status);
    if (q) params.set("q", q);

    fetch(`/admin/commerce-orders?${params.toString()}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data) => {
        setOrders(data.orders);
        setCount(data.count);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders."))
      .finally(() => setLoading(false));
  }, [offset, status, q]);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Store Orders</h1>
      <p style={{ color: "#666", marginBottom: 16, fontSize: 13 }}>
        Real orders from the storefront checkout (commerce.orders) - separate from Medusa's own built-in Orders
        section.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
          style={{ padding: "6px 8px" }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s || "All statuses"}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search order # or email"
          value={q}
          onChange={(e) => {
            setOffset(0);
            setQ(e.target.value);
          }}
          style={{ padding: "6px 8px", flex: 1, maxWidth: 320 }}
        />
      </div>

      {error && <p style={{ color: "#c0392b" }}>{error}</p>}
      {loading && <p>Loading...</p>}

      {!loading && !error && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: 8 }}>Order #</th>
                <th style={{ padding: 8 }}>Contact</th>
                <th style={{ padding: 8 }}>Items</th>
                <th style={{ padding: 8 }}>Total</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 8 }}>
                    <Link to={`/commerce-orders/${o.id}`}>{o.orderNumber}</Link>
                  </td>
                  <td style={{ padding: 8 }}>{o.contactEmail ?? o.contactPhone ?? "—"}</td>
                  <td style={{ padding: 8 }}>{o.itemCount}</td>
                  <td style={{ padding: 8 }}>
                    {o.currency} {Number(o.total).toFixed(2)}
                  </td>
                  <td style={{ padding: 8 }}>{o.status}</td>
                  <td style={{ padding: 8 }}>{new Date(o.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 16, textAlign: "center", color: "#666" }}>
                    No orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
            <span>
              {count === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, count)} of {count}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </button>
              <button disabled={offset + PAGE_SIZE >= count} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export const config = defineRouteConfig({
  label: "Store Orders",
});

export default CommerceOrdersPage;
