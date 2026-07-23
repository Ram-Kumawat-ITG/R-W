/* eslint-disable react/prop-types */
// Shared "Migrated" provenance UI for the CDO Program tabs. A record is
// "migrated" when it was created by a bulk data import (e.g. GoAffPro) rather
// than the live pipeline / portal — see cdo_* models' `migrationSource` field.
//
// - <MigratedBadge migrated={row.migrated} /> renders a small badge next to a
//   row's status (returns null for organic records so it's safe to always
//   include).
// - MIGRATED_FILTER is a ready-made DataTable `filters` entry giving an
//   "All / Migrated only / Exclude migrated" dropdown. It reads the row's
//   boolean `migrated` field (added by the list services).

export function MigratedBadge({ migrated }) {
  if (!migrated) return null;
  return <s-badge tone="info">Migrated</s-badge>;
}

export const MIGRATED_FILTER = {
  key: "migrated",
  label: "Source",
  options: [
    { label: "All records", value: "" },
    { label: "Migrated only", value: "migrated" },
    { label: "Exclude migrated", value: "organic" },
  ],
  predicate: (row, value) =>
    value === "migrated" ? row.migrated === true : row.migrated !== true,
};
