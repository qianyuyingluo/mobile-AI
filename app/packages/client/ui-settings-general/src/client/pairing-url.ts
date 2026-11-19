/** Validate the Web launch address before encoding it as a connection QR code. */

/**
 * @param input - The Web launch address displayed by the computer.
 * @returns The normalized token-bearing LAN address, or undefined if the address is unsupported.
 */
export function pairingLaunchUrl(input: string): string | undefined {
  let url: URL
  try { url = new URL(input) }
  catch (_error) { return undefined }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.pathname !== '/' || url.hash) return undefined

  // URL parses and canonicalizes IPv4, including alternate spellings. Restrict
  // the handoff to a concrete local address instead of loopback or wildcard.
  if (!/^(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d+(?:\.\d+){1,2}$/u.test(url.hostname)) return undefined
  const token = url.searchParams.get('token')
  if (token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token) || [...url.searchParams].length !== 1) return undefined
  return url.href
}
