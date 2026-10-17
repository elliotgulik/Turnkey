// TurnKey API client for the Chrome extension.
//
// Deliberately hand-rolled REST calls instead of bundling @supabase/supabase-js
// — this mirrors quote.html's own callRpc()/fetch() pattern (see
// quote.html:178-189), which is already how the rest of this no-build-step
// codebase talks to Supabase from a page that isn't the full CRM SPA. Manifest
// V3 also forbids remotely-hosted code, so vendoring the whole SDK would mean
// shipping/maintaining a local bundle for a handful of endpoints this file
// already covers directly.
//
// Auth model: sign in with the operator's own TurnKey email/password via
// Supabase's password grant (the exact credential index.html's
// sb.auth.signInWithPassword() uses under the hood) and keep the resulting
// access/refresh token pair in chrome.storage.local. Every table call below
// sends that access token as the Authorization bearer — RLS's
// current_business_id()/current_business_role() (see
// backend/supabase/fix-rls-recursion.sql) then scopes every read/write to the
// signed-in operator's own business exactly the way it scopes index.html,
// with no extension-specific server code required.

/**
 * Fetches and parses a TurnKey deployment's public config.js — the same file
 * index.html/booking.html/quote.html load for backendUrl/supabaseUrl/
 * supabaseAnonKey/mapsKey. These are documented in config.js itself as safe
 * to expose client-side (anon key + RLS, maps key + HTTP-referrer
 * restriction), so reading them at runtime from the business's own deployed
 * site — rather than hardcoding any one business's values into the extension
 * — is how the extension supports whatever TurnKey site the operator points
 * it at, and stays correct if that business ever rotates its anon key.
 */
// Pulls one `key: 'value'`/`key: "value"` pair out of the config object
// literal's source text. Deliberately not a dynamic-code-execution parse
// (the kind MV3's default extension-pages CSP forbids outright) — and
// executing a string fetched over the network (even from a
// site the operator trusts) is a bigger blast radius than this needs: every
// field config.js actually exposes is a plain string literal, so a single
// allowlisted regex per known key is both sufficient and exactly as safe as
// generate-config.js's own symmetric read of this same file (see its
// mapsKey/onesignalAppId carry-forward regexes).
function extractConfigString(source, key) {
  const match = source.match(new RegExp(key + "\\s*:\\s*(['\"])((?:(?!\\1).)*)\\1"));
  return match ? match[2] : '';
}

export async function fetchSiteConfig(siteUrl) {
  const base = siteUrl.replace(/\/+$/, '');
  const res = await fetch(base + '/config.js', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not reach ' + base + ' (HTTP ' + res.status + ')');
  const text = await res.text();
  if (!/window\.TURNKEY_CONFIG\s*=/.test(text)) {
    throw new Error('That site does not look like a TurnKey deployment (no config.js found)');
  }
  const supabaseUrl = extractConfigString(text, 'supabaseUrl');
  const supabaseAnonKey = extractConfigString(text, 'supabaseAnonKey');
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('That site\'s config.js is missing supabaseUrl/supabaseAnonKey');
  }
  return {
    siteUrl: base,
    backendUrl: extractConfigString(text, 'backendUrl'),
    supabaseUrl,
    supabaseAnonKey,
    mapsKey: extractConfigString(text, 'mapsKey')
  };
}

export class TurnKeyClient {
  /**
   * @param {{supabaseUrl:string, supabaseAnonKey:string, backendUrl?:string}} cfg
   * @param {{accessToken:string, refreshToken:string}|null} session
   */
  /**
   * @param {*} cfg
   * @param {*} session
   * @param {(session:object)=>void} [onSessionChange] Called with the fresh
   *   session whenever signIn()/refresh() succeeds. Supabase ROTATES the
   *   refresh token on every use — without persisting the new one, any
   *   other context holding the now-stale token (e.g. the popup, if the
   *   content script refreshed first) would fail to refresh and force a
   *   full re-sign-in. Wire this to Storage.setSession() at the call site.
   */
  constructor(cfg, session, onSessionChange) {
    this.cfg = cfg;
    this.session = session || null;
    this.onSessionChange = onSessionChange || (() => {});
  }

  async signIn(email, password) {
    const res = await fetch(this.cfg.supabaseUrl + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.cfg.supabaseAnonKey },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user.id,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
    this.onSessionChange(this.session);
    return this.session;
  }

  async refresh() {
    if (!this.session || !this.session.refreshToken) throw new Error('Not signed in');
    const res = await fetch(this.cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.cfg.supabaseAnonKey },
      body: JSON.stringify({ refresh_token: this.session.refreshToken })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Session expired — please sign in again');
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user ? data.user.id : this.session.userId,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
    this.onSessionChange(this.session);
    return this.session;
  }

  async _ensureFreshSession() {
    if (!this.session) throw new Error('Not signed in');
    if (this.session.expiresAt - Date.now() < 60000) await this.refresh();
  }

