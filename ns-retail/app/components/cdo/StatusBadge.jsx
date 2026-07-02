/* eslint-disable react/prop-types */
// Maps a CDO status string to a Polaris badge tone. Shared by every tab
// so status colours stay consistent across the portal.

const TONE_BY_STATUS = {
  paid: "success",
  approved: "success",
  converted: "success",
  completed: "success",
  pending: "warning",
  processing: "info",
  awaiting_settlement: "info",
  awaiting_approval: "warning",
  running: "info",
  completed_with_errors: "warning",
  paused: "warning",
  skipped: "neutral",
  expired: "neutral",
  reversed: "critical",
  failed: "critical",
  cancelled: "critical",
  rejected: "critical",
};

// Friendlier labels for multi-word statuses (default just capitalizes).
const LABEL_BY_STATUS = {
  completed_with_errors: "Completed with errors",
  awaiting_settlement: "Awaiting settlement",
  awaiting_approval: "Awaiting approval",
};

export default function StatusBadge({ status }) {
  const key = (status || "").toLowerCase();
  const tone = TONE_BY_STATUS[key] || "neutral";
  const label =
    LABEL_BY_STATUS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "—");
  return <s-badge tone={tone}>{label}</s-badge>;
}
