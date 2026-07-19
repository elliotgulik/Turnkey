// Google Calendar integration via plain REST calls (native fetch), matching
// the same provider contract shape as providers/gmail.js so both OAuth flows
// share signState()/verifyState()/encryptToken() in index.js.
//
// NOT ACTIVE until GOOGLE_CALENDAR_CLIENT_ID/GOOGLE_CALENDAR_CLIENT_SECRET are
// set in the backend environment — falls back to GMAIL_CLIENT_ID/SECRET if
// those aren't set, since the same Google Cloud OAuth client can request the
// Calendar scope alongside Gmail's; a business only needs a second consent
// screen, not a second Cloud project. isConfigured() gates every route that
// uses this module so the rest of the app works identically either way.

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GMAIL_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || ''
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
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
  if (!res.ok) throw new Error('Google Calendar token exchange failed: ' + await res.text())
  const tok = await res.json()
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  })
  if (!userRes.ok) throw new Error('Google userinfo failed: ' + await userRes.text())
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
  if (!res.ok) throw new Error('Google Calendar token refresh failed: ' + await res.text())
  return res.json()
}

// Pull busy time from the user's primary calendar for availability blocking.
export async function listEvents(accessToken, { timeMinIso, timeMaxIso }) {
  const params = new URLSearchParams({
    timeMin: timeMinIso, timeMax: timeMaxIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '250'
  })
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (res.status === 401) { const e = new Error('Google Calendar auth expired'); e.code = 'AUTH_EXPIRED'; throw e }
  if (!res.ok) throw new Error('Google Calendar list failed: ' + await res.text())
  const data = await res.json()
  return (data.items || [])
    .filter(ev => ev.status !== 'cancelled' && (ev.start?.dateTime || ev.start?.date))
    .map(ev => ({
      externalId: ev.id,
      title: ev.summary || 'Busy',
      start: ev.start.dateTime || ev.start.date,
      end: (ev.end && (ev.end.dateTime || ev.end.date)) || ev.start.dateTime || ev.start.date,
      busyStatus: ev.transparency === 'transparent' ? 'free' : 'busy'
    }))
}

// Push a TurnKey job onto the connected calendar as an event; returns the
// created event's id so it can be updated/deleted when the job changes.
export async function createEvent(accessToken, { summary, description, startIso, endIso, location }) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary, description, location,
      start: { dateTime: startIso }, end: { dateTime: endIso }
    })
  })
  if (!res.ok) throw new Error('Google Calendar create event failed: ' + await res.text())
  return res.json()
}

export async function updateEvent(accessToken, eventId, { summary, description, startIso, endIso, location }) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary, description, location,
      start: startIso ? { dateTime: startIso } : undefined,
      end: endIso ? { dateTime: endIso } : undefined
    })
  })
  if (!res.ok) throw new Error('Google Calendar update event failed: ' + await res.text())
  return res.json()
}

export async function deleteEvent(accessToken, eventId) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error('Google Calendar delete event failed: ' + await res.text())
}
