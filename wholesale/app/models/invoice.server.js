import mongoose from 'mongoose'

// Local mirror of a QBO invoice. The retry scheduler scans this
// collection — never QBO directly — to decide which invoices need
// charging on the 15th / last-of-month tick.
const invoiceSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },

    orderRef: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopifyOrder', required: true },
    shopifyOrderId: { type: String, index: true },

    customerMapRef: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMap' },
    customerEmail: { type: String, lowercase: true, index: true },

    // Drop-ship invoice marker. True for invoices created for the synthetic
    // retail drop-ship customer (DROPSHIP_RETAIL_CUSTOMER_EMAIL) — see
    // services/order/order.service.js + services/dropship. These are created
    // UNPAID and collected by a DEDICATED CRON (process-dropship-payments)
    // against a single configured NMI vault (DROPSHIP_NMI_VAULT_ID), NOT a
    // per-customer registration vault. The flag segregates them from the
    // wholesale payment CRON (process-pending-payments excludes
    // `isDropship: { $ne: true }` from all of its passes) and is the cursor
    // key the dropship CRON sweeps on. `paymentMethod: 'dropship'` is the
    // companion segregation key (it falls outside the wholesale PASS 1
    // card/ach filter and carries a 0% processing fee).
    isDropship: { type: Boolean, default: false, index: true },

    // Optional during the brief window between claiming the (shop,
    // shopifyOrderId) slot and actually creating the invoice in QBO.
    // Set after the QBO POST succeeds.
    qboInvoiceId: { type: String, index: true },
    qboDocNumber: String,
    qboSyncToken: String,
    // Payment due date as returned by QBO at invoice creation. Stored as
    // an ISO date string ("YYYY-MM-DD") to match QBO's date-only format
    // — Mongoose Date would coerce to UTC midnight and risk timezone
    // off-by-ones when rendered locally.
    qboDueDate: String,
    qboTxnDate: String,
    // Full-datetime due timestamp — order date + termsDays + termsMinutes
    // (see invoice.config.js). The local Order List "Overdue" indicator
    // and cheque-reminder UI compare against this rather than qboDueDate
    // so the INVOICE_TERMS_MINUTES testing knob can drive sub-day
    // granularity. qboDueDate remains the canonical value sent to QBO
    // (date-only, per QBO's DueDate field).
    dueAt: Date,

    // Tracks the creation handshake so a crash mid-flight is recoverable:
    //   claimed  — Invoice row inserted, QBO call not yet attempted
    //   created  — QBO invoice created and id saved on this row
    //   failed   — QBO call returned an error
    qboCreationStatus: {
      type: String,
      enum: ['claimed', 'created', 'failed'],
      default: 'claimed',
      index: true,
    },
    qboCreationError: String,
    qboCreationClaimedAt: Date,

    currency: { type: String, default: 'USD' },
    amountDue: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },

    // Payment method locked at invoice creation, sourced from the
    // customer's wholesale-application preference (mirrored on CustomerMap).
    //   card  — eligible for CRON auto-charge against the NMI vault
    //   check — held until an admin records a manual cheque, or falls back to card
    //   ach   — same manual treatment as check (per project decision)
    //
    // CAN be mutated post-creation by the cheque → card admin fallback
    // (api/admin/charge-card.js). For the immutable order-time
    // preference, see `customerPaymentPreference`. For what actually
    // settled the invoice, see `paymentSettledVia`.
    //   immediate — customer self-pays via a hosted NMI pay-link + QR on
    //               the QBO invoice (no stored vault). NOT auto-charged by
    //               the CRON (PASS 1 filters card/ach only). Settles via
    //               the public /pay/<token> flow → propagateSuccessfulPayment.
    //   dropship  — invoice for the synthetic retail drop-ship customer
    //               (see `isDropship`). NOT auto-charged by the wholesale
    //               CRON (PASS 1 filters card/ach only); collected by the
    //               dedicated process-dropship-payments CRON against the
    //               configured DROPSHIP_NMI_VAULT_ID. Carries no processing
    //               fee (no rate configured → computeProcessingFee returns
    //               null). Locked at creation; never flipped by an admin
    //               fallback.
    paymentMethod: {
      type: String,
      enum: ['card', 'check', 'ach', 'immediate', 'dropship'],
      default: 'card',
      index: true,
    },

    // Immutable snapshot of the customer's payment-method preference at
    // the moment this invoice was created. Even if the customer updates
    // their preference later (via /api/update-profile), this never
    // changes — historical orders display the preference they were
    // placed with. Display fallback for legacy invoices missing this
    // field: use `paymentMethod` (they were equal before the
    // cheque → card override existed).
    customerPaymentPreference: {
      type: String,
      enum: ['card', 'check', 'ach', 'immediate', 'dropship'],
    },

    // Method that actually settled (or last contributed to settling)
    // the invoice. Written on every successful payment event — an
    // approved NMI charge sets it to the active `paymentMethod`
    // ('card' or 'ach'), a manual cheque receipt sets it to 'check'
    // or 'ach'. Stays null while the invoice is unpaid; the display
    // layer falls back to "Active method" (`paymentMethod`) in that
    // case. Distinct from `paymentMethod` (current operational
    // method, mutable) and `customerPaymentPreference` (order-time
    // snapshot, immutable).
    paymentSettledVia: {
      type: String,
      enum: ['card', 'check', 'ach'],
    },
    paymentSettledAt: Date,

    // ── Immediate Payment — self-pay link ────────────────────────────
    //
    // For `paymentMethod: 'immediate'` invoices only. `payToken` is an
    // opaque, cryptographically-random bearer credential (NOT a signed
    // amount) minted at invoice creation and embedded in the durable public
    // URL /pay/<payToken> (baked into the QBO invoice CustomerMemo). That
    // page looks the invoice up by this token, computes the outstanding
    // balance SERVER-SIDE, and collects it via NMI Collect.js.
    //
    // `payTransactionIds` dedups settlement — a returning NMI transaction
    // id already present here is ignored so a double charge / resubmit
    // can't bump amountPaid twice.
    payToken: { type: String, index: { unique: true, sparse: true } },
    payTokenCreatedAt: Date,
    payTransactionIds: { type: [String], default: undefined },

    // Lifecycle of the invoice's payment, independent of QBO's own status.
    //
    // Derived state — never set ad-hoc. Use deriveInvoicePaymentStatus
    // (invoice.utils.js) so payments feed into a consistent transition:
    //   pending             — no money received yet
    //   in_progress         — NMI sale call is currently in flight (lock)
    //   awaiting_settlement — NMI accepted an ACH sale (response code 100)
    //                         but the ACH network has not yet settled the
    //                         funds. The transaction can still be returned
    //                         (NSF, closed account, etc.) for 1–3 business
    //                         days after submission. amountPaid is NOT bumped
    //                         while in this state — the in-flight amount
    //                         lives on `pendingSettlementAmount` so we can
    //                         either credit it on settle or drop it on
    //                         return. Card-method invoices never enter this
    //                         state (card sales are funds-captured at NMI's
    //                         approval).
    //   partially_paid      — 0 < amountPaid < amountDue
    //   paid                — amountPaid >= amountDue
    //   failed              — exhausted maxAttempts without settling
    //   cancelled           — kept for backward compatibility with any
    //                          pre-existing records; no UI path currently
    //                          writes this state
    paymentStatus: {
      type: String,
      enum: [
        'pending',
        'in_progress',
        'awaiting_settlement',
        'partially_paid',
        'paid',
        'failed',
        'cancelled',
      ],
      default: 'pending',
      index: true,
    },

    // ── ACH settlement tracking ──────────────────────────────────────
    //
    // ACH transactions are accepted by NMI immediately (response code
    // 100 = "Approved" at the gateway) but settled by the ACH network
    // 1–3 business days later. Until settlement, the transaction can
    // still be returned (NSF, closed account, frozen funds, etc.) and
    // the credit unwound. To represent this safely we DO NOT bump
    // amountPaid on ACH approval — we record the in-flight amount on
    // these fields and rely on a CRON pass (PASS 1.7) that polls NMI's
    // query.php for the transaction's current `condition` to:
    //   - condition='complete'         → bump amountPaid, clear these
    //                                     fields, propagate to QBO/Shopify
    //   - condition='failed'/'canceled'→ clear fields, drop the credit,
    //                                     flip back to pending/failed
    //   - condition='pendingsettlement'→ leave as-is, log a remark
    //
    // pendingSettlementFeeAmount carries the processing-fee component
    // that was staged on the original charge so the settle pass can
    // append it to the QBO invoice line only after settlement is
    // confirmed.
    pendingSettlementTxnId: { type: String, index: true },
    pendingSettlementAmount: Number,
    pendingSettlementFeeAmount: Number,
    pendingSettlementSince: Date,
    pendingSettlementLastCheckedAt: Date,

    // ── ACH status synchronization (services/payment/achStatusSync) ───
    //
    // The dedicated ACH Status Synchronization CRON
    // (`process-ach-status-sync`) polls NMI for the latest condition of
    // every awaiting-settlement ACH transaction and records the outcome
    // here. `achReturnCode` / `achReturnReason` capture the NACHA return
    // detail when a debit is returned or voided (e.g. R01 — insufficient
    // funds); `achStatusHistory[]` is the append-only audit trail of every
    // detected status CHANGE — one entry per transition, so a re-poll that
    // sees no change adds nothing (keeps the sync idempotent).
    achReturnCode: String,
    achReturnReason: String,
    achReturnedAt: Date,
    achStatusHistory: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            // Normalized lifecycle status we transitioned TO, derived from
            // NMI's transaction condition: pending_settlement | settled |
            // returned | voided | failed | unknown.
            status: { type: String, required: true },
            previousStatus: String, // our paymentStatus before the change
            nmiCondition: String, // raw NMI condition string
            nmiTransactionId: String,
            returnCode: String, // NACHA return code, when applicable
            returnReason: String,
            amount: Number,
            source: { type: String, default: 'cron_ach_status_sync' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // ── Manual "Sync ACH Status" admin action ─────────────────────────
    //
    // The Order Details page exposes an on-demand "Sync ACH status"
    // button that runs the SAME reconciliation as the CRON, for a single
    // invoice, without waiting for the scheduled `process-ach-status-sync`
    // tick. `achSyncInProgress` is an atomic lock (set via findOneAndUpdate)
    // that prevents two syncs racing on the same invoice — a double-click
    // or an overlapping CRON+manual run. `achSyncLastAt` / `achSyncLastStatus`
    // / `achSyncLastCondition` / `achSyncLastSource` capture the most recent
    // sync result (from EITHER the CRON or the manual button) so the UI can
    // show "last synced X — status Y"; `achSyncLastBy` records the admin
    // email when the sync was triggered manually.
    achSyncInProgress: { type: Boolean, default: false },
    achSyncStartedAt: Date,
    achSyncLastAt: Date,
    achSyncLastStatus: String, // normalized: settled|returned|voided|failed|pending_settlement|unknown|error
    achSyncLastCondition: String, // raw NMI condition
    achSyncLastSource: String, // 'cron_ach_status_sync' | 'admin_manual_sync'
    achSyncLastBy: String,

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    lastAttemptAt: Date,
    lastAttemptError: String,

    // Ledger of manual (non-NMI) payments recorded against this invoice —
    // currently just cheque receipts. Append-only; one entry per admin
    // action on the Order Details page.
    manualPayments: {
      type: [
        new mongoose.Schema(
          {
            kind: { type: String, enum: ['cheque', 'ach'], required: true },
            reference: { type: String, required: true },
            amount: { type: Number, required: true },
            currency: String,
            receivedAt: { type: Date, default: Date.now },
            recordedBy: String,
            recordedAt: { type: Date, default: Date.now },
            note: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // Append-only follow-up / remarks ledger surfaced on the Order List
    // page's Remarks column. Each entry is a single CRON-tick or admin
    // action's worth of activity. Distinct from PaymentAttempt (which
    // is the strict charge-attempt audit log) — remarks include
    // non-charge events too (cheque reminders, manual receipts,
    // failed-payment follow-ups). PaymentAttempt is the source of
    // truth for accounting; remarks[] is the source of truth for the
    // operator-facing "what has the system been doing for this
    // order" timeline.
    //
    // kinds:
    //   cron_card_attempt    — PASS 1 CRON tried to charge a card
    //   cron_ach_attempt     — PASS 1 CRON tried to charge ACH via the
    //                          NMI billing id stored at
    //                          wholesale_applications.payment.ach.nmi_billing_id.
    //                          Mirrors cron_card_attempt but kept as a
    //                          distinct enum so the Order Details badge
    //                          can render "ACH charge" vs "CRON charge"
    //                          without having to peek at the invoice's
    //                          current paymentMethod (which the
    //                          ACH → card admin fallback may flip).
    //   cron_ach_settlement_check — PASS 1.7 CRON polled NMI for the
    //                          status of an awaiting-settlement ACH
    //                          transaction. One entry per state change
    //                          (settled / failed / still pending after N
    //                          days). Successful settle / failed return
    //                          ALWAYS log; "still pending" logs at most
    //                          once per day to avoid spamming the
    //                          remarks panel during the normal 1–3 day
    //                          wait window.
    //   cron_dropship_attempt — the dedicated process-dropship-payments
    //                          CRON tried to collect a drop-ship invoice by
    //                          charging the configured DROPSHIP_NMI_VAULT_ID.
    //                          Kept distinct from cron_card_attempt so the
    //                          Order Details / Remarks feed reads "Drop-ship
    //                          collection" rather than a wholesale card charge.
    //   cron_cheque_reminder — PASS 1.5 CRON logged a reminder for a
    //                          pending cheque invoice (no charge
    //                          attempted — admins still need to act)
    //   cron_ach_reminder    — Legacy enum kept for back-compat with
    //                          rows logged before ACH became
    //                          auto-charged. Once ACH moved into
    //                          PASS 1 as an active charge path, the
    //                          reminder kind is no longer written;
    //                          new ACH rows use cron_ach_attempt.
    //   cron_failed_followup — PASS 1.5 CRON noted a failed card OR
    //                          ACH invoice that exhausted retries
    //   admin_action         — admin-driven settlement event (retry,
    //                          charge-card fallback, mark cheque paid)
    //   system_note          — any other system-generated note
    remarks: {
      type: [
        new mongoose.Schema(
          {
            kind: {
              type: String,
              enum: [
                'cron_card_attempt',
                'cron_ach_attempt',
                'cron_dropship_attempt',
                'cron_ach_settlement_check',
                'cron_cheque_reminder',
                'cron_ach_reminder',
                // Daily Check-payment reminder CRON (services/reminder) —
                // distinct from the legacy log-only PASS 1.5
                // `cron_cheque_reminder`: this one is written when an
                // actual QBO invoice reminder EMAIL was triggered.
                'cron_payment_reminder',
                'cron_failed_followup',
                'admin_action',
                'system_note',
              ],
              required: true,
            },
            message: { type: String, required: true },
            amount: Number,
            currency: String,
            source: { type: String, enum: ['cron', 'admin', 'system'], default: 'system' },
            createdAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    paidAt: Date,

    // Per-side sync state. With partial payments, each payment event
    // needs its own QBO Payment record and its own Shopify transaction
    // — a single "did we sync?" boolean would skip the follow-up
    // payments. We track CUMULATIVE recorded amounts so partial
    // payments stay in lockstep across all three systems:
    //
    //   qboRecordedTotal       — sum of QBO Payment.TotalAmt we've created
    //   qboPaymentIds[]        — every QBO Payment.Id we've created
    //   shopifyRecordedTotal   — sum of Shopify transactions.kind=SALE we've created
    //   shopifyTransactionIds[]— every Shopify transaction.id we've created
    //
    // `qboPaymentRecorded` is now derived: true iff
    // qboRecordedTotal >= amountPaid (within 0.005). Kept as a stored
    // boolean for backward compat with the CRON PASS 2 cursor and to
    // avoid breaking pre-partial-payment invoices that have
    // qboPaymentRecorded=true but no cumulative-total recorded.
    // `shopifyMarkedPaid` stays as the binary orderMarkAsPaid signal,
    // fired once on full settlement (transactions handle the partial
    // mirror).
    qboPaymentRecorded: { type: Boolean, default: false },
    qboPaymentId: String, // first recorded QBO Payment.Id (legacy)
    qboRecordedTotal: { type: Number, default: 0 },
    qboPaymentIds: { type: [String], default: [] },
    shopifyMarkedPaid: { type: Boolean, default: false },
    shopifyMarkedPaidAt: Date,
    shopifyRecordedTotal: { type: Number, default: 0 },
    shopifyTransactionIds: { type: [String], default: [] },
    lastSyncError: String,

    // ── Auto-charge pause control ────────────────────────────────────
    //
    // Admin-controlled flag that takes an individual invoice out of the
    // CRON auto-charge sweep without affecting any other invoice or the
    // customer's broader payment preference. While `autoChargePaused`
    // is true:
    //   - PASS 1 (card charge) skips the invoice via the
    //     `autoChargePaused: { $ne: true }` filter
    //   - PASS 1.5 (reminders) also skips it — a paused invoice is
    //     intentionally muted, not waiting for follow-up
    //   - Admin actions (Retry payment / Charge card / Mark cheque
    //     paid) remain available — pause is CRON-only, never blocks
    //     deliberate admin settlement
    //
    // Feature is gated to card-preferred invoices in the UI
    // (`customerPaymentPreference === 'card'`). Cheque/ACH invoices
    // are already skipped by PASS 1 so a pause flag would be a no-op
    // there.
    //
    // `autoChargeResumeAt` records the timestamp of the most recent
    // resume action (NOT a scheduled future-resume date — there is no
    // background job that auto-resumes). Kept distinct from
    // `autoChargePausedAt` so the audit trail captures both the latest
    // pause and the latest resume independently.
    autoChargePaused: { type: Boolean, default: false, index: true },
    autoChargePausedAt: Date,
    autoChargePausedBy: String,
    autoChargeResumeAt: Date,
    autoChargeResumedBy: String,
    autoChargePauseNote: String,

    // Admin-controlled flag that mutes the Check-payment reminder CRON
    // (services/reminder) for this invoice only. Distinct from
    // `autoChargePaused` above: that gates the card auto-charge sweep
    // (card-preferred invoices); THIS gates reminder EMAILS (cheque
    // invoices). While `reminderPaused` is true the reminder job's
    // eligibility filter (`reminderPaused: { $ne: true }`) skips the
    // invoice entirely — no further automated reminder emails are sent
    // — until an admin resumes. Surfaced via the "Pause auto email
    // notifications" control on Order Details. Audit fields mirror the
    // auto-charge pause set: `*PausedAt/By` capture the latest pause,
    // `*ResumeAt/By` the latest resume, `*PauseNote` the optional reason.
    reminderPaused: { type: Boolean, default: false, index: true },
    reminderPausedAt: Date,
    reminderPausedBy: String,
    reminderResumeAt: Date,
    reminderResumedBy: String,
    reminderPauseNote: String,

    // Processing-fee state — captures the per-method surcharge added to
    // the invoice at settlement time (card=3%, ach=1%, check=0% by
    // default). The fee is decided by the **actual settlement method**
    // (paymentMethod at the moment of payment), not the customer's
    // preference: a cheque-preferred customer who gets charged via the
    // admin charge-card fallback lands here with method='card', so the
    // 3% fee applies. processingFeeAmount > 0 with processingFeeAppliedAt
    // == null means "fee owed but not yet on QBO" — propagateSuccessful-
    // Payment retries the append on every run until it lands.
    processingFeeAmount: Number,
    processingFeeRate: Number,
    processingFeeMethod: { type: String, enum: ['card', 'ach', 'check', 'immediate'] },
    processingFeeAppliedAt: Date,

    // ── Customer email lifecycle (QBO-driven) ────────────────────────
    //
    // We send the customer ONE channel of email — the invoice itself —
    // via QBO's `/invoice/<id>/send` endpoint. QBO mails the CURRENT
    // invoice document, so a re-send after recordPayment automatically
    // reflects the new balance + payments list. No separate payment-
    // receipt channel exists.
    //
    // Email fires:
    //   - once at invoice creation (initial delivery), and
    //   - again on every successful payment that grew amountPaid OR
    //     transitioned paymentStatus (pending → partially_paid → paid).
    //
    // QBO does not dedup `/send` calls — calling twice delivers two
    // emails. These fields are the only guard against double-sends.
    // All writes happen inside services/invoice/invoice.service.dispatch-
    // InvoiceLifecycleEmails(); nothing outside that helper should touch
    // them.
    //
    //   invoiceEmailSentAt        — first successful invoice email
    //   invoiceEmailLastSentAt    — most recent invoice email (initial + re-sends)
    //   invoiceEmailedStatus      — paymentStatus snapshot at last (re)send;
    //                                re-send fires when this differs from
    //                                current paymentStatus
    //   invoiceEmailedAmountPaid  — amountPaid snapshot at last (re)send;
    //                                re-send fires when current amountPaid
    //                                exceeds this (catches every partial)
    //   lastEmailError            — most recent QBO /send error message
    //                                (best-effort; doesn't block sync)
    invoiceEmailSentAt: Date,
    invoiceEmailLastSentAt: Date,
    invoiceEmailedStatus: {
      type: String,
      enum: [
        'pending',
        'in_progress',
        'awaiting_settlement',
        'partially_paid',
        'paid',
        'failed',
        'cancelled',
      ],
    },
    invoiceEmailedAmountPaid: Number,
    lastEmailError: String,

    // ── Check-payment reminder history (daily reminder CRON) ──────────
    //
    // Notification log for the standalone Check-reminder job
    // (services/reminder). One entry per reminder EMAIL we asked QBO to
    // send, keyed by `stage`. The named ladder stages (first / second /
    // card) each send at most once — a 'sent' entry suppresses re-send.
    // The 'recurring' stage is the exception: it repeats after the final
    // ladder stage, throttled by the most recent entry's `sentAt` to the
    // configured interval, so multiple 'recurring' rows accumulate (one
    // per cycle) until the invoice is paid. A 'failed' entry is retryable
    // on the next run. This is both the dedup source of truth and the
    // per-invoice audit log.
    paymentReminders: {
      type: [
        new mongoose.Schema(
          {
            // 'first' / 'second' / 'card' are the live ladder stage keys
            // (semantic, ladder-position independent of the threshold
            // value). 'recurring' is the post-final-stage reminder that
            // repeats at the configured interval until paid — its entries
            // accumulate (one per cycle). 'day7' / 'day9' / 'day13' are
            // legacy keys kept so .save() doesn't fail enum validation on
            // any pre-existing dev rows.
            stage: {
              type: String,
              enum: ['first', 'second', 'card', 'recurring', 'day7', 'day9', 'day13'],
              required: true,
            },
            sentAt: { type: Date, default: Date.now },
            daysSinceOrder: Number,
            recipient: String,
            status: { type: String, enum: ['sent', 'failed'], required: true },
            qboEmailStatus: String,
            errorMessage: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // Append-only history of every QBO `/invoice/<id>/send` attempt.
    // Powers the "Email history" panel on the Order Details page and
    // gives ops a full audit trail of who sent what, when, and whether
    // QBO accepted it.
    //
    // One entry per attempt — both successes and failures are recorded
    // so a failed delivery is visible to admins even after a later
    // attempt succeeds. The aggregate baseline fields above
    // (invoiceEmailSentAt / invoiceEmailLastSentAt / etc.) are the
    // dedup-driver for the lifecycle dispatcher; this ledger is the
    // audit-trail counterpart and exists alongside, not instead.
    //
    // Fields:
    //   triggerType   — 'auto' (lifecycle dispatcher fired from create /
    //                    payment events / CRON sweep) or 'manual'
    //                    (admin clicked "Send invoice")
    //   triggeredBy   — 'system' for auto sends, the admin's session
    //                    email for manual sends (falls back to shop
    //                    domain when no associated user email).
    //   source        — what kind of trigger fired the send:
    //                     invoice_created  — initial email at creation
    //                     payment_recorded — re-send because amountPaid grew
    //                     status_changed   — re-send because paymentStatus moved
    //                                        but amountPaid did not
    //                     manual_resend    — admin used the "Send invoice" button
    //   recipient     — `sendTo` we passed to QBO
    //   status        — 'sent' (QBO accepted the call) or 'failed' (any
    //                    error from sendInvoiceEmail)
    //   errorMessage  — failure detail (undefined on success)
    //   paymentStatusSnapshot / amountPaidSnapshot — invoice state at
    //                    send time, so the history reads sensibly even
    //                    after later payments change the current state.
    emailEvents: {
      type: [
        new mongoose.Schema(
          {
            createdAt: { type: Date, default: Date.now },
            triggerType: {
              type: String,
              enum: ['auto', 'manual'],
              required: true,
            },
            triggeredBy: { type: String, required: true },
            source: {
              type: String,
              enum: [
                'invoice_created',
                'payment_recorded',
                'status_changed',
                'manual_resend',
                // Daily Check-payment reminder CRON (services/reminder).
                'payment_reminder',
              ],
              required: true,
            },
            recipient: { type: String, required: true },
            status: {
              type: String,
              enum: ['sent', 'failed'],
              required: true,
            },
            errorMessage: String,
            paymentStatusSnapshot: String,
            amountPaidSnapshot: Number,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { collection: 'invoices', timestamps: true, strict: true },
)

invoiceSchema.index({ paymentStatus: 1, attemptCount: 1 })
// Hard guarantee at the DB level: at most one invoice per Shopify order
// per shop. If application-level checks ever race, the second insert
// throws E11000 instead of silently producing a duplicate QBO record.
invoiceSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true })

export default mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema)
