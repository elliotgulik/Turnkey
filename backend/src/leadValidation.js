// Shared shape/size validation for every lead-intake path (the public
// booking-page route AND the Wix/Meta webhook routes) — one source of
// truth so a webhook-sourced lead is held to exactly the same bounds as a
// customer-submitted one, rather than a second, possibly-drifting copy of
// the same rules. Deliberately permissive on content (this isn't the place
// to second-guess a legitimate customer's address or notes), just bounds
// the shape so a scripted attacker (or a misbehaving webhook) can't stuff
// huge arrays/strings into a single lead.
export function validateLeadPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Invalid lead payload'
  const c = payload.customer
  if (!c || typeof c !== 'object') return 'Invalid lead payload'
  if (!c.name || typeof c.name !== 'string' || c.name.length > 200) return 'A valid name is required'
  if (c.email && (typeof c.email !== 'string' || c.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))) return 'That email address doesn\'t look right'
  if (c.phone && (typeof c.phone !== 'string' || c.phone.length > 40)) return 'That phone number doesn\'t look right'
  if (c.address && (typeof c.address !== 'string' || c.address.length > 500)) return 'That address is too long'
  if (c.notes && (typeof c.notes !== 'string' || c.notes.length > 4000)) return 'Notes are too long'
  if (payload.areas) {
    if (!Array.isArray(payload.areas) || payload.areas.length > 100) return 'Too many mapped areas'
    for (const a of payload.areas) {
      if (a && Array.isArray(a.points) && a.points.length > 500) return 'A mapped area has too many points'
    }
  }
  if (payload.photos && (!Array.isArray(payload.photos) || payload.photos.length > 12)) return 'Too many photos'
  return null
}
