# Natural Solutions Wholesale — Email Notifications

A client-facing catalog of **every automated email the wholesale platform sends**, grouped by who receives it and how it's delivered. Each entry lists what triggers the email, the recipient, and the subject line as it appears in the inbox.

| | Count |
|---|---|
| **Total email types** | 26 |
| Practitioner-facing | 18 |
| Admin / internal | 8 |
| Delivery channels | 2 |

**Delivery channels**

- **Mail** — delivered through our mail server (SMTP): application, account, payment, referral, and all admin alerts.
- **QuickBooks** — invoices and payment reminders, rendered and sent by QuickBooks (our system controls the timing; QuickBooks owns the layout/subject).

**Recipients**

- **Practitioner / Applicant** — the wholesale customer. Most of these also **CC your admin address**.
- **Admin** — your team only; never sent to practitioners.

---

## 1. Account & application emails

Lifecycle of a wholesale account — from application to approval, changes, and access. Sent to the practitioner; the admin address is copied (CC) on each.

| # | Notification | When it's sent | Recipient | Subject line | Channel |
|---|---|---|---|---|---|
| 1 | Application received | A practitioner submits the wholesale registration form | Applicant · CC Admin | `We received your Wholesale Application` | Mail |
| 2 | Application approved | Your team approves the application | Practitioner · CC Admin | `Your Wholesale Account Has Been Approved` | Mail |
| 3 | Application declined | Your team declines the application (includes the reason) | Applicant · CC Admin | `We Could Not Complete Your Wholesale Application` | Mail |
| 4 | Account access revoked | An admin blocks / revokes the account | Practitioner · CC Admin | `Your Wholesale Account Access Has Been Revoked` | Mail |
| 5 | Account information updated | Profile or payment details are changed (by the practitioner or an admin) | Practitioner · CC Admin | `Your Wholesale Account Information Was Updated` | Mail |
| 6 | Referral code ready | A practitioner referral / discount code is created | Practitioner · CC Admin | `Your Referral Code "…" Is Ready` | Mail |
| 7 | Referral code paused / resumed | A referral code is paused or later re-activated | Practitioner · CC Admin | `Your Referral Code "…" Has Been Paused` / `… Resumed` | Mail |

---

## 2. Payment & order-block emails

Alerts a practitioner receives when a payment does not go through. The admin address is copied (CC) on each.

| # | Notification | When it's sent | Recipient | Subject line | Channel |
|---|---|---|---|---|---|
| 8 | Payment failed | An automatic charge on an invoice is declined or fails (card or ACH) | Practitioner · CC Admin | `Payment Failed for Order … — Action Required` | Mail |
| 9 | New orders temporarily blocked **(new)** | All card retry attempts on an invoice are exhausted, so new orders are blocked until it's paid. Includes invoice number, order number, outstanding amount, due date, last failed-payment date, and retry count | Practitioner · CC Admin | `Action Required: New Orders Temporarily Blocked — Invoice …` | Mail |

---

## 3. Invoice & payment-reminder emails

Invoices (#10–13) are delivered directly by **QuickBooks** — subject lines and layout follow the QuickBooks invoice template; our system controls the timing. Payment reminders (#14–17) are delivered via our **mail server (SMTP)** using dynamic, per-stage templates that include full order and invoice details (practitioner, order number, invoice number, invoice date, payment status, due date, outstanding amount, and a product summary).

| # | Notification | When it's sent | Recipient | Details |
|---|---|---|---|---|
| 10 | Invoice issued | An order's invoice is created | Practitioner | The initial invoice with the amount due |
| 11 | Updated invoice after payment | A payment is recorded against the invoice | Practitioner | Re-sent showing the new balance / paid status |
| 12 | Updated invoice after shipment | The order ships and tracking is added | Practitioner | Re-sent with ship date + tracking number |
| 13 | Invoice re-sent (manual) | An admin clicks "Send invoice" on the order | Practitioner | On-demand copy of the current invoice |
| 14 | 1st payment reminder | ~Day 9 — a cheque invoice is still unpaid | Practitioner | First gentle reminder to pay |
| 15 | 2nd payment reminder | ~Day 11 — still unpaid | Practitioner | Second reminder to pay |
| 16 | Final card-on-file notice | ~Day 13 — still unpaid | Practitioner | Final notice that the card on file may be charged |
| 17 | Recurring reminder | After the final notice — repeats every couple of days until paid | Practitioner | Keeps reminding until the balance clears |

> Reminder timing (Day 9 / 11 / 13) is configurable and applies to unpaid **cheque** invoices. Card and ACH invoices are auto-charged instead of reminded.

---

## 4. Internal admin alerts

Operational alerts sent only to your team — never to practitioners. They flag issues that may need attention in payments, invoicing, or fulfillment.

| # | Notification | When it's sent | Recipient | Subject line | Channel |
|---|---|---|---|---|---|
| 18 | Billing run summary | After each automatic billing run — every time, any outcome | Admin | `[Status] CRON Batch Summary — …` | Mail |
| 19 | Fulfillment sync failed | A drop-ship order's shipment fails to sync to the retail store | Admin | `Drop-ship Fulfillment Sync to Retail Store Failed — Order …` | Mail |
| 20 | Payment method invalid | A stored card/bank record is invalid, so a charge was skipped | Admin | `NMI Vault Invalid — Charge Skipped …` | Mail |
| 21 | Payment setup failed at registration | A new applicant's payment method can't be set up during registration | Admin | `NMI Vault Creation Failed — Registration Rejected` | Mail |
| 22 | Duplicate transaction rejected | The payment gateway rejects a charge as a duplicate | Admin | `NMI Duplicate Transaction Rejected — Invoice …` | Mail |
| 23 | QuickBooks connection failed | The QuickBooks connection expires — invoicing is blocked until reconnected | Admin | `CRITICAL: QuickBooks Token Refresh Failed — Invoicing Blocked` | Mail |
| 24 | Invoice creation failed | An order's invoice can't be created in QuickBooks | Admin | `QBO Invoice Creation Failed — Order …` | Mail |
| 25 | Customer sync failed | A customer record can't be synced to QuickBooks | Admin | `QBO Customer Sync Failed — …` | Mail |

---

## Not included: login codes

One-time passcodes used to sign in to the wholesale store are sent by **Shopify** directly, as part of the storefront login — they are not generated or sent by this system, so they aren't listed above.

---

## Configuration notes (for go-live)

- **Mail server (SMTP):** transactional emails (all "Mail" rows) are delivered through the configured SMTP provider. In staging this currently points at a **sandbox** transport (Ethereal), which captures mail without delivering to real inboxes. Before go-live, point `SMTP_*` at a real transactional provider (e.g. SendGrid, Mailgun, Amazon SES, Postmark).
- **Admin recipient:** internal alerts and the CC on customer emails go to `CRON_ADMIN_EMAIL` — set this to a real monitored admin address.
- **Support address:** the "contact support" line in customer emails uses `PAYMENT_FAILURE_SUPPORT_EMAIL` / `ORDER_BLOCK_SUPPORT_EMAIL` (falls back to a generic phrase if unset).
- **Delivery is durable:** every SMTP email is queued to a background job with automatic retry, so a temporary mail outage never blocks order or payment processing.

*Subject lines shown may include order or invoice numbers filled in at send time.*
