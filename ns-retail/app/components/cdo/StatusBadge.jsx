// Maps a CDO status string to a Polaris badge tone. Shared by every tab
// so status colours stay consistent across the portal.

const TONE_BY_STATUS = {
  paid: "success",
  approved: "success",
  converted: "success",
  pending: "warning",
  processing: "info",
  expired: "neutral",
  reversed: "critical",
  failed: "critical",
  cancelled: "critical",
};

export default function StatusBadge({ status }) {
  const key = (status || "").toLowerCase();
  const tone = TONE_BY_STATUS[key] || "neutral";
  const label = key ? key.charAt(0).toUpperCase() + key.slice(1) : "—";
  return <s-badge tone={tone}>{label}</s-badge>;
}
