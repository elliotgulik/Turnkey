// TurnKey public config — edit before deploy, or set via Netlify env at build time.
// booking.html reads backendUrl so customer quote requests reach your CRM 24/7.
// index.html reads supabaseUrl/supabaseAnonKey to talk to Supabase directly —
// the anon key is safe to expose client-side, access is enforced by RLS.
window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
  // Set to your deployed backend URL (no trailing slash), e.g.:
  // backendUrl: 'https://turnkey-backend-xxxx.onrender.com',
  backendUrl: 'https://turnkeynova.onrender.com',
  supabaseUrl: 'https://rcighpmdrutnghsqhzlr.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjaWdocG1kcnV0bmdoc3FoemxyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NTQ1MzAsImV4cCI6MjA5ODQzMDUzMH0.Pvzvkxqe65SNTS4aRydo-HTkx6EMPglP1PR1ii4wOho',
};
