// Gmail integration via plain REST calls (native fetch) — no googleapis SDK,
// consistent with this backend's existing minimal-dependency style. Gmail
// API already parses MIME into structured JSON, so there's no MIME parser
// to write; only sending needs to build a raw RFC 2822 message.
//
// This module's shape (getAuthUrl/exchangeCode/refreshAccessToken/
// listMessageIds/getMessage/sendMessage) is the contract a future
// providers/microsoft.js should match, so backend/src/email.js can treat
// both providers identically.

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || ''
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
].join(' ')

export const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET)

export function getAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', state
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    })
  })
  if (!res.ok) throw new Error('Gmail token exchange failed: ' + await res.text())
  const tok = await res.json()
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  })
  if (!userRes.ok) throw new Error('Gmail userinfo failed: ' + await userRes.text())
  const user = await userRes.json()
  return { ...tok, email: user.email }
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  })
  if (!res.ok) throw new Error('Gmail token refresh failed: ' + await res.text())
  return res.json() // {access_token, expires_in, scope, token_type}
}

function headerVal(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : ''
}

function extractBody(payload) {
  let html = '', text = ''
  function walk(part) {
    if (!part) return
    const mime = part.mimeType || ''
    if (mime === 'text/html' && part.body?.data) html += Buffer.from(part.body.data, 'base64url').toString('utf8')
    else if (mime === 'text/plain' && part.body?.data) text += Buffer.from(part.body.data, 'base64url').toString('utf8')
    else if (part.parts) part.parts.forEach(walk)
  }
  walk(payload)
  if (!html && !text && payload?.body?.data) text = Buffer.from(payload.body.data, 'base64url').toString('utf8')
  return { html, text }
}

export async function listMessageIds(accessToken, { afterUnix } = {}) {
  const params = new URLSearchParams({ maxResults: '25' })
  if (afterUnix) params.set('q', `after:${afterUnix}`)
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (res.status === 401) { const e = new Error('Gmail auth expired'); e.code = 'AUTH_EXPIRED'; throw e }
  if (!res.ok) throw new Error('Gmail list failed: ' + await res.text())
  const data = await res.json()
  return (data.messages || []).map(m => m.id)
}

export async function getMessage(accessToken, id) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new Error('Gmail get message failed: ' + await res.text())
  const msg = await res.json()
  const headers = msg.payload?.headers || []
  const { html, text } = extractBody(msg.payload)
  return {
    id: msg.id, threadId: msg.threadId, snippet: msg.snippet,
    from: headerVal(headers, 'From'), to: headerVal(headers, 'To'),
    subject: headerVal(headers, 'Subject'), messageId: headerVal(headers, 'Message-ID'),
    date: headerVal(headers, 'Date'), bodyHtml: html, bodyText: text,
    isSentByUs: (msg.labelIds || []).includes('SENT')
  }
}

// RFC 2047 "encoded word" — Subject (and other structured headers) must be
// pure ASCII on the wire; this is what lets a subject contain — or emoji.
function encodeHeaderValue(v) {
  if (/^[\x20-\x7e]*$/.test(v)) return v // already plain ASCII, nothing to do
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?='
}

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
export function validateAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 10) throw new Error('Use at most 10 attachments')
  let total = 0
  return attachments.map(a => {
    if (!a || typeof a.contentBase64 !== 'string' || (a.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.contentBase64))) throw new Error('Invalid attachment data')
    if (a.contentBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new Error('Attachments must total at most 12 MB')
    const bytes = Buffer.from(a.contentBase64, 'base64')
    if (bytes.toString('base64') !== a.contentBase64) throw new Error('Invalid attachment data')
    total += bytes.length
    if (!bytes.length || total > MAX_ATTACHMENT_BYTES) throw new Error('Attachments must total at most 12 MB')
    const mimeType = a.mimeType || 'application/octet-stream'
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)) throw new Error('Invalid attachment type')
    return { filename: String(a.filename || 'attachment').slice(0, 180).replace(/[^\w.\- ]/g, '_'), mimeType, contentBase64: bytes.toString('base64') }
  })
}

export function buildRawMessage({ from, to, subject, bodyText, bodyHtml, inReplyTo, references, attachment, attachments = [] }) {
  for (const v of [from, to, subject, inReplyTo, references]) {
    if (v != null && (typeof v !== 'string' || /[\r\n]/.test(v))) throw new Error('Invalid email header')
  }
  const files = validateAttachments(attachment ? [...attachments, attachment] : attachments)
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${encodeHeaderValue(subject || '')}`, 'MIME-Version: 1.0']
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  if (references) headers.push(`References: ${references}`)
  const alt = 'turnkey_alt_' + Math.random().toString(36).slice(2)
  const encoded = v => (Buffer.from(v || '', 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\r\n')
  const plain = bodyText || (bodyHtml || '').replace(/<[^>]+>/g, ' ')
  const alternatives = [
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded(plain),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded(bodyHtml || '<pre>' + plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>'), `--${alt}--`
  ]
  if (!files.length) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`)
    return Buffer.from([...headers, '', ...alternatives].join('\r\n')).toString('base64url')
  }
  const mix = 'turnkey_mix_' + Math.random().toString(36).slice(2)
  headers.push(`Content-Type: multipart/mixed; boundary="${mix}"`)
  const parts = [`--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternatives]
  for (const file of files) parts.push(`--${mix}`, `Content-Type: ${file.mimeType}; name="${file.filename}"`, `Content-Disposition: attachment; filename="${file.filename}"`, 'Content-Transfer-Encoding: base64', '', file.contentBase64.match(/.{1,76}/g).join('\r\n'))
  parts.push(`--${mix}--`)
  return Buffer.from([...headers, '', ...parts].join('\r\n')).toString('base64url')
}

export async function sendMessage(accessToken, { from, to, subject, bodyText, bodyHtml, threadId, inReplyTo, references, attachment, attachments }) {
  const raw = buildRawMessage({ from, to, subject, bodyText, bodyHtml, inReplyTo, references, attachment, attachments })
  const body = { raw }
  if (threadId) body.threadId = threadId
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'Gmail connection expired; reconnect in Connections' : 'Gmail rejected the message (' + res.status + ')')
    err.code = 'SEND_REJECTED'; err.status = res.status; throw err
  }
  const sent = await res.json()
  if (!sent.id) throw new Error('Gmail did not confirm a message ID')
  return sent
}
