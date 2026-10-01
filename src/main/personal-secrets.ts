import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GoogleSecrets {
  clientId: string; clientSecret: string
  token?: { access: string; refresh: string; expiresAt: number; account: string }
}
export interface SecretCodec { available: () => boolean; encrypt: (text: string) => Buffer; decrypt: (data: Buffer) => string }
/** The Google client and refresh token stay in the OS-encrypted vault, never in agent context. */
export class PersonalSecrets {
  private file: string
  constructor(private base: string, private codec: SecretCodec) { this.file = join(base, 'personal-google-key.json') }
  read(): GoogleSecrets | null {
    if (!existsSync(this.file)) return null
    try {
      const entry = JSON.parse(readFileSync(this.file, 'utf8'))
      if (entry.version !== 1 || typeof entry.value !== 'string') throw Error()
      const data = JSON.parse(this.codec.decrypt(Buffer.from(entry.value, 'base64')))
      if (typeof data.clientId !== 'string' || typeof data.clientSecret !== 'string' ||
        (data.token && (typeof data.token.access !== 'string' || typeof data.token.refresh !== 'string' ||
          typeof data.token.account !== 'string' || !Number.isFinite(data.token.expiresAt)))) throw Error()
      return data
    } catch { throw Error('Cannot read Google credentials on this machine. Restore the OS keychain or the credential file.') }
  }
  write(value: GoogleSecrets): void {
    if (!this.codec.available()) throw Error('An OS keychain is required to save Google credentials. Enable your system keychain and try again.')
    mkdirSync(this.base, { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, value: this.codec.encrypt(JSON.stringify(value)).toString('base64') }), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
}
