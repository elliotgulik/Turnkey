// AES-256-GCM encryption for OAuth tokens at rest. Not "for show" — even
// though email_accounts has no client-facing RLS policy at all, a leaked
// SUPABASE_SERVICE_ROLE_KEY or a stray query in the SQL editor should still
// not hand over a live Gmail/Microsoft token in plaintext.
import crypto from 'node:crypto'

const KEY_ENV = process.env.EMAIL_TOKEN_KEY || ''

function getKey() {
  if (!KEY_ENV) {
    throw new Error('EMAIL_TOKEN_KEY is not set — required to encrypt/decrypt stored email tokens')
  }
  // Accept either a 64-char hex string or any string (hashed down to 32 bytes) —
  // hashing makes setup forgiving (any random secret works) without weakening
  // a properly-generated 32-byte key.
  if (/^[0-9a-f]{64}$/i.test(KEY_ENV)) return Buffer.from(KEY_ENV, 'hex')
  return crypto.createHash('sha256').update(KEY_ENV).digest()
}

export function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptToken(stored) {
  const buf = Buffer.from(stored, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
