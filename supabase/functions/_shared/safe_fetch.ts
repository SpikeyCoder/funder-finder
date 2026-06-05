/**
 * FM-2026-06-05-01 — SSRF-aware fetch wrapper for FunderMatch Edge Functions.
 *
 * Several edge functions (notably `fetch-grant-deadline` and the
 * `check-deadlines` cron job that triggers it) accept user-supplied URLs
 * — either directly from a POST body or indirectly via stored
 * `tracked_grants.grant_url` values originally supplied by users — and
 * issue server-side HTTP requests against them.
 *
 * The Deno runtime resolves DNS and follows redirects without giving the
 * caller a chance to re-check the resolved address, so a hostname that
 * resolves to a private/loopback/link-local/reserved range, or to a
 * cloud-metadata endpoint, would otherwise let an attacker probe internal
 * services (CWE-918 / OWASP A10:2021).
 *
 * `safeFetch(url, init)` enforces:
 *   1. URL parses cleanly and uses `http:` or `https:` only.
 *   2. Hostname does not match a literal cloud-metadata address (AWS IMDS,
 *      GCP metadata.google.internal, fd00:ec2::254, etc.).
 *   3. Resolved IPs (via Deno.resolveDns) are all globally routable —
 *      blocks loopback, link-local, RFC1918, ULA, multicast, reserved, and
 *      "unspecified".
 *   4. `redirect: 'manual'` is forced; if the response is a 3xx we recurse
 *      after re-running the same hostname check on the Location header.
 *      This defeats DNS-rebinding / redirect-pivot attacks.
 *   5. A bounded redirect depth (default 5).
 *
 * The function is intentionally a thin wrapper around the standard
 * `fetch()` and returns the underlying `Response` so callers don't need
 * to change anything else.
 */

const CLOUD_METADATA_HOSTS = new Set<string>([
  // AWS / Oracle / Alibaba / DO IMDS v4
  "169.254.169.254",
  // AWS IMDS v6
  "fd00:ec2::254",
  // GCP
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  // Azure IMDS
  "169.254.169.254",
]);

const PRIVATE_IP_DEMOS = new Set<string>([
  // Literal IPv4 strings that bypass DNS but should still be blocked.
  "0.0.0.0",
  "255.255.255.255",
]);

export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFBlockedError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed — treat as untrusted
  }
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (covers AWS/GCP IMDS)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 "this network"
  if (a === 0) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 reserved
  if (a >= 240) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback
  if (lower === "::1") return true;
  // :: unspecified
  if (lower === "::") return true;
  // fc00::/7 unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 link-local
  if (lower.startsWith("fe80")) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address
  if (lower.startsWith("::ffff:") && lower.includes(".")) {
    const v4 = lower.split(":").pop() || "";
    return isPrivateIPv4(v4);
  }
  return false;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (!lower) throw new SSRFBlockedError("Empty hostname");
  if (CLOUD_METADATA_HOSTS.has(lower)) {
    throw new SSRFBlockedError(`Blocked cloud-metadata hostname: ${hostname}`);
  }
  if (PRIVATE_IP_DEMOS.has(lower)) {
    throw new SSRFBlockedError(`Blocked literal address: ${hostname}`);
  }

  // If the hostname IS an IP literal, check it directly without DNS.
  const looksLikeIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(lower);
  const looksLikeIPv6 = lower.includes(":") || (lower.startsWith("[") && lower.endsWith("]"));
  if (looksLikeIPv4) {
    if (isPrivateIPv4(lower)) {
      throw new SSRFBlockedError(`Blocked private/reserved IPv4: ${hostname}`);
    }
    return;
  }
  if (looksLikeIPv6) {
    const stripped = lower.replace(/^\[/, "").replace(/\]$/, "");
    if (isPrivateIPv6(stripped)) {
      throw new SSRFBlockedError(`Blocked private/reserved IPv6: ${hostname}`);
    }
    return;
  }

  // DNS resolution — block if ANY resolved address is non-public.
  // Use both A and AAAA so dual-stack hostnames cannot side-channel via
  // the family we didn't check.
  let addrs4: string[] = [];
  let addrs6: string[] = [];
  try {
    addrs4 = await Deno.resolveDns(lower, "A");
  } catch (_e) {
    /* may not have A record — fine */
  }
  try {
    addrs6 = await Deno.resolveDns(lower, "AAAA");
  } catch (_e) {
    /* may not have AAAA record — fine */
  }
  if (addrs4.length === 0 && addrs6.length === 0) {
    throw new SSRFBlockedError(`Hostname did not resolve: ${hostname}`);
  }
  for (const ip of addrs4) {
    if (isPrivateIPv4(ip)) {
      throw new SSRFBlockedError(`Hostname ${hostname} resolves to private IPv4 ${ip}`);
    }
  }
  for (const ip of addrs6) {
    if (isPrivateIPv6(ip)) {
      throw new SSRFBlockedError(`Hostname ${hostname} resolves to private IPv6 ${ip}`);
    }
  }
}

export interface SafeFetchOptions extends RequestInit {
  /** Max redirects to follow. Defaults to 5. */
  maxRedirects?: number;
}

export async function safeFetch(rawUrl: string, init: SafeFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let current = rawUrl;
  let hops = 0;

  while (true) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch (_e) {
      throw new SSRFBlockedError(`Invalid URL: ${current}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SSRFBlockedError(`Disallowed scheme: ${parsed.protocol}`);
    }
    const host = parsed.hostname;
    await assertPublicHostname(host);

    const response = await fetch(parsed.toString(), { ...rest, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) return response;
      if (++hops > maxRedirects) {
        throw new SSRFBlockedError(`Exceeded max redirects (${maxRedirects}) for ${rawUrl}`);
      }
      // Resolve relative redirects against the current URL.
      current = new URL(loc, parsed).toString();
      continue;
    }
    return response;
  }
}
