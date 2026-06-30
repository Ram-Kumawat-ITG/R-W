import { useEffect, useState } from "react";

// Collapsible section wrapper for the retail admin UI.
// Same behavior as wholesale's CollapsibleSection in admin-ui.jsx —
// sessionStorage-backed expand/collapse, defaultOpen for the top section.
export function CollapsibleSection({ heading, children, defaultOpen = false, storageKey }) {
  const key = storageKey ? `cs:${storageKey}` : null;
  const [open, setOpen] = useState(() => {
    if (!key) return defaultOpen;
    try {
      const v = sessionStorage.getItem(key);
      return v !== null ? v === "true" : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (key) try { sessionStorage.setItem(key, String(next)); } catch {}
  };
  return (
    <s-section>
      <s-clickable onClick={toggle}>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text variant="headingMd">{heading}</s-text>
          <s-text tone="subdued">{open ? "▲" : "▼"}</s-text>
        </s-stack>
      </s-clickable>
      {open ? <s-box paddingBlockStart="base">{children}</s-box> : null}
    </s-section>
  );
}

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () =>
      setVisible((window.scrollY || document.documentElement.scrollTop) > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "10px 16px",
        background: "#303030",
        color: "#ffffff",
        border: "none",
        borderRadius: "8px",
        fontSize: "13px",
        fontWeight: "500",
        cursor: "pointer",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        lineHeight: "1",
        userSelect: "none",
      }}
    >
      ↑ Back to top
    </button>
  );
}
