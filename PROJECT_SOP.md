# Natural Solutions — Project SOP (Standard Operating Procedure)

**Purpose.** A single, client-friendly walkthrough of how the Natural Solutions platform works end‑to‑end — registration, ordering, payments, commissions, payouts, fulfillment, and the day‑to‑day controls the Admin has. It connects every moving part so the whole workflow can be understood without reading code.

**Last reviewed:** 2026‑06‑22

---

## 1. The platform at a glance

Natural Solutions runs **two Shopify stores** that work together, plus a set of back‑office integrations.

| Store | Who buys here | What it represents |
|---|---|---|
| **Retail store** (`naturalsolutionsphc.com`) | Patients / end customers (often referred by a practitioner) | Customer‑facing storefront. Sells at **retail price**. |
| **Wholesale store** | Practitioners buying for their practice **and** the system itself (for dropship — see §3) | Practitioner‑facing storefront. Sells at **wholesale price**. |

There are **three kinds of users**:

- **Customer / Patient** — buys on the Retail store; may be linked to a Practitioner via a referral code.
- **Practitioner** — a healthcare professional who (a) earns commissions on patient orders, and/or (b) buys wholesale for their own practice. Has a self‑service **Practitioner Portal**.
- **Admin** — Natural Solutions staff who oversee orders, payments, payouts, fulfillment, and all the controls.

### Integrations (the back office)

| System | Role |
|---|---|
| **Shopify** (×2 stores) | Storefronts, checkout, customers, orders, fulfilment/tracking, discount codes. |
| **QuickBooks Online (QBO)** | Accounting. **Three independent ledgers run in parallel** — see §9. Records invoices (money in), vendor bills (money out), and payments. |
| **NMI** | Credit‑card processing + secure card vault (used by the Wholesale payment flows and the dropship card‑on‑file charge). |
| **Dwolla** | ACH bank‑to‑bank rail used to actually **pay commission money** to practitioners. |
| **Carrier APIs** (USPS live; UPS/FedEx/DHL planned) | Live shipping rates at checkout; shipping labels for fulfillment. |

> **One platform, two flows.** Everything below splits into two business flows that share these integrations:
> **(A) the CDO Program** — retail patient orders that auto‑generate a wholesale dropship order and pay practitioner commissions; and
> **(B) the Wholesale Program** — practitioners ordering directly with flexible payment terms.

---

## 2. Key terms

