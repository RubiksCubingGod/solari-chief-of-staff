/**
 * The domain allowlist: the hosts a task may take the browser to.
 *
 * A task carries its own list, and the guard checks every top-level
 * navigation against it below the mission: a playbook step - or, in s6, a
 * model's tool call - asks the browser to go somewhere, and the browser
 * refuses before a request leaves. An entry admits the host and every host
 * under it, so `example.com` covers `www.example.com` and
 * `checkout.example.com`. Ports are not part of the decision: a lane is a
 * site, not a socket.
 */

/** Hostnames, as written in a task's input. Case, a leading `*.` and a trailing dot are ignored. */
export type DomainAllowlist = readonly string[];

export type AllowlistVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** `host`: a web URL to a host not on the list. `scheme`: not a web URL. `unparseable`: not a URL. */
      readonly reason: 'host' | 'scheme' | 'unparseable';
      readonly host: string | undefined;
    };

/**
 * Documents a page reaches without going anywhere: where a fresh page starts,
 * and the documents a page builds for itself. None of them is a site.
 */
const INERT_SCHEMES: ReadonlySet<string> = new Set(['about:', 'data:', 'blob:']);
const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

export function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith('*.')) normalized = normalized.slice(2);
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  return normalized;
}

/** Whether `host` is one of the allowlist's hosts or lies under one of them. */
export function hostAllowed(host: string, allowlist: DomainAllowlist): boolean {
  const candidate = normalizeHost(host);
  if (candidate === '') return false;
  return allowlist.some((entry) => {
    const allowed = normalizeHost(entry);
    return allowed !== '' && (candidate === allowed || candidate.endsWith(`.${allowed}`));
  });
}

export function checkUrl(url: string, allowlist: DomainAllowlist): AllowlistVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'unparseable', host: undefined };
  }
  if (INERT_SCHEMES.has(parsed.protocol)) return { allowed: true };
  if (!WEB_SCHEMES.has(parsed.protocol)) return { allowed: false, reason: 'scheme', host: undefined };
  return hostAllowed(parsed.hostname, allowlist)
    ? { allowed: true }
    : { allowed: false, reason: 'host', host: parsed.hostname };
}
