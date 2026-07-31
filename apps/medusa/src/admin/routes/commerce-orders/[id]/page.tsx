import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  channel: string;
  subtotal: string;
  shippingCost: string;
  total: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  items: { id: string; titleSnapshot: string; unitPrice: string; currency: string; quantity: number }[];
  shippingAddress: Address | null;
  billingAddress: Address | null;
  payments: { id: string; provider: string; razorpayOrderId: string; razorpayPaymentId: string | null; amount: string; currency: string; status: string; createdAt: string }[];
  shipments: { id: string; carrier: string | null; trackingNumber: string | null; status: string; shippedAt: string | null; createdAt: string }[];
  refunds: { id: string; amount: string; reason: string | null; status: string; createdAt: string }[];
}

interface Address {
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  online: "Online",
  store_erode: "Erode",
  store_perundurai: "Perundurai",
};

const STATUS_OPTIONS = [
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

function AddressBlock({ label, address }: { label: string; address: Address | null }) {
  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <h3 style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>{label}</h3>
      {address ? (
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {address.recipientName}
          <br />
          {address.line1}
          {address.line2 ? <>, {address.line2}</> : null}
          <br />
          {address.city}, {address.state} {address.postalCode}
          <br />
          {address.country} · {address.phone}
        </p>
      ) : (
        <p style={{ color: "#999" }}>—</p>
      )}
    </div>
  );
}

function CommerceOrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [statusChoice, setStatusChoice] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");

  function reload() {
    if (!id) return;
    setError(null);
    fetch(`/admin/commerce-orders/${id}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data) => {
        setOrder(data.order);
        setStatusChoice(data.order.status);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load order."));
  }

  useEffect(reload, [id]);

  async function updateStatus() {
    if (!id) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/admin/commerce-orders/${id}/status`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: statusChoice }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `${res.status}`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status.");
    } finally {
      setPending(false);
    }
  }

  async function addShipment() {
    if (!id) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/admin/commerce-orders/${id}/shipments`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrier: carrier || undefined, trackingNumber: trackingNumber || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `${res.status}`);
      setCarrier("");
      setTrackingNumber("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add shipment.");
    } finally {
      setPending(false);
    }
  }

  if (error && !order) return <div style={{ padding: 24, color: "#c0392b" }}>{error}</div>;
  if (!order) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Order {order.orderNumber}</h1>
        <p style={{ color: "#666", fontSize: 13 }}>
          {CHANNEL_LABELS[order.channel] ?? order.channel} · {order.contactEmail ?? "—"} · {order.contactPhone ?? "—"} ·
          placed {new Date(order.createdAt).toLocaleString()}
        </p>
      </div>

      {error && <p style={{ color: "#c0392b" }}>{error}</p>}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <AddressBlock label="Shipping address" address={order.shippingAddress} />
        <AddressBlock label="Billing address" address={order.billingAddress} />
      </div>

      <div>
        <h3 style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Items</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>Title</th>
              <th style={{ padding: 8 }}>Qty</th>
              <th style={{ padding: 8 }}>Unit price</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>{item.titleSnapshot}</td>
                <td style={{ padding: 8 }}>{item.quantity}</td>
                <td style={{ padding: 8 }}>
                  {item.currency} {Number(item.unitPrice).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ padding: 8 }} colSpan={2} />
              <td style={{ padding: 8, fontWeight: 600 }}>
                Subtotal {order.currency} {Number(order.subtotal).toFixed(2)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: 8 }} colSpan={2} />
              <td style={{ padding: 8 }}>
                Shipping {order.currency} {Number(order.shippingCost).toFixed(2)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: 8 }} colSpan={2} />
              <td style={{ padding: 8, fontWeight: 700 }}>
                Total {order.currency} {Number(order.total).toFixed(2)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 13, color: "#666" }}>Status:</label>
        <select value={statusChoice} onChange={(e) => setStatusChoice(e.target.value)} style={{ padding: "6px 8px" }}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button disabled={pending || statusChoice === order.status} onClick={updateStatus}>
          Update status
        </button>
      </div>

      <div>
        <h3 style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Payments</h3>
        {order.payments.length === 0 && <p style={{ color: "#999" }}>No payment records yet.</p>}
        {order.payments.map((p) => (
          <p key={p.id} style={{ margin: "4px 0", fontSize: 14 }}>
            {p.provider} · {p.status} · {p.currency} {Number(p.amount).toFixed(2)} · razorpay order {p.razorpayOrderId}
            {p.razorpayPaymentId ? ` · payment ${p.razorpayPaymentId}` : ""}
          </p>
        ))}
      </div>

      <div>
        <h3 style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Shipments</h3>
        {order.shipments.map((s) => (
          <p key={s.id} style={{ margin: "4px 0", fontSize: 14 }}>
            {s.status} · {s.carrier ?? "no carrier"} · {s.trackingNumber ?? "no tracking #"} ·{" "}
            {s.shippedAt ? new Date(s.shippedAt).toLocaleString() : "not shipped"}
          </p>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Carrier"
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            style={{ padding: "6px 8px" }}
          />
          <input
            type="text"
            placeholder="Tracking number"
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            style={{ padding: "6px 8px" }}
          />
          <button disabled={pending} onClick={addShipment}>
            Mark shipped
          </button>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Refunds</h3>
        {order.refunds.length === 0 && <p style={{ color: "#999" }}>No refunds.</p>}
        {order.refunds.map((r) => (
          <p key={r.id} style={{ margin: "4px 0", fontSize: 14 }}>
            {r.status} · {order.currency} {Number(r.amount).toFixed(2)} · {r.reason ?? "no reason given"} ·{" "}
            {new Date(r.createdAt).toLocaleString()}
          </p>
        ))}
        <p style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
          Initiating a new refund isn't wired up yet — no code in this repo calls Razorpay's refund API today.
        </p>
      </div>
    </div>
  );
}

export default CommerceOrderDetailPage;
