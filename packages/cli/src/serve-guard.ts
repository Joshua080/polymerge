/**
 * Request checks for the local viewer server (`polymerge view` / `review` / `demo`). Why each
 * one exists: docs/write-back-security.md (§4.1 cross-site requests, §4.2 DNS rebinding, §4.3
 * the token, §4.4 binding, §4.9 static files).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import path from 'node:path';

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** 127.0.0.0/8, ::1, and their IPv4-mapped forms (::ffff:127.0.0.1). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const type = net.isIP(address);
  return type !== 0 && LOOPBACK.check(address, type === 4 ? 'ipv4' : 'ipv6');
}

/** The host part of a URL: IPv6 literals in brackets. */
export function urlHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** Hostname and port of a Host header value (or an Origin's authority); null when malformed. */
function authority(value: string): { hostname: string; port: number } | null {
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return null;
  }
  // Anything beyond host[:port] (a path, credentials, a query) is not a Host header.
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || `${value}`.includes('/')) return null;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { hostname, port: url.port === '' ? 80 : Number(url.port) };
}

/**
 * DNS-rebinding check, on EVERY request: the Host header must name this server — `localhost`
 * or an IP literal, with the server's port. A rebinding page's requests carry the attacker's
 * DNS name. `loopbackOnly` (the write routes) also refuses non-loopback IP literals.
 */
export function hostAllowed(host: string | undefined, port: number, loopbackOnly = false): boolean {
  if (!host) return false;
  const a = authority(host);
  if (!a || a.port !== port) return false;
  if (a.hostname === 'localhost') return true;
  return loopbackOnly ? isLoopbackAddress(a.hostname) : net.isIP(a.hostname) !== 0;
}

/** The origins the viewer itself runs on, for a server on `port`. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin || !origin.startsWith('http://')) return false;
  return hostAllowed(origin.slice('http://'.length), port, true);
}

/**
 * Fetch metadata: when the browser says where a request came from (all current browsers
 * send Sec-Fetch-Site), it must be this origin. Absent → not a browser, other checks apply.
 */
export function fetchSiteAllowed(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

/** A session token: 32 bytes from the OS CSPRNG, base64url. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time token comparison, independent of the given token's length. */
export function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Headers every response carries (§4.1, §4.9). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'none'",
};

/**
 * The files the static route may serve: every regular file under `root` (symlinks and other
 * special files are skipped, never followed), keyed by its URL path ("/assets/x.js"). Requests
 * are answered by exact lookup, so nothing derived from a request reaches the file system.
 */
export function staticAllowlist(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const st = lstatSync(file);
      if (st.isDirectory()) walk(file, `${prefix}${name}/`);
      else if (st.isFile()) out.set(`${prefix}${name}`, file);
    }
  };
  walk(root, '/');
  return out;
}

/** URL pathname → allowlisted file, or null. "/" is index.html; malformed escapes are null. */
export function staticFile(allowlist: ReadonlyMap<string, string>, pathname: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return null;
  }
  return allowlist.get(key) ?? null;
}
