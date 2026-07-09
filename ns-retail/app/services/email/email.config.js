// SMTP configuration for the shared email utility (services/email/email.service.js).
// No other module should read process.env.SMTP_* / EMAIL_* directly.
// (Mirrors the wholesale workspace's services/email/email.config.js.)

import { readEnv, readInt, readBool } from "../../utils/env.utils";

export const emailConfig = {
  host: readEnv("SMTP_HOST"),
  port: readInt("SMTP_PORT", 587),
  secure: readBool("SMTP_SECURE", false), // true for port 465, false for 587/25 (STARTTLS)
  user: readEnv("SMTP_USER"),
  password: readEnv("SMTP_PASSWORD"),
  fromName: readEnv("SMTP_FROM_NAME", { fallback: "Natural Solutions" }),
  fromEmail: readEnv("SMTP_FROM_EMAIL"),
  replyTo: readEnv("SMTP_REPLY_TO"),
};

export function assertEmailConfigured() {
  const missing = ["host", "user", "password", "fromEmail"].filter((key) => !emailConfig[key]);
  if (missing.length > 0) {
    throw new Error(`Email service misconfigured — missing SMTP env var(s): ${missing.join(", ")}`);
  }
}
