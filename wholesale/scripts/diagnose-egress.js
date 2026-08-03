#!/usr/bin/env node
//
// Outbound-connectivity diagnostic. Answers ONE question: can this process
// reach the third-party hosts the app depends on, and if not, why?
//
//   node scripts/diagnose-egress.js          # or: npm run diagnose:egress
//
// Deliberately DEPENDENCY-FREE and app-import-free (no config, no Mongo, no
// build step) so it runs inside a production container exactly as-is:
//
//   docker exec <container> node scripts/diagnose-egress.js
//
// For each host it reports:
//   1. DNS      — every resolved address, tagged IPv4 / IPv6
//   2. TCP      — a raw connect to :443 per ADDRESS, so an unroutable IPv6
//                 address is distinguishable from a blocked IPv4 one
//   3. HTTPS    — a real fetch(), i.e. the exact stack the app uses
//
// Step 2 is the decisive one. Node's happy-eyeballs tries every address and
// reports only an empty AggregateError, so "IPv4 works / IPv6 times out" is
// invisible in normal logs — that pattern is the classic "DNS publishes AAAA
// but this host has no IPv6 route" case, which is fixed with NODE_OPTIONS
// rather than with a firewall change.

import dns from 'node:dns/promises'
import net from 'node:net'

const TCP_TIMEOUT_MS = 6000
const HTTP_TIMEOUT_MS = 8000

// eslint-disable-next-line no-undef
const env = process.env

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// google is a CONTROL: if it fails too, outbound 443 is dead generally
// rather than anything Intuit-specific.
const TARGETS = [
  { host: 'www.google.com', label: 'control (any outbound 443)' },
  { host: 'oauth.platform.intuit.com', label: 'QBO token refresh — blocks ALL QBO if down' },
  { host: 'sandbox-quickbooks.api.intuit.com', label: 'QBO API (sandbox)' },
  { host: 'quickbooks.api.intuit.com', label: 'QBO API (production)' },
  { host: 'secure.networkmerchants.com', label: 'NMI (card / ACH charges)' },
  ...[hostOf(env.NS_RETAIL_API_BASE)]
    .filter(Boolean)
    .map((host) => ({ host, label: 'ns-retail (cross-app)' })),
]

function tcpProbe(address, family) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host: address, port: 443, family })
    const done = (result) => {
      socket.destroy()
      resolve({ ...result, ms: Date.now() - started })
    }
    socket.setTimeout(TCP_TIMEOUT_MS)
    socket.once('connect', () => done({ ok: true }))
    socket.once('timeout', () => done({ ok: false, code: 'TIMEOUT' }))
    socket.once('error', (err) => done({ ok: false, code: err.code || err.message }))
  })
}

async function probeHost({ host, label }) {
  console.log(`\n${'─'.repeat(70)}\n${host}\n  ${label}`)

  let addrs = []
  try {
    addrs = await dns.lookup(host, { all: true })
  } catch (err) {
    console.log(`  DNS    ✗ FAILED (${err.code || err.message})`)
    return { host, dnsOk: false, v4: null, v6: null, httpOk: false }
  }
  console.log(`  DNS    ✓ ${addrs.map((a) => `IPv${a.family} ${a.address}`).join(', ')}`)

  const results = []
  for (const a of addrs.slice(0, 4)) {
    const r = await tcpProbe(a.address, a.family)
    results.push({ family: a.family, ...r })
    const mark = r.ok ? '✓' : '✗'
    console.log(
      `  TCP    ${mark} IPv${a.family} ${a.address}:443 — ${r.ok ? 'connected' : r.code} (${r.ms}ms)`,
    )
  }

  let httpOk = false
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    httpOk = true
    // Any HTTP status proves reachability — 404/403 from a bare root path is fine.
    console.log(`  HTTPS  ✓ HTTP ${res.status} (reachable)`)
  } catch (err) {
    console.log(`  HTTPS  ✗ ${err.message}`)
  }

  const byFamily = (f) => {
    const hits = results.filter((r) => r.family === f)
    return hits.length ? hits.some((r) => r.ok) : null // null = no address of this family
  }
  return { host, dnsOk: true, v4: byFamily(4), v6: byFamily(6), httpOk }
}

const results = []
for (const t of TARGETS) results.push(await probeHost(t))

// ── Verdict ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}\nVERDICT\n${'═'.repeat(70)}`)

const control = results.find((r) => r.host === 'www.google.com')
const intuit = results.filter((r) => r.host.includes('intuit.com'))
const anyV6Broken = results.some((r) => r.v6 === false && r.v4 === true)
const intuitReachable = intuit.some((r) => r.httpOk)

if (anyV6Broken) {
  console.log(
    '\n➤ IPv6 IS BROKEN ON THIS HOST.\n' +
      '  IPv4 connects but IPv6 does not. DNS publishes AAAA records, so Node\n' +
      '  tries IPv6 too and the whole request fails with an empty AggregateError.\n\n' +
      '  FIX — add to this app\'s environment variables, then redeploy:\n' +
      '    NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection\n' +
      '  (If NODE_OPTIONS is already set, APPEND these flags — do not overwrite.)',
  )
} else if (!control?.httpOk) {
  console.log(
    '\n➤ ALL OUTBOUND HTTPS IS BLOCKED.\n' +
      '  Even google.com is unreachable, so this is not Intuit-specific.\n' +
      '  This is a firewall / egress / connectivity problem on the host or\n' +
      '  network. It cannot be fixed in application code or in Coolify.',
  )
} else if (!intuitReachable) {
  console.log(
    '\n➤ INTUIT IS BLOCKED SPECIFICALLY.\n' +
      '  General outbound 443 works (google.com is reachable) but Intuit is not.\n' +
      '  Ask whoever manages this network to allow outbound TCP 443 to\n' +
      '  *.intuit.com. Intuit sits behind Akamai and its IPs rotate, so the\n' +
      '  rule must be hostname/SNI-based — an IP allowlist will keep breaking.',
  )
} else {
  console.log('\n➤ All checked hosts are reachable from this process right now.')
  console.log('  If the app is still failing, the outage is intermittent — re-run during a failure.')
}
console.log('')
