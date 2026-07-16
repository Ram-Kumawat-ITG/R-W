// Display formatters shared across CDO Program tabs. Pure functions —
// safe to import on both the server (loaders) and client (components).

export function formatCurrency(amount, currency = "USD") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatPercent(rate) {
  // Distinguish "unknown" (null/undefined/empty → "—") from a genuine 0% rate.
  // Number(null) and Number("") are both 0 (finite), so without this guard an
  // unknown rate would render as a misleading "0%".
  if (rate == null || rate === "") return "—";
  const n = Number(rate);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 1)}%`;
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
