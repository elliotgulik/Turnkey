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

function buildRawMessage({ from, to, subject, bodyText, inReplyTo, references }) {
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"'
  ]
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references) lines.push(`References: ${references}`)
  lines.push('', bodyText || '')
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

export async function sendMessage(accessToken, { from, to, subject, bodyText, threadId, inReplyTo, references }) {
  const raw = buildRawMessage({ from, to, subject, bodyText, inReplyTo, references })
  const body = { raw }
  if (threadId) body.threadId = threadId
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('Gmail send failed: ' + await res.text())
  return res.json()
}
