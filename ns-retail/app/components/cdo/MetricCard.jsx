// A single dashboard KPI tile. `value` is pre-formatted by the caller.
// Toned cards (success / critical / warning) get a matching accent bar at top.

const ACCENT = {
  success: "#00a47c",
  critical: "#d72c0d",
  warning: "#b98900",
  info: "#006fbb",
};

// eslint-disable-next-line react/prop-types
export default function MetricCard({ label, value, sublabel, tone }) {
  const accent = tone ? ACCENT[tone] : null;
  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e1e3e5",
      borderRadius: "8px",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      height: "100%",
    }}>
      {accent && <div style={{ height: "3px", background: accent, flexShrink: 0 }} />}
      <div style={{ padding: "16px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
        <s-text tone="subdued">{label}</s-text>
        <s-text variant="headingLg" tone={tone}>{value}</s-text>
        {sublabel ? <s-text tone="subdued">{sublabel}</s-text> : null}
      </div>
    </div>
  );
}
