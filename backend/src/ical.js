// Minimal iCalendar (RFC 5545) parser for read-only availability blocking —
// enough to turn an iCloud/Google/Outlook "public calendar" ICS feed URL into
// busy-time rows in calendar_events. Deliberately not a full RFC 5545 engine:
// - Only DTSTART/DTEND/SUMMARY/UID/RRULE are read; everything else is ignored.
// - RRULE support covers FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
//   COUNT and UNTIL. BYDAY/BYSETPOS/BYMONTHDAY and other selector rules are
//   NOT supported — such events are still imported as a single occurrence
//   (their DTSTART) rather than silently dropped, so nothing disappears, it
//   just won't repeat. This is a documented limitation, not a bug.
// - Occurrences are expanded only up to EXPAND_HORIZON_DAYS ahead, so a
//   feed with a "forever" recurring event doesn't produce unbounded rows.

const EXPAND_HORIZON_DAYS = 180

function unfoldLines(text) {
  // RFC 5545: a line starting with a space/tab is a continuation of the previous line
  const raw = text.split(/\r\n|\n|\r/)
  const out = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

function parseIcsDate(value, params) {
  // value like 20260117T093000Z, 20260117T093000, or 20260117 (all-day)
  const v = value.trim()
  const isDate = params.includes('VALUE=DATE') || /^\d{8}$/.test(v)
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (isDate) return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true }
  const iso = `${y}-${mo}-${d}T${h || '00'}:${mi || '00'}:${s || '00'}${z ? 'Z' : ''}`
  return { date: new Date(iso), allDay: false }
}

function parseRRule(str) {
  const parts = {}
  str.split(';').forEach(p => { const [k, v] = p.split('='); if (k && v) parts[k] = v })
  return parts
}

function addInterval(date, freq, interval) {
  const d = new Date(date)
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval)
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + interval * 7)
  else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval)
  else if (freq === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + interval)
  else return null // unsupported FREQ — caller falls back to single occurrence
  return d
}

// Expands one VEVENT into concrete {start,end} occurrences within the horizon.
function expandEvent(ev, horizonEnd) {
  const durationMs = ev.dtend ? (ev.dtend.date.getTime() - ev.dtstart.date.getTime()) : 60 * 60 * 1000
  if (!ev.rrule) return [{ start: ev.dtstart.date, end: new Date(ev.dtstart.date.getTime() + durationMs), allDay: ev.dtstart.allDay }]

  const freq = ev.rrule.FREQ
  const interval = Math.max(1, parseInt(ev.rrule.INTERVAL || '1', 10))
  const count = ev.rrule.COUNT ? parseInt(ev.rrule.COUNT, 10) : null
  const until = ev.rrule.UNTIL ? parseIcsDate(ev.rrule.UNTIL, [])?.date : null
  const supported = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)
  if (!supported) return [{ start: ev.dtstart.date, end: new Date(ev.dtstart.date.getTime() + durationMs), allDay: ev.dtstart.allDay }]

  const occurrences = []
  let cur = ev.dtstart.date
  let n = 0
  while (cur.getTime() <= horizonEnd.getTime()) {
    if (until && cur.getTime() > until.getTime()) break
    if (count && n >= count) break
    occurrences.push({ start: cur, end: new Date(cur.getTime() + durationMs), allDay: ev.dtstart.allDay })
    n++
    const next = addInterval(cur, freq, interval)
    if (!next) break
    cur = next
  }
  return occurrences
}

// Parses raw ICS text into a flat list of {externalId, title, start, end, allDay}
// busy-time occurrences, expanded up to EXPAND_HORIZON_DAYS ahead of now.
export function parseIcs(text) {
  const lines = unfoldLines(text)
  const events = []
  let cur = null
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const left = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [name, ...paramParts] = left.split(';')

    if (name === 'BEGIN' && value === 'VEVENT') { cur = { params: paramParts }; continue }
    if (name === 'END' && value === 'VEVENT') { if (cur && cur.dtstart) events.push(cur); cur = null; continue }
    if (!cur) continue

    if (name === 'UID') cur.uid = value
    else if (name === 'SUMMARY') cur.summary = value.replace(/\\,/g, ',').replace(/\\n/gi, ' ')
    else if (name === 'DTSTART') cur.dtstart = parseIcsDate(value, paramParts)
    else if (name === 'DTEND') cur.dtend = parseIcsDate(value, paramParts)
    else if (name === 'RRULE') cur.rrule = parseRRule(value)
  }

  const now = new Date()
  const horizonEnd = new Date(now.getTime() + EXPAND_HORIZON_DAYS * 24 * 60 * 60 * 1000)
  const out = []
  events.forEach((ev, i) => {
    if (!ev.dtstart) return
    const occs = expandEvent(ev, horizonEnd)
    occs.forEach((occ, j) => {
      out.push({
        externalId: (ev.uid || 'event-' + i) + '-' + occ.start.toISOString().slice(0, 10) + '-' + j,
        title: ev.summary || 'Busy',
        start: occ.start.toISOString(),
        end: occ.end.toISOString()
      })
    })
  })
  return out
}

export async function fetchIcs(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'TurnKey/1.0 (calendar sync)' } })
  if (!res.ok) throw new Error('Fetch failed: HTTP ' + res.status)
  const text = await res.text()
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not a valid iCalendar feed')
  return parseIcs(text)
}
