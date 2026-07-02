// Dashboard KPI tile. `value` is pre-formatted by the caller.

const TONE_CONFIG = {
  success: { accent: "#00a47c", bg: "#f1faf7", valueColor: "#007a5a" },
  critical: { accent: "#d72c0d", bg: "#fff4f4", valueColor: "#c0280c" },
  warning:  { accent: "#b98900", bg: "#fdf9ed", valueColor: "#916800" },
  info:     { accent: "#006fbb", bg: "#f4f9ff", valueColor: "#00519e" },
};

// eslint-disable-next-line react/prop-types
export default function MetricCard({ label, value, sublabel, tone, icon }) {
  const config = tone ? TONE_CONFIG[tone] : null;

  return (
    <div
      style={{
        background: config ? config.bg : "#fff",
        border: `1px solid ${config ? config.accent + "50" : "#e1e3e5"}`,
        borderTop: `3px solid ${config ? config.accent : "#d0d5da"}`,
        borderRadius: "8px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = "0 3px 10px rgba(0,0,0,0.09)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.05)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: "3px" }}>
        {/* Label + icon row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "4px" }}>
          <span style={{
            fontSize: "12px",
            fontWeight: 500,
            color: "#6d7175",
            lineHeight: "16px",
          }}>
            {label}
          </span>
          {icon && (
            <span style={{ fontSize: "14px", opacity: 0.45, lineHeight: 1, flexShrink: 0 }}>
              {icon}
            </span>
          )}
        </div>

        {/* Value */}
        <div style={{
          fontSize: "24px",
          fontWeight: 700,
          color: config ? config.valueColor : "#202223",
          lineHeight: "30px",
          letterSpacing: "-0.3px",
        }}>
          {value}
        </div>

        {/* Sublabel */}
        {sublabel && (
          <div style={{
            fontSize: "11px",
            color: config ? config.valueColor + "99" : "#8c9196",
            lineHeight: "14px",
          }}>
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}
