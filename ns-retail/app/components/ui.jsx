import { useState } from "react";

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
