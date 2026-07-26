// Push notifications via OneSignal (Web Push) — not Firebase, per the
// stack decision. This module is a pure function, same shape as
// providers/gmail.js / providers/googleCalendar.js: it doesn't hold its
// own Supabase client, the caller (index.js, which already has authClient)
// passes one in — mirrors how every other backend module in this app talks
// to Supabase.
//
// isConfigured() gates every route that uses this, same pattern as
// isStripeConfigured()/isAiConfigured() in index.js — a business/deployment
// missing ONESIGNAL_APP_ID/ONESIGNAL_API_KEY still boots and works
// normally, push just quietly does nothing until those are set.

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || ''
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || '' // REST API key, never exposed to the frontend — only the App ID is public

export const isConfigured = () => !!(ONESIGNAL_APP_ID && ONESIGNAL_API_KEY)

// Actually calls OneSignal's REST API. Targets specific subscription ids
// (not a broadcast/segment) so a push only ever reaches devices that
// belong to this business — resolved by the caller from
// notification_subscriptions before this is called.
async function pushToOneSignal(subscriptionIds, { title, message, url }) {
  if (!subscriptionIds.length) return { ok: true, skipped: 'no_subscriptions' }
  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + ONESIGNAL_API_KEY
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_subscription_ids: subscriptionIds,
      headings: { en: title },
      contents: { en: message },
      url: url || undefined
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error('OneSignal API error: ' + (body.errors ? JSON.stringify(body.errors) : res.status))
  return body
}

// The one function every event hook (new lead, quote approved, job booked,
// payment received, invoice overdue...) calls. Never throws — a failed
// push should never take down the caller's own request (e.g. saving a
// lead must still succeed even if OneSignal is down); every failure is
// logged and swallowed here, matching notifyOwner()'s "notifications are a
// convenience layer, never a blocker" principle on the frontend.
//
//   sendNotification(supabase, {
//     business_id, type, title, message, url,
//     user_id,          // optional — target one specific user's devices instead of the whole business
//   })
export async function sendNotification(supabase, { business_id, type, title, message, url, user_id }) {
  if (!business_id || !title || !message) {
    console.error('sendNotification: missing required field(s)', { business_id, title, message })
    return { ok: false, error: 'missing_required_field' }
  }

  // Always log to the in-app notification centre (Phase 5), independent of
  // whether push actually goes out — a business that's never turned on
  // push (or hasn't granted browser permission) still gets full history.
  const { error: logErr } = await supabase.from('notifications').insert({
    business_id, user_id: user_id || null, type: type || 'general', title, message, url: url || null
  })
  if (logErr) console.error('sendNotification: failed to log notification', type, logErr)

  if (!isConfigured()) return { ok: true, skipped: 'onesignal_not_configured' }

  try {
    // Settings → Notifications lets a business turn push off for one
    // specific event type (e.g. "Quote viewed" pushes but "Invoice
    // overdue" doesn't) — respected here, not just at the UI layer. No row
    // for this event yet defaults to on (matches the UI's own
    // `!pref||pref.push_enabled!==false` default-on read in index.html).
    if (type) {
      const { data: pref } = await supabase.from('notification_preferences')
        .select('push_enabled').eq('business_id', business_id).eq('event', type).maybeSingle()
      if (pref && pref.push_enabled === false) return { ok: true, skipped: 'push_disabled_for_event' }
    }

    let q = supabase.from('notification_subscriptions').select('onesignal_subscription_id').eq('business_id', business_id).eq('enabled', true)
    if (user_id) q = q.eq('user_id', user_id)
    const { data: subs, error: subErr } = await q
    if (subErr) throw subErr
    const ids = (subs || []).map(s => s.onesignal_subscription_id)
    const result = await pushToOneSignal(ids, { title, message, url })
    return { ok: true, sentTo: ids.length, result }
  } catch (err) {
    console.error('sendNotification: OneSignal push failed', type, business_id, err.message)
    return { ok: false, error: err.message }
  }
}
