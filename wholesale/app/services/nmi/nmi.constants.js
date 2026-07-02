// NMI gateway constants.

// NMI has a separate sandbox host. Account type is fixed at signup — a
// sandbox security key will be REJECTED on the production host with a
// "Sandbox accounts must use sandbox.nmi.com" error, and vice versa.
// If sandbox stops resolving for you, override via NMI_API_URL / NMI_QUERY_URL.
export const NMI_BASE_URLS = {
  sandbox: {
    api: 'https://sandbox.nmi.com/api/transact.php',
    query: 'https://sandbox.nmi.com/api/query.php',
    // Collect.js — NMI-hosted card tokenization (iframe fields). Powers the
    // Immediate Payment self-pay page: the card is tokenized client-side and
    // never touches our server; we then charge type=sale with the token.
    collectJs: 'https://sandbox.nmi.com/token/Collect.js',
  },
  production: {
    api: 'https://secure.nmi.com/api/transact.php',
    query: 'https://secure.nmi.com/api/query.php',
    collectJs: 'https://secure.nmi.com/token/Collect.js',
  },
}

// NMI response codes returned in the `response` field of every transact.php
// response:
//   1 = approved
//   2 = declined (do not retry — re-charging same details won't help)
//   3 = error   (validation / auth / business — permanent)
export const RESPONSE_OUTCOME = {
  1: 'approved',
  2: 'declined',
  3: 'error',
}

// Parameters that should be redacted in request logs.
export const NMI_SENSITIVE_PARAMS = [
  'ccnumber',
  'cvv',
  'checkaba',
  'checkaccount',
  'payment_token',
]
