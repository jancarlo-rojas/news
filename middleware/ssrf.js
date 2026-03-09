const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

// IP ranges that must never be reached by server-side fetches (SSRF protection)
const PRIVATE_RANGES = [
  /^127\./,            // loopback v4
  /^10\./,             // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // RFC 1918
  /^192\.168\./,       // RFC 1918
  /^169\.254\./,       // link-local
  /^0\./,              // this network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT
  /^::1$/,             // loopback v6
  /^fc[0-9a-f]{2}:/i, // ULA v6
  /^fe[89ab][0-9a-f]:/i,             // link-local v6
];

function isPrivateIp(ip) {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

/**
 * Validates that a URL:
 *   1. Is syntactically valid
 *   2. Uses http or https
 *   3. Does not resolve to a private / loopback / CGNAT IP (SSRF guard)
 *
 * Returns { ok: true } or { ok: false, error: string }
 */
async function validateFeedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL format.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'URL must use http or https.' };
  }

  // Block IP literals that are private without needing DNS
  if (net.isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) {
      return { ok: false, error: 'Private IP addresses are not allowed.' };
    }
    return { ok: true, parsed };
  }

  // Resolve hostname to detect SSRF through DNS rebinding
  try {
    const { address } = await dns.lookup(parsed.hostname);
    if (isPrivateIp(address)) {
      return { ok: false, error: 'URL resolves to a private or reserved address.' };
    }
  } catch {
    return { ok: false, error: 'Could not resolve hostname.' };
  }

  return { ok: true, parsed };
}

module.exports = { validateFeedUrl };
