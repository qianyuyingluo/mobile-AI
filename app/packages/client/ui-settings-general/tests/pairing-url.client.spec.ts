import { describe, expect, it } from 'vitest'
import { pairingLaunchUrl } from '../src/client/pairing-url.ts'

const token = 'a'.repeat(43)

describe('pairingLaunchUrl', () => {
  it.each(['192.168.1.20:4310', '10.2.0.30', '172.16.0.2', '172.31.0.2', '169.254.8.2'])(
    'accepts a token-bearing Web launch address on %s',
    (host) => {
      const launchUrl = `http://${host}/?token=${token}`
      expect(pairingLaunchUrl(`  ${launchUrl}\n`)).toBe(launchUrl)
    },
  )

  it.each(['127.0.0.1', '127.1', '[::1]', 'localhost', '0.0.0.0', '172.32.0.2', 'example.com', '192.168.example.com'])(
    'rejects a host other than a concrete LAN IPv4 address (%s)',
    (host) => { expect(pairingLaunchUrl(`http://${host}/?token=${token}`)).toBeUndefined() },
  )

  it.each([
    'not a URL',
    'http://192.168.1.20/',
    `ftp://192.168.1.20/?token=${token}`,
    `https://user:password@192.168.1.20/?token=${token}`,
    `http://192.168.1.20/api/connect?token=${token}`,
    `http://192.168.1.20/?token=${token}&token=${token}`,
    `http://192.168.1.20/?token=${token}#fragment`,
  ])('rejects a URL without the Web launch format', (url) => { expect(pairingLaunchUrl(url)).toBeUndefined() })
})
