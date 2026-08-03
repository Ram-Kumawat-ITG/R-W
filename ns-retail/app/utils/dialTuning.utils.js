/* eslint-env node */
// Raise Node's happy-eyeballs per-address connect budget.
//
// ── THE PROBLEM ───────────────────────────────────────────────────────────
// Node >= 20 enables `autoSelectFamily` by default: for a host that resolves
// to several addresses (IPv4 + IPv6, or several A records) it races them
// rather than trying one, and gives EACH ATTEMPT only
// `autoSelectFamilyAttemptTimeout` milliseconds to complete the TCP connect.
//
// That default is **250 ms**.
//
// A TCP connect needs a full round trip, so the budget is effectively "is this
// host within ~250 ms RTT?". Intuit's API is hosted in AWS us-west-2 (Oregon);
// measured RTT from this deployment's region is 270–350 ms. Every attempt
// therefore overruns its budget, Node abandons it, and — once all addresses
// are exhausted — surfaces the result as:
//
//   TypeError: fetch failed
//     cause: AggregateError [ETIMEDOUT, ETIMEDOUT, ..., ENETUNREACH]
//
// which is indistinguishable from a firewall silently dropping the traffic.
// It also explains the INTERMITTENCY: when RTT dips below 250 ms the call
// succeeds, so the same endpoint works one hour and fails the next.
//
// This is not a firewall problem and cannot be fixed by env vars, credentials,
// or Docker config — the connection is being cancelled locally, by Node.
//
// ── THE FIX ───────────────────────────────────────────────────────────────
// Raise the per-attempt budget. This does NOT slow down healthy connections:
// the timeout only bounds how long Node waits before moving to the NEXT
// address, so a fast connect still returns immediately. It only stops Node
// giving up on a distant-but-reachable host.
//
// Applies process-wide to every `net.connect` — so undici/fetch (QBO, NMI,
// Shopify, cross-app calls) all benefit. Call once at server boot.

import net from 'node:net'
import { readInt } from './env.utils'

// 5s is generous for any transcontinental TCP connect while still failing
// fast against a genuinely dead host. Override with DIAL_ATTEMPT_TIMEOUT_MS.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5000

export function applyDialTuning() {
  const target = Math.max(250, readInt('DIAL_ATTEMPT_TIMEOUT_MS', DEFAULT_ATTEMPT_TIMEOUT_MS))
  try {
    const current = net.getDefaultAutoSelectFamilyAttemptTimeout?.()
    // Guard: the setter landed in Node 20.x. If it's missing we're on an older
    // runtime that also predates autoSelectFamily, so there is nothing to fix.
    if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
      return { applied: false, reason: 'unsupported_node' }
    }
    if (current >= target) return { applied: false, reason: 'already_sufficient', current }
    net.setDefaultAutoSelectFamilyAttemptTimeout(target)
    console.log(
      `[boot] dial tuning — autoSelectFamilyAttemptTimeout ${current}ms → ${target}ms ` +
        `(250ms default is shorter than the RTT to US-hosted APIs from this region, ` +
        `which surfaces as spurious ETIMEDOUT)`,
    )
    return { applied: true, from: current, to: target }
  } catch (err) {
    // Never block boot over a tuning knob.
    console.warn(`[boot] dial tuning skipped: ${err?.message || err}`)
    return { applied: false, reason: 'error', error: err?.message || String(err) }
  }
}
