#!/usr/bin/env node
/**
 * Generates config.js from env vars (used by Netlify build).
 * Set TURNKEY_BACKEND_URL, TURNKEY_SUPABASE_URL and TURNKEY_SUPABASE_ANON_KEY
 * (and TURNKEY_MAPS_KEY, for Google Maps) in Netlify → Site settings →
 * Environment variables to override the committed config.js. If any of the
 * required three are missing, the committed config.js is left as-is rather
 * than being overwritten with blank values.
 *
 * mapsKey is handled differently on purpose: a build that has the three
 * required vars set but NOT TURNKEY_MAPS_KEY still goes ahead and writes a
 * new config.js (correctly — backend/Supabase config should still deploy).
 * The bug this fixes: that write used to hardcode mapsKey to whatever
 * TURNKEY_MAPS_KEY resolved to in THIS build, including '' if it wasn't
 * set — silently erasing a real key from every previous deploy the moment
 * a build ran without that one env var present. Now, if TURNKEY_MAPS_KEY
 * isn't set, the key already sitting in the current config.js is carried
 * forward instead of being blanked — a key only ever ends up empty here if
 * it was never configured anywhere, never as a side effect of one build.
 */
import fs from 'node:fs'

const backendUrl = process.env.TURNKEY_BACKEND_URL || ''
const supabaseUrl = process.env.TURNKEY_SUPABASE_URL || ''
const supabaseAnonKey = process.env.TURNKEY_SUPABASE_ANON_KEY || ''

if (!backendUrl || !supabaseUrl || !supabaseAnonKey) {
  console.log('generate-config.js: TURNKEY_BACKEND_URL/TURNKEY_SUPABASE_URL/TURNKEY_SUPABASE_ANON_KEY not fully set in this environment — leaving the committed config.js untouched.')
  process.exit(0)
}

let mapsKey = process.env.TURNKEY_MAPS_KEY || ''
let mapsKeySource = mapsKey ? 'TURNKEY_MAPS_KEY env var' : null
if (!mapsKey) {
  try {
    const existing = fs.readFileSync('config.js', 'utf8')
    const match = existing.match(/mapsKey:\s*(['"])((?:(?!\1).)*)\1/)
    if (match && match[2]) {
      mapsKey = match[2]
      mapsKeySource = 'preserved from existing config.js'
    }
  } catch {
    // no existing config.js to read from — nothing to preserve, mapsKey stays ''
  }
}

const content = `// Auto-generated at build time — do not edit on Netlify deploys.
window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
  backendUrl: ${JSON.stringify(backendUrl)},
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  supabaseAnonKey: ${JSON.stringify(supabaseAnonKey)},
  mapsKey: ${JSON.stringify(mapsKey)},
};
`

fs.writeFileSync('config.js', content)
console.log(`Wrote config.js (backend: ${backendUrl}) (supabase configured)`, mapsKey ? `(maps configured — ${mapsKeySource})` : '(no maps key set anywhere — Google Maps will stay off until TURNKEY_MAPS_KEY is set in Netlify)')
