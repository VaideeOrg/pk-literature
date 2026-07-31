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
  channel: string;
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

const CHANNEL_LABELS: Record<string, string> = {
  online: "Online",
  store_erode: "Erode",
  store_perundurai: "Perundurai",
};

const CHANNEL_FILTER_OPTIONS = ["", "online", "store_erode", "store_perundurai"];

interface CatalogBook {
  id: string;
  title: string;
  isbn13: string | null;
  price: string | null;
  currency: string | null;
  stock: number | null;
}

interface DraftItem {
  bookId: string;
  titleSnapshot: string;
  unitPrice: number;
  currency: string;
  quantity: number;
}

const STORE_CHANNELS = [
  { value: "store_erode", label: "Erode" },
  { value: "store_perundurai", label: "Perundurai" },
];

function LogWalkInSaleForm({ onDone }: { onDone: () => void }) {
  const [channel, setChannel] = useState(STORE_CHANNELS[0]!.value);
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [bookQuery, setBookQuery] = useState("");
  const [bookResults, setBookResults] = useState<CatalogBook[]>([]);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookQuery) {
      setBookResults([]);
      return;
    }
    const handle = setTimeout(() => {
      fetch(`/admin/catalog-books?q=${encodeURIComponent(bookQuery)}`, { credentials: "include" })
        .then((res) => res.json())
        .then((data) => setBookResults(data.books))
        .catch(() => setBookResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [bookQuery]);

  function addItem(book: CatalogBook) {
    setBookQuery("");
    setBookResults([]);
    setItems((prev) => {
      const existing = prev.find((i) => i.bookId === book.id);
      if (existing) {
        return prev.map((i) => (i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
      }
      return [
        ...prev,
        {
          bookId: book.id,
          titleSnapshot: book.title,
          unitPrice: book.price ? Number(book.price) : 0,
          currency: book.currency ?? "INR",
          quantity: 1,
        },
      ];
    });
  }

  function updateItem(bookId: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((i) => (i.bookId === bookId ? { ...i, ...patch } : i)));
  }

  function removeItem(bookId: string) {
    setItems((prev) => prev.filter((i) => i.bookId !== bookId));
  }

  async function submit() {
    if (items.length === 0) {
      setError("Add at least one book.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/admin/commerce-orders", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel,
          contactEmail: contactEmail || undefined,
          contactPhone: contactPhone || undefined,
          items,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `${res.status}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log sale.");
    } finally {
      setPending(false);
    }
  }

  const total = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 4, padding: 16, marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Log walk-in sale</h2>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ padding: "6px 8px" }}>
          {STORE_CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="email"
          placeholder="Customer email (optional)"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          style={{ padding: "6px 8px" }}
        />
        <input
          type="text"
          placeholder="Customer phone (optional)"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          style={{ padding: "6px 8px" }}
        />
      </div>

      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search books by title or ISBN..."
          value={bookQuery}
          onChange={(e) => setBookQuery(e.target.value)}
          style={{ padding: "6px 8px", width: "100%", maxWidth: 400 }}
        />
        {bookResults.length > 0 && (
          <div
            style={{
              position: "absolute",
              zIndex: 10,
              background: "white",
              border: "1px solid #ddd",
              width: "100%",
              maxWidth: 400,
            }}
          >
            {bookResults.map((b) => (
              <div
                key={b.id}
                onClick={() => addItem(b)}
                style={{ padding: 8, cursor: "pointer", borderBottom: "1px solid #eee" }}
              >
                {b.title} {b.isbn13 ? `(${b.isbn13})` : ""} — {b.currency ?? "INR"} {b.price ?? "no price"}
                {b.stock != null ? `, stock ${b.stock}` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {items.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, marginBottom: 12 }}>
          <tbody>
            {items.map((item) => (
              <tr key={item.bookId} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 6 }}>{item.titleSnapshot}</td>
                <td style={{ padding: 6, width: 80 }}>
                  <input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) => updateItem(item.bookId, { quantity: Math.max(1, Number(e.target.value)) })}
                    style={{ width: 60, padding: 4 }}
                  />
                </td>
                <td style={{ padding: 6, width: 120 }}>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.bookId, { unitPrice: Number(e.target.value) })}
                    style={{ width: 90, padding: 4 }}
                  />
                </td>
                <td style={{ padding: 6 }}>
                  <button onClick={() => removeItem(item.bookId)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p style={{ color: "#c0392b" }}>{error}</p>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>Total: {items[0]?.currency ?? "INR"} {total.toFixed(2)}</span>
        <button disabled={pending} onClick={submit}>
          {pending ? "Saving..." : "Log sale"}
        </button>
      </div>
    </div>
  );
}

function CommerceOrdersPage() {
  const [orders, setOrders] = useState<OrderListRow[]>([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set("status", status);
    if (channel) params.set("channel", channel);
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
  }, [offset, status, channel, q, refreshKey]);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Store Orders</h1>
      <p style={{ color: "#666", marginBottom: 16, fontSize: 13 }}>
        Real orders from the storefront checkout and the two physical stores (commerce.orders) - separate from
        Medusa's own built-in Orders section.
      </p>

      <button onClick={() => setShowForm((v) => !v)} style={{ marginBottom: 16 }}>
        {showForm ? "Cancel" : "+ Log walk-in sale"}
      </button>

      {showForm && (
        <LogWalkInSaleForm
          onDone={() => {
            setShowForm(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

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
        <select
          value={channel}
          onChange={(e) => {
            setOffset(0);
            setChannel(e.target.value);
          }}
          style={{ padding: "6px 8px" }}
        >
          {CHANNEL_FILTER_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c ? CHANNEL_LABELS[c] : "All channels"}
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
                <th style={{ padding: 8 }}>Channel</th>
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
                  <td style={{ padding: 8 }}>{CHANNEL_LABELS[o.channel] ?? o.channel}</td>
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
                  <td colSpan={7} style={{ padding: 16, textAlign: "center", color: "#666" }}>
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
