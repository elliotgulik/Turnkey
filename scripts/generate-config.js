#!/usr/bin/env node
/**
 * Generates config.js from env vars (used by Netlify build).
 * Set TURNKEY_BACKEND_URL, TURNKEY_SUPABASE_URL and TURNKEY_SUPABASE_ANON_KEY
 * in Netlify → Site settings → Environment variables to override the committed
 * config.js. If any of them are missing, the committed config.js is left as-is
 * rather than being overwritten with blank values.
 */
import fs from 'node:fs'

const backendUrl = process.env.TURNKEY_BACKEND_URL || ''
const supabaseUrl = process.env.TURNKEY_SUPABASE_URL || ''
const supabaseAnonKey = process.env.TURNKEY_SUPABASE_ANON_KEY || ''

if (!backendUrl || !supabaseUrl || !supabaseAnonKey) {
  console.log('generate-config.js: TURNKEY_BACKEND_URL/TURNKEY_SUPABASE_URL/TURNKEY_SUPABASE_ANON_KEY not fully set in this environment — leaving the committed config.js untouched.')
  process.exit(0)
}

const content = `// Auto-generated at build time — do not edit on Netlify deploys.
window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
  backendUrl: ${JSON.stringify(backendUrl)},
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  supabaseAnonKey: ${JSON.stringify(supabaseAnonKey)},
};
`

fs.writeFileSync('config.js', content)
console.log(`Wrote config.js (backend: ${backendUrl}) (supabase configured)`)
