/** URL comparison, shared by the runner, replay and the explorer. */

/**
 * Is this URL the page we are already looking at?
 *
 * A trailing slash and a fragment make no difference to which page a person is
 * on, so neither should make the engine load it again.
 */
export function sameTarget(current: string, wanted: string, base: string): boolean {
  const normalise = (u: string): string => {
    try {
      const url = new URL(u, base)
      url.hash = ''
      if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '')
      return url.href
    } catch {
      return u
    }
  }
  return normalise(current) === normalise(wanted)
}

/** example.co.uk → example.co.uk ; a.b.example.com → example.com */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.')
  if (parts.length <= 2) return parts.join('.')
  const twoLevelTlds = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])
  const last = parts[parts.length - 1]
  const second = parts[parts.length - 2]
  if (last.length === 2 && twoLevelTlds.has(second)) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

/**
 * Same site as the application under test?
 *
 * Used to decide whose server errors and script exceptions are worth
 * reporting: a third-party analytics script failing is not a defect the user
 * can do anything about, and reporting it is noise.
 */
export function isFirstParty(url: string, baseUrl: string): boolean {
  try {
    return registrableDomain(new URL(url).hostname) === registrableDomain(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}
