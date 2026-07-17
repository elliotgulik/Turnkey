# Turnkey — MVP install & run

The minimum viable Turnkey: pipeline, quoting, scheduling, jobs, invoicing,
customer booking, backend sync. Marketing and Accounting are hidden for the
MVP; they can be turned on later.

## Option 1 — just open it
Double-click `index.html`. Everything works and your data persists in that
browser. Hosting is only needed for app install / offline mode.

## Option 2 — install it as an app (2 minutes, free)
1. Go to **https://app.netlify.com/drop**
2. Drag this whole folder onto the page
3. Open the URL Netlify gives you on your phone
4. **iPhone:** Share → *Add to Home Screen* · **Android/Chrome:** Install prompt
5. Runs full-screen with the Turnkey icon, works offline.

## Sending emails and texts — how it works today
When you tap **Send now** on a follow-up, or **Send** on a quote or invoice:
- If the customer has an email address → your phone/desktop email app opens
  with the message pre-filled. One tap sends from your real inbox.
- If a follow-up is set to Text → your Messages app opens the same way.

No OAuth, no accounts, no verification. It just works.

Later, once Google approves your Gmail OAuth app (see below), sending becomes
fully automatic — no need to open your email app at all.

## Connections (button in header)
- **Backend** — sync your phone + laptop, plus 24/7 lead inbox for your
  website (see `turnkey-backend-mvp/` for setup)
- **Weather** — live already, no key needed
- **Satellite maps** — paste a Google Maps key, real satellite loads for
  every customer's address
- **Gmail** — auto-send when Google approves your OAuth app (dormant now,
  code ready)

## Data
- Auto-saves per device
- Sync via the backend once connected
- Backup / Restore buttons in header

## What's hidden for MVP
- Accounting tab (code intact, just hidden)
- Marketing tab (code intact, just hidden)
- Meta and Xero connections (not shown in Connections)