  async _rest(path, opts = {}) {
    await this._ensureFreshSession();
    const res = await fetch(this.cfg.supabaseUrl + '/rest/v1/' + path, {
      ...opts,
      headers: {
        apikey: this.cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + this.session.accessToken,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (res.status === 204 && res.ok) return null;
    const text=await res.text();
    let body=null;
    if(text.trim()){
      try{body=JSON.parse(text);}
      catch{throw new Error('TurnKey returned an unreadable response (HTTP '+res.status+'). Please retry; an existing draft will be reused.');}
    }
    if (!res.ok) {
      body ||= {};
      throw new Error(body.message || body.error_description || ('Request failed (HTTP ' + res.status + ')'));
    }
    // PostgREST return=minimal commonly uses 201 with NO body, not 204.
    // A successful note write must not make an already saved quote fail.
    if(body===null && (opts.method||'GET')==='GET')throw new Error('TurnKey returned no data for this read. Please retry.');
    return body;
  }

  /** business_id + role for the signed-in user — same lookup as index.html's resolveProfile(). */
  async getProfile() {
    await this._ensureFreshSession();
    const rows = await this._rest('users?id=eq.' + this.session.userId + '&select=business_id,role,name,email');
    const row = rows && rows[0];
    return row && row.business_id ? row : { business_id: this.session.userId, role: 'owner' };
  }

  async getBusiness(businessId) {
    const rows = await this._rest('businesses?id=eq.' + encodeURIComponent(businessId) + '&select=*');
    return rows && rows[0] ? rows[0] : null;
  }

  /** Substring search over this business's customers — same client-side-filter model index.html uses (no server-side search endpoint exists). */
  async listCustomers(businessId) {
    return this._rest('customers?business_id=eq.' + encodeURIComponent(businessId) + '&select=id,name,email,phone,address,suburb&order=created_at.desc&limit=500');
  }

  async createCustomer(businessId, payload) {
    return this._createStable('customers', { ...payload, business_id: businessId });
  }

  // A lost HTTP response must not turn Retry into a second database row.
  // Stable UUIDs use the database primary key for concurrency protection.
  // Recovery reads are scoped to the business and checked against the
  // intended contents; an existing different row is never overwritten.
  async _createStable(table, payload) {
    try {
      const rows = await this._rest(table, {method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
      if (!rows?.[0]) throw new Error('The database did not confirm the saved record.');
      return rows[0];
    } catch (error) {
      if (!payload.id) throw error;
      const rows=await this._rest(table+'?id=eq.'+encodeURIComponent(payload.id)+'&business_id=eq.'+encodeURIComponent(payload.business_id)+'&select=*');
      const row=rows?.[0];
      const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;
      const canonical=value=>JSON.stringify(sort(value));
      if (!row || !Object.entries(payload).every(([key,value])=>canonical(row[key])===canonical(value))) throw error;
      return row;
    }
  }

  /**
   * Creates a DRAFT quote — matches index.html's own convention
   * (`status: r.quoteSentAt ? 'sent' : 'draft'`, index.html's
   * syncRecordToSupabase()). The extension has no "send to customer" step
   * of its own (no email/SMS is triggered here), so marking it 'sent'
   * would claim an action that never happened; the operator sends it for
   * real from TurnKey itself (see quote.js's "Open in TurnKey" / "Copy
   * Quote Link").
   */
  async createQuote(businessId, { id, customerId, amount }) {
    return this._createStable('quotes', { ...(id ? {id} : {}), business_id: businessId, lead_id: customerId, amount, status:'draft' });
  }

  async createJob(businessId, { id, customerId, quoteId, details }) {
    return this._createStable('jobs', {
        ...(id ? {id} : {}),
        business_id: businessId,
        customer_id: customerId,
        quote_id: quoteId,
        status: 'quoted',
        details
    });
  }

  async logActivity(businessId, { customerId, jobId, type, summary, detail }) {
    await this._ensureFreshSession();
    return this._rest('activity_log', {
      method: 'POST',
      body: JSON.stringify({
        business_id: businessId,
        customer_id: customerId,
        job_id: jobId || null,
        type,
        summary,
        detail: detail || null,
        // Attributes the timeline entry to the signed-in operator, same as
        // every staff-initiated activity_log row the CRM itself writes —
        // see activityActorLabel() in index.html, which resolves this
        // against public.users to show a real staff name.
        created_by: this.session.userId
      })
    });
  }

  /**
   * Uploads a screenshot to the same private bucket/path convention index.html's
   * uploadAttachment() uses ({business_id}/{kind}/{ts}-{rand}-{filename}), so it
   * shows up in the CRM's existing photo/attachment views with zero CRM changes.
   */
  async uploadScreenshot(businessId, customerId, jobId, blob) {
    await this._ensureFreshSession();
    const filename = 'property-screenshot.png';
    const path = businessId + '/quote_attachment/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + filename;
    const res = await fetch(this.cfg.supabaseUrl + '/storage/v1/object/turnkey-uploads/' + path, {
      method: 'POST',
      headers: {
        apikey: this.cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + this.session.accessToken,
        'Content-Type': 'image/png'
      },
      body: blob
    });
    if (!res.ok) throw new Error('Screenshot upload failed (HTTP ' + res.status + ')');
    const row = await this._rest('attachments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        business_id: businessId,
        customer_id: customerId,
        job_id: jobId || null,
        kind: 'quote_attachment',
        path,
        filename
      })
    });
    return row[0];
  }
}
