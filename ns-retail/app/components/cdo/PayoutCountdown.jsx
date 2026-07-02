/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { formatDateTime } from "../../utils/format";

// Injected once per document — keyed to avoid double-injection on HMR.
const STYLE_ID = "cdo-countdown-styles";
const CSS = `
  @keyframes cdo-tick {
    0%   { opacity: 0;   transform: translateY(7px) scale(0.88); }
    60%  { opacity: 1;   transform: translateY(-2px) scale(1.04); }
    100% { opacity: 1;   transform: translateY(0)  scale(1);    }
  }
  .cdo-countdown-digit {
    display         : inline-block;
    animation       : cdo-tick 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
    will-change     : transform, opacity;
  }
`;

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function calcTimeLeft(targetIso) {
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days:    Math.floor(diff / 86_400_000),
    hours:   Math.floor((diff % 86_400_000) / 3_600_000),
    minutes: Math.floor((diff % 3_600_000)  / 60_000),
    seconds: Math.floor((diff % 60_000)     / 1_000),
  };
}

function CountdownUnit({ value, label }) {
  const formatted = String(value).padStart(2, "0");
  return (
    <s-box
      padding="base"
      border-color="border"
      border-width="base"
      border-radius="base"
      min-inline-size="80px"
    >
      <s-stack direction="block" gap="none" alignItems="center">
        <s-text variant="headingLg">
          {/* key=formatted re-mounts the span on every value change,
              re-triggering the CSS animation from the start */}
          <span key={formatted} className="cdo-countdown-digit">
            {formatted}
          </span>
        </s-text>
        <s-text tone="subdued">{label}</s-text>
      </s-stack>
    </s-box>
  );
}

export default function PayoutCountdown({ payoutRunAt }) {
  const [timeLeft, setTimeLeft] = useState(null);

  useEffect(() => {
    injectStyles();
    const tick = () => setTimeLeft(calcTimeLeft(payoutRunAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [payoutRunAt]);

  if (!timeLeft) return null;

  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="inline" gap="small-200" wrap>
        <CountdownUnit value={timeLeft.days}    label="Days"    />
        <CountdownUnit value={timeLeft.hours}   label="Hours"   />
        <CountdownUnit value={timeLeft.minutes} label="Minutes" />
        <CountdownUnit value={timeLeft.seconds} label="Seconds" />
      </s-stack>
      <s-text tone="subdued">
        Next payout run: {formatDateTime(payoutRunAt)}
      </s-text>
    </s-stack>
  );
}
