/** Generate a local QR code from the authenticated Web launch address. */
import { useId, useState, type FormEvent } from 'react'
import { toDataURL } from 'qrcode/lib/browser.js'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { pairingLaunchUrl } from './pairing-url.ts'
import css from './PairingSection.module.css'

/**
 * @param props - Standard settings section props and the settings locale seat.
 * @returns The LAN address form and locally rendered QR code.
 */
export function PairingSection({ t }: PropsRuntime<'settings.section'> & PropsLocale<'settings'>) {
  const id = useId()
  const [address, setAddress] = useState('')
  const [qrCode, setQrCode] = useState<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<'pairing.invalid' | 'pairing.failed'>()

  const generate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (pending) return
    const url = pairingLaunchUrl(address)
    if (url === undefined) { setError('pairing.invalid'); return }
    setError(undefined)
    setPending(true)
    try {
      setQrCode(await toDataURL(url, { width: 240, errorCorrectionLevel: 'M' }))
      setAddress('')
    } catch (_error) {
      setError('pairing.failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className={css.section} aria-labelledby={id}>
      <h2 className={css.title} id={id}>{t('pairing.title')}</h2>
      <p className={css.description}>{t('pairing.description')}</p>
      <form className={css.form} onSubmit={event => { void generate(event) }}>
        <label htmlFor={id + '-address'}>{t('pairing.address')}</label>
        <Input id={id + '-address'} type="password" autoComplete="off" spellCheck={false}
          maxLength={512} value={address} disabled={pending} required
          aria-invalid={error === 'pairing.invalid' ? true : undefined}
          aria-describedby={error === undefined ? undefined : id + '-error'}
          onChange={event => { setAddress(event.currentTarget.value); setQrCode(undefined); setError(undefined) }} />
        {error !== undefined && <p className={css.error} id={id + '-error'} role="alert">{t(error)}</p>}
        <div className={css.actions}>
          <Button type="submit" variant="primary" disabled={address.trim().length === 0 || pending}>
            {t('pairing.generate')}
          </Button>
          {qrCode !== undefined && <Button onClick={() => { setQrCode(undefined) }}>{t('pairing.hide')}</Button>}
        </div>
      </form>
      {qrCode !== undefined && <div className={css.result} aria-live="polite">
        <img src={qrCode} width={240} height={240} alt={t('pairing.qr')} />
        <p className={css.description}>{t('pairing.scan')}</p>
      </div>}
    </section>
  )
}
