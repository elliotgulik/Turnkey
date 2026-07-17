#!/usr/bin/env node
/**
 * Generates config.js from env vars (used by Netlify build).
 * Set TURNKEY_BACKEND_URL in Netlify → Site settings → Environment variables.
 */
import fs from 'node:fs'

const backendUrl = process.env.TURNKEY_BACKEND_URL || ''
const supabaseUrl = process.env.TURNKEY_SUPABASE_URL || ''
const supabaseAnonKey = process.env.TURNKEY_SUPABASE_ANON_KEY || ''

const content = `// Auto-generated at build time — do not edit on Netlify deploys.
window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
  backendUrl: ${JSON.stringify(backendUrl)},
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  supabaseAnonKey: ${JSON.stringify(supabaseAnonKey)},
};
`

fs.writeFileSync('config.js', content)
console.log('Wrote config.js', backendUrl ? `(backend: ${backendUrl})` : '(no backend URL set)', supabaseUrl ? '(supabase configured)' : '(no supabase URL set)')
