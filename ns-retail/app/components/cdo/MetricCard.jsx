// A single dashboard KPI tile. `value` is pre-formatted by the caller.
// Toned cards get a matching accent bar at the top edge.

const ACCENT = {
  success: "#00a47c",
  critical: "#d72c0d",
  warning: "#b98900",
  info: "#006fbb",
};

const VALUE_COLOR = {
  success: "#00a47c",
  critical: "#d72c0d",
  warning: "#b98900",
  info: "#006fbb",
};

// eslint-disable-next-line react/prop-types
export default function MetricCard({ label, value, sublabel, tone }) {
  const accent = tone ? ACCENT[tone] : null;
  const valueColor = tone ? VALUE_COLOR[tone] : "#202223";
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
      <div style={{
        padding: "16px",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}>
        <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: 400, lineHeight: "20px" }}>
          {label}
        </div>
        <div style={{
          fontSize: "22px",
          fontWeight: 600,
          color: valueColor,
          lineHeight: "28px",
          letterSpacing: "-0.3px",
        }}>
          {value}
        </div>
        {sublabel && (
          <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "16px" }}>
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}
