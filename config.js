// TurnKey public config — edit before deploy, or set via Netlify env at build time.
// booking.html reads backendUrl so customer quote requests reach your CRM 24/7.
// index.html reads supabaseUrl/supabaseAnonKey to talk to Supabase directly —
// the anon key is safe to expose client-side, access is enforced by RLS.
// mapsKey (Google Maps Static/Geocoding/Places) is also safe to expose client-side
// as long as it's restricted by HTTP referrer in Google Cloud Console — it's what
// powers satellite view on the booking page and in the CRM automatically.
// SYNC_KEY (the backend access code) deliberately does NOT live here — it stays a
// manual, per-device entry in the CRM's Connections panel so it's never shipped
// to the public site; it's the only thing gating write access to synced CRM state.
window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
  // Set to your deployed backend URL (no trailing slash), e.g.:
  // backendUrl: 'https://turnkey-backend-xxxx.onrender.com',
  backendUrl: 'https://turnkeynova.onrender.com',
  supabaseUrl: 'https://rcighpmdrutnghsqhzlr.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjaWdocG1kcnV0bmdoc3FoemxyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NTQ1MzAsImV4cCI6MjA5ODQzMDUzMH0.Pvzvkxqe65SNTS4aRydo-HTkx6EMPglP1PR1ii4wOho',
  // Set to your Google Maps API key (restrict it by HTTP referrer to your domain), e.g.:
  // mapsKey: 'AIza...',
  mapsKey: '',
};
