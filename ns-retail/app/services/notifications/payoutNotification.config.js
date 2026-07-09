import { readEnv } from "../../utils/env.utils";

// Config for the Commission Payout Processed practitioner email
// (see payoutNotification.service.js).
export const payoutNotificationConfig = {
  // CC'd on every payout-processed email — mirrors the wholesale workspace's
  // CRON_ADMIN_EMAIL convention (one env knob for "where admin notifications go").
  adminEmail: readEnv("CDO_ADMIN_EMAIL", { fallback: "laviva2883@acoxs.com" }),
};
