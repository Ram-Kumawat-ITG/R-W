// A single dashboard KPI tile. `value` is pre-formatted by the caller.

export default function MetricCard({ label, value, sublabel, tone }) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small-200">
        <s-text tone="subdued">{label}</s-text>
        <s-text variant="headingLg" tone={tone}>
          {value}
        </s-text>
        {sublabel ? <s-text tone="subdued">{sublabel}</s-text> : null}
      </s-stack>
    </s-box>
  );
}