| Term | Meaning |
|---|---|
| **CDO Program** | The referral + dropship + commission engine connecting Retail → Wholesale. |
| **Referral code** | A practitioner's code/link that attributes a patient (and their orders) to that practitioner. |
| **Attribution** | The permanent link between a patient and the practitioner who referred them. |
| **Commission** | Money a practitioner earns on an attributed, **paid** order, calculated **per product vendor**. |
| **Payout** | A batch disbursement of a practitioner's accumulated commissions, paid via Dwolla and recorded in QBO. |
| **Dropship order** | The wholesale‑side order automatically placed under the Admin account to fulfil a retail order. |
| **Invoice (A/R)** | "Money in" — sent to a customer/practitioner. |
| **Vendor Bill (A/P)** | "Money out" — what the business owes (the wholesale cost for a dropship order, or a practitioner's commission). |

---

## PART A — CDO Program (Retail → Wholesale)

### A1. Practitioner / store registration

A practitioner can be brought into the CDO Program three ways:

1. **Registration form** — the standard sign‑up form on the storefront.
2. **Direct email login** — passwordless login for an already‑approved email (Shopify OTP). Only emails carrying the **`Approved`** tag are let through; unknown emails are routed to the registration form.
3. **At checkout** — a patient who enters a referral code at checkout is mapped to the practitioner (see A2).

> **Approval gate.** Portal and program access requires the Shopify customer to carry both the **`Practitioner`** and **`Approved`** tags. Access is checked **live on every request** against current Shopify tags — removing a tag revokes access on the next request.

### A2. Patient ↔ Practitioner mapping (referral attribution)

A patient becomes linked to a practitioner through any of three entry points:

| Flow | How it happens | Result |
|---|---|---|
| **1. During sign‑up** | Patient enters a referral code while registering. | Patient mapped to the practitioner; code saved on the patient's Shopify profile. |
| **2. At checkout** | Patient enters a referral code during checkout. | Practitioner–patient relationship created; code saved to the patient's profile. |
| **3. Via referral link** | Practitioner shares a link. **Logged in →** code auto‑attaches if none assigned yet. **Logged out →** patient logs in first, then the code attaches automatically. | Same lifetime mapping. |

**Binding rules (enforced — this is critical):**

- The relationship is **lifetime**. Once a patient is attributed, they stay with that practitioner.
- A patient **may switch to a different code of the *same* practitioner** (practitioners can rotate/re‑issue codes) — the system binds on the **practitioner, not the code**.
- A patient **cannot** move to a code belonging to a **different** practitioner. This is blocked at **four points**: registration, checkout validation, the checkout "can't proceed" block, and server‑side at order ingestion (the backstop that always holds, even if the checkout widget can't run).

### A3. CDO order flow (the dropship pipeline)

This is the heart of the CDO Program. When a patient checks out on the Retail store:

```
Patient pays on Retail checkout
   │
   ├─▶ RETAIL: Paid Invoice created in QBO (Retail ledger) and emailed to the patient.
   │
   └─▶ A wholesale order is AUTOMATICALLY placed on the Wholesale store
        at WHOLESALE price, under the Admin/dropship account.
            • Testing account: dropship@naturalsolutionsphc.com  (changes in production)
            • Appears on the Admin → Orders page as "Pending Payment".
            • WHOLESALE: Unpaid Invoice created in QBO (Wholesale ledger).
            • RETAIL: a Vendor Bill (A/P) created in QBO (Retail ledger) for the wholesale cost.
   │
   ▼
A scheduled job (CRON) charges the card on file in the Admin/dropship account.
   • On success → Wholesale Invoice marked PAID + Retail Vendor Bill marked PAID.
```

**In words:** the patient pays retail; the business simultaneously "buys" the goods from the wholesale side at wholesale price, on credit, under the dropship account. A background job settles that internal purchase by charging the dropship card, which closes out both the wholesale invoice and the retail‑side vendor bill.

### A4. Shipping & pricing (the markup)

Retail price includes a shipping markup that is **not** passed through to the wholesale side:

| Leg | Shipping charged | Notes |
|---|---|---|
| **Retail (patient pays)** | **$18** = $10 actual + **$8 markup** | The $8 is the hidden margin retained by the business. |
| **Wholesale (dropship order)** | **$10** | Only the actual carrier cost flows to the wholesale side. |

> Live carrier rates at checkout are sourced from carrier APIs (USPS implemented; UPS/FedEx/DHL planned). Label purchase happens at fulfillment (§A7).

### A5. Commission logic

> **⚠️ Important clarification vs. the brief.** Commission is **driven by the product's Vendor/Company, not by the referral code's discount**. The referral code attributes the order; the **vendor's configured commission %** sets the amount. If a vendor has no configured rate, that line earns **0%**. So *"commission percentages must be configured for each Vendor"* is not optional — until vendors are configured, attributed orders accrue **$0**.

**How a commission is calculated:**

- For each line on the order: `line commission = (price × qty − discounts) × that line's vendor rate`. The order's commission is the sum across lines.
- The calculation is **snapshotted once, at order creation**, and is **immutable** afterward. Re‑processing the order (payment updates, webhook replays) never changes it. Changing a vendor's rate later **only affects future orders** — existing commissions are untouched (full audit trail of rate changes is kept).

**When a commission record is actually created:**

- **Only for PAID orders.** Attribution is captured at any payment state, but the commission (the money record) is created only once the order is **paid** and not cancelled.
- **Refund / void / cancel** before the commission is paid or batched → the commission is **reversed** (clawed back) with a ledger entry. Already‑paid commissions are **never** silently clawed back. (Partial refunds are currently left intact.)

**Accumulation & eligibility for payout:**

- Commissions accumulate per practitioner until the payout date.
- A commission is **eligible** when it is approved, not yet paid, not paused, and the practitioner isn't on hold.
- The per‑practitioner total must clear the configured **minimum payout amount** to be paid this cycle (below‑minimum amounts roll forward).

### A6. Commission payout flow (Dwolla + QBO)

```
Scheduled payout run (monthly; default 00:30 on the 25th)
   1. Accrue + auto‑approve eligible commissions (skips paused / on‑hold).
   2. Aggregate into ONE payout per practitioner for the period (3 commissions → 1 payout).
   3. APPROVAL GATE (default ON): payouts wait for an Admin to Approve before money moves.
   4. On Approve + Execute, for each payout:
        • Validate the practitioner's bank details (read fresh; ABA checksum, etc.).
            – invalid → payout fails with a reason; nothing is sent.
        • Record the liability in QBO (Retail ledger): Vendor + Vendor Bill.
        • Initiate the ACH transfer via Dwolla (business bank → practitioner bank).
        • Payout moves to "Awaiting settlement" (NOT yet "Paid").
   5. A separate Settlement job polls Dwolla:
        • settled  → record the QBO Bill Payment, mark commissions PAID, mark payout PAID.
        • returned → payout FAILED (ACH return code captured); commissions stay reserved
                     so the payout can be re‑sent once banking is fixed (no double‑pay).
```

**Clarifications vs. the brief:**

- **"A Paid Bill is generated for the practitioner (QBO Retail)"** — correct: it's a QBO **Vendor Bill** + **Bill Payment** in the Retail ledger. ✅
- **Two safeguards the brief didn't mention:**
  - **Human approval gate** (`CDO_PAYOUT_REQUIRE_APPROVAL`, default ON) — the CRON prepares payouts but an Admin must approve before any money leaves. (Can be disabled for fully‑automated disbursement, but that's discouraged with real money.)
  - **"Paid" means *settled*, not just *recorded*.** Because ACH takes 1–3 business days, the system records the QBO Bill Payment and marks the commission "Paid" **only after Dwolla confirms settlement**.
- **Bank details** live on the practitioner's wholesale application (`commission` object), are read **fresh at execution**, **validated** before any transfer, and stored only **masked** (last 4 + routing) — the full account number is never persisted or logged.
- A failed payout never stops the rest of the batch; failures raise alerts and can be **reprocessed** (idempotent — never double‑pays).

### A7. Order fulfillment & tracking (CDO)

**Fulfillment happens on the Wholesale side only.**

1. Admin generates and **purchases a shipping label** for the wholesale (dropship) order.
2. Once purchased, the order is marked **Fulfilled on both the Wholesale and Retail stores**.
3. The **Tracking ID** is written onto **both** invoices — the Wholesale Admin invoice (QBO Wholesale) and the Retail Customer invoice (QBO Retail).
4. The customer's invoice carries a **tracking link** at the bottom; clicking it opens the carrier's official tracking page.

> The retail customer is automatically re‑notified (invoice re‑sent with tracking) when the shipment is created. Shipping/delivery status is derived and self‑healing — a late or missed update won't leave a shipped order stuck reading "unfulfilled."

### A8. Admin controls (CDO)

- **Disable / pause commission generation and payouts** for any practitioner (per‑commission, or all of a practitioner's payouts). Paused commissions keep accruing but are excluded from payout runs; resuming returns them to the next cycle.
- **Create referral codes** with a chosen discount %. *(Clarification: the self‑service Portal restricts practitioners to fixed tiers — 10/15/20/25/30/35% — and one active code per tier; the Admin can create codes more freely, including 0% / attribution‑only.)*
- View every related Invoice and Bill directly in QBO via deep links.

---

## PART B — Wholesale Program (Practitioner direct orders)

### B1. Registration

- **Via the registration form only.** (No checkout/email‑login path here.)

### B2. Order flow

- The practitioner places an order with **no payment required at checkout** (**Pay Later**).
- An **Invoice (QBO Wholesale)** is generated and emailed to the practitioner.
- How that invoice gets paid depends on the practitioner's **payment method** (B3).

### B3. Payment methods

| Method | How payment happens |
|---|---|
| **Cheque** (manual) | Admin enters the cheque **reference number** on the Order Details page and clicks **Mark as Paid**. If the cheque never arrives, Admin can wait until the due date and then **charge the card on file**. |
| **ACH** (via CRON) | On the scheduled date, a job charges the invoice amount **+ a 1% processing fee** to the bank details provided at registration. |
| **Immediate payment** | A **payment link** is included in the invoice. The practitioner pays by card; **NMI** processes it; on success the invoice is **auto‑marked Paid**. |
| **Card** (via CRON) | The invoice amount is **automatically charged** to the card on file through **NMI** on the scheduled run. |

> **Card/ACH charges are processed by the wholesale scheduler** (runs on the **15th and last day** of the month in production). The job charges due invoices and then re‑syncs anything that has been paid.

### B4. Order fulfillment & tracking (Wholesale)

- **Wholesale only:** Admin generates and purchases a **shipping label**; the order is marked **Fulfilled** on the Wholesale store.
- The **Tracking ID** appears on the Wholesale invoice, with a tracking link to the carrier's site.

### B5. Admin controls (Wholesale)

- **Payment‑preference change applies to all unpaid invoices** — if a practitioner updates their method, it re‑applies to their open invoices.
- **Pause / resume CRON processing** for any order (so it won't be auto‑charged).
- **Pause / resume automated email notifications** for any order.
- **Manually send an invoice** via the "Send Email" button.
- **Manually charge the card on file** for overdue invoices.
- View all Invoices/Bills in QBO.

---

## PART C — Practitioner Portal

A self‑service dashboard rendered **inside the practitioner's Shopify customer account** (Retail store). Read access + referral self‑service writes.

Practitioners can:

- **Create and share referral codes & links** (each backed by a real Shopify discount).
- **Pause / reactivate** their own referral codes.
- See **how many patients** are linked to each code.
- See **all attributed orders** and the **commissions** they generated.
- See **pending commission payments** and **total revenue** from attributed orders.
- Access **analytics and performance insights**.

**Rules enforced server‑side:** codes are unique store‑wide; discount must be one of the fixed tiers (10/15/20/25/30/35%); **one active code per tier**; pausing a code deactivates its Shopify discount so it genuinely stops applying. Access requires the `Practitioner` + `Approved` tags (checked live every request).

---

## PART D — Practitioner Profile Update

Everything provided at registration can be updated from the Profile Update section:

- Personal details, payment details, license information, Resale Tax ID / tax‑exemption details, uploaded documents, and other registration info.
- **Preferred payment method** — updating it applies to future transactions **and re‑applies to unpaid invoices** (consistent with B5).

> Sensitive fields are protected: card data goes to the NMI vault (never stored raw); bank account numbers are encrypted; tax IDs are masked. `email`, `password`, and original referral attribution are intentionally **not** editable here.

---

## PART E — Integrations & ledger map

There are **three independent QBO ledgers** — keeping them straight is essential.

| Ledger / path | Store | Records | Used by |
|---|---|---|---|
| **Wholesale QBO** | Wholesale | Wholesale **Invoices** (A/R) + payments | Wholesale Program (Part B) and the dropship wholesale invoice (A3). |
| **Retail QBO — A/R** | Retail | Retail customer **Invoices** (money in) + payments | CDO retail orders (A3). |
| **Retail QBO — A/P** | Retail | **Vendor Bills** (money out) — dropship cost (A3) **and** commission payouts (A6). | CDO dropship settlement + practitioner commission payouts. |

> Retail A/R and Retail A/P share the **same QBO company** (one realm, one OAuth token); the Wholesale QBO is a separate integration. **NMI** handles cards; **Dwolla** moves commission money; **Shopify** owns checkout/fulfilment on each store.

---

## PART F — Automated jobs (CRON) summary

| Job | Schedule | What it does |
|---|---|---|
| **Wholesale payment scheduler** | 15th + last day of month (prod) | Charges due Card/ACH wholesale invoices via NMI; re‑syncs paid invoices. Respects per‑order pause. |
| **Dropship card charge** | Scheduled | Charges the dropship/admin card to settle the internal wholesale invoice + retail vendor bill (A3). |
| **Commission payout run** | ~00:30 on the 25th (prod) | Accrues, auto‑approves, aggregates one payout per practitioner; waits for Admin approval (gate ON), then records QBO + initiates Dwolla transfer. |
| **Payout settlement reconciliation** | Every ~6h (prod) | Polls Dwolla; on settle → QBO Bill Payment + mark Paid; on return → mark Failed (kept for retry). |

> **Production note:** run a **single scheduler‑owning process** (or disable the scheduler on the others) so jobs don't double‑run. All jobs are **idempotent** — safe to re‑run, never double‑charge or double‑pay.

---

## PART G — Key safeguards & considerations (don't skip)

These are properties the system already enforces that protect the business and should be respected operationally:

1. **No duplicate money.** Every money path is idempotent — duplicate webhooks, retries, and re‑runs never create a second invoice, charge, or payout.
2. **Commission immutability.** A commission is snapshotted at order time; vendor‑rate edits apply only to future orders. There is a full audit trail of rate changes.
3. **Pay only on payment.** Commissions exist only for paid orders; retail/wholesale invoices are gated on payment status.
4. **Approval before disbursement.** Commission money does not leave without an Admin approval (default).
5. **"Paid" = settled.** Commission "Paid" reflects confirmed ACH settlement, not just an accounting entry.
6. **Bank data protection.** Account numbers are validated, used transiently, stored masked, and never logged.
7. **Permanent attribution.** A patient stays with their first practitioner; foreign codes are rejected at 4 enforcement points.
8. **Self‑healing fulfilment.** Shipping/delivery status is derived from Shopify fulfilments so a missed webhook doesn't leave stale status.

### Open / operational requirements before scale

- **Configure vendor commission %s** — otherwise attributed orders earn $0.
- **Switch the dropship account** from `dropship@naturalsolutionsphc.com` to the production account.
- **Provision the Dwolla business funding source** (verified bank account) and choose sandbox vs. production.
- **Seed QBO** — realm IDs, refresh tokens, and Chart‑of‑Accounts IDs for all three ledgers; tokens auto‑rotate after first use.
- **Configure NMI** (match sandbox/production keys to environment).
- **Configure carrier API credentials** for live rates and labels.
- **Decide minimum payout amount, payout schedule, currency** in program settings.
- **Before real‑money go‑live (commission rail):** bank‑ownership verification (micro‑deposit/Plaid), account‑number tokenization/encryption, funding‑balance pre‑check + payout caps, 1099/W‑9 enforcement, and the NACHA originator agreement.

---

## Appendix — Where each piece lives (technical reference)

| Area | Location |
|---|---|
| Canonical wholesale spec | [wholesale/CLAUDE.md](wholesale/CLAUDE.md), [wholesale/INTEGRATIONS.md](wholesale/INTEGRATIONS.md) |
| CDO commission & payout deep‑dive | [ns-retail/docs/payout.md](ns-retail/docs/payout.md) |
| CDO order ingestion / commission engine | `ns-retail/app/services/cdo/cdo.service.js` |
| Practitioner Portal backend | `ns-retail/app/services/cdo/cdo.portal.service.js` |
| Retail QBO invoicing (A/R) | `ns-retail/app/services/retailQbo/` |
| Commission payout QBO (Bills) | `ns-retail/app/services/qbo/` |
| Dwolla / disbursement | `ns-retail/app/services/payout/` |
| Wholesale order→payment pipeline | `wholesale/app/services/{order,invoice,payment,nmi,qbo}/` |
| Project memory / changelog | [PROGRAM.md](PROGRAM.md) |
