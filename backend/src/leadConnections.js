import crypto from "node:crypto";
import { importMetaBatch } from "./metaImport.js";
import express from "express";
import { generateWixToken, hashWixToken } from "./wixLeads.js";
import { encryptToken, decryptToken } from "./crypto.js";
import { fetchMetaObject, fetchMetaEdge } from "./metaGraph.js";
import { checkMetaConnection } from "./metaConnectionHealth.js";
import { decodeMetaCredentials, encodeMetaCredentials } from "./metaCredentials.js";
import { exchangeMetaUserToken, inspectMetaAccessToken } from "./metaTokenValidation.js";

export function installWixBodyParser(app) {
  app.use("/api/leads/wix", express.json({ limit: "64kb" }));
}

const conflict = (message) =>
  Object.assign(new Error(message), { status: 409, publicMessage: message });
const unwrap = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data;
};
// The canonical schema only has unique(provider,external_id). Update existing
// rows in one statement; deterministic primary keys serialize concurrent first
// connects without requiring an additional constraint or destructive delete.
export async function saveLeadConnection(db, businessId, provider, values) {
  const existing = await unwrap(
    db
      .from("lead_sources")
      .select("id,external_id")
      .eq("business_id", businessId)
      .eq("provider", provider)
      .maybeSingle(),
  );
  const row = { ...values, updated_at: new Date().toISOString() };
  if (existing) {
    const saved = await unwrap(
      db
        .from("lead_sources")
        .update(row)
        .eq("id", existing.id)
        .eq("business_id", businessId)
        .eq("provider", provider)
        // Prevent two simultaneous Wix token regenerations from both
        // succeeding and returning URLs when only the last hash is live.
        // The stale writer updates zero rows and receives a safe conflict.
        .eq("external_id", existing.external_id)
        .select("id")
        .maybeSingle(),
    );
    if (!saved)
      throw conflict(
        "The connection changed. Refresh Connections and try again.",
      );
  } else {
    const hex = crypto
      .createHash("sha256")
      .update(JSON.stringify(["turnkey-lead-source", businessId, provider]))
      .digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await unwrap(
      db
        .from("lead_sources")
        .insert({ id, business_id: businessId, provider, ...row }),
    );
  }
}

export function installLeadConnections(
  app,
  {
    db,
    requireBusiness,
    fetchPage = fetchMetaObject,
    fetchEdge = fetchMetaEdge,
    decrypt = decryptToken,
    encrypt = encryptToken,
    generateToken = generateWixToken,
    env = process.env,
    addLead,
    inspectToken = inspectMetaAccessToken,
    exchangeUserToken = exchangeMetaUserToken,
  },
) {
  const wrap = (message, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const isConflict = error.status === 409 || error.code === "23505";
      const safeStatus = [400, 403, 502, 503].includes(error.status) ? error.status : 503;
      console.error(
        "[Lead connections]",
        error.code || error.status || error.name,
      );
      res
        .status(isConflict ? 409 : safeStatus)
        .json({
          error: isConflict
            ? error.publicMessage ||
              "This connection is already linked or changed. Refresh Connections and try again."
            : error.publicMessage || message,
        });
    }
  };
  for (const provider of ["wix", "meta"]) {
    app.get(
      `/api/connections/${provider}/status`,
      requireBusiness,
      wrap("Could not read connection status.", async (req, res) => {
        const row = await unwrap(
          db
            .from("lead_sources")
            .select("external_id")
            .eq("business_id", req.businessId)
            .eq("provider", provider)
            .maybeSingle(),
        );
        const latest = await unwrap(db.from("leads").select("created_at,acked_at")
          .eq("business_id", req.businessId).eq("source", provider)
          .order("created_at", { ascending: false }).limit(1).maybeSingle());
        res.json({ connected: !!row, ...(provider === "meta" ? { pageId: row?.external_id || null } : {}),
          lastReceivedAt: latest?.created_at || null, lastIngested: !!latest?.acked_at });
      }),
    );
    app.post(
      `/api/connections/${provider}/disconnect`,
      requireBusiness,
      wrap("Could not disconnect. Please retry.", async (req, res) => {
        await unwrap(
          db
            .from("lead_sources")
            .delete()
            .eq("business_id", req.businessId)
            .eq("provider", provider),
        );
        res.json({ ok: true });
      }),
    );
  }
  const importing = new Set();
  app.post('/api/connections/meta/import', requireBusiness, async (req, res) => {
    const businessId = req.businessId;
    if (importing.has(businessId)) return res.status(409).json({ error: 'An import batch is already running. Retry shortly.' });
    importing.add(businessId);
    try {
      if (!addLead) return res.status(503).json({ error: 'Lead import storage is unavailable.' });
      const row = await unwrap(db.from('lead_sources').select('external_id,token_enc')
        .eq('business_id', businessId).eq('provider', 'meta').maybeSingle());
      if (!row) return res.status(404).json({ error: 'Connect a Meta Page first.' });
      const credentials = decodeMetaCredentials(decrypt(row.token_enc));
      const result = await importMetaBatch({ businessId, pageId: row.external_id, token: credentials.retrievalToken,
        cursor: req.body?.cursor, encrypt, decrypt, fetchEdge, addLead });
      res.json(result);
    } catch (error) {
      console.error('[Meta import]', error.code || error.name);
      res.status([400, 403].includes(error.status) ? error.status : 503).json({
        error: error.publicMessage || 'Import stopped before completion. Saved leads are safe; retry to continue without duplicates.' });
    } finally { importing.delete(businessId); }
  });
  for (const action of ["check", "repair"]) {
    app.post(`/api/connections/meta/${action}`, requireBusiness,
      wrap("Meta could not be reached. Retry the connection check.", async (req, res) => {
        const row = await unwrap(db.from("lead_sources").select("external_id,token_enc")
          .eq("business_id", req.businessId).eq("provider", "meta").maybeSingle());
        if (!row) return res.status(404).json({ error: "Connect a Meta Page first." });
        let credentials;
        try { credentials = decodeMetaCredentials(decrypt(row.token_enc)); } catch {
          return res.status(503).json({ error: "The saved Meta credential cannot be read. Reconnect the Page; if this continues, check the backend encryption key." });
        }
        const health = await checkMetaConnection({ pageId: row.external_id, ...credentials, repair: action === "repair", appId: env.META_APP_ID, fetchPage, fetchEdge });
        res.json({ connected: true, pageId: row.external_id, ...health });
      }));
  }
  app.post(
    "/api/connections/wix/connect",
    requireBusiness,
    wrap("Could not generate a webhook URL.", async (req, res) => {
      const token = generateToken();
      await saveLeadConnection(db, req.businessId, "wix", {
        external_id: hashWixToken(token),
      });
      const backend = (
        env.PUBLIC_BACKEND_URL || `https://${req.get("host")}`
      ).replace(/\/$/, "");
      res.json({ ok: true, webhookUrl: `${backend}/api/leads/wix/${token}` });
    }),
  );
  app.post(
    "/api/connections/meta/connect",
    requireBusiness,
    wrap("Could not connect this Meta Page.", async (req, res) => {
      const pageId = String(req.body?.pageId || "").trim();
      let retrievalToken = String(req.body?.retrievalToken || req.body?.token || "").trim();
      if (!/^\d{1,40}$/.test(pageId) || !retrievalToken || retrievalToken.length > 10000)
        return res
          .status(400)
          .json({ error: "Page ID and a Meta user access token are required" });
      const mapped = await unwrap(
        db
          .from("lead_sources")
          .select("business_id")
          .eq("provider", "meta")
          .eq("external_id", pageId)
          .maybeSingle(),
      );
      if (mapped && mapped.business_id !== req.businessId)
        throw conflict(
          "This Meta Page is already connected to another business.",
        );
      // Accept a normal user token generated for this app. Exchange short-lived
      // user tokens server-side when Meta allows it; if it is already long-lived
      // or Meta declines a repeat exchange, keep the verified input token.
      let tokenInfo = await inspectToken({ token: retrievalToken, appId: env.META_APP_ID, appSecret: env.META_APP_SECRET });
      if (tokenInfo.type === "USER") {
        const exchanged = await exchangeUserToken({ token: retrievalToken, appId: env.META_APP_ID, appSecret: env.META_APP_SECRET });
        if (exchanged?.accessToken) {
          try {
            tokenInfo = await inspectToken({ token: exchanged.accessToken, appId: env.META_APP_ID, appSecret: env.META_APP_SECRET });
            retrievalToken = exchanged.accessToken;
          } catch { /* Preserve the original token already verified above. */ }
        }
      }
      const check = await fetchPage(pageId, {
          token: retrievalToken,
          fields: "id,name,access_token",
        }),
        page = await check.json();
      if (!check.ok || page.id !== pageId)
        return res
          .status(400)
          .json({
            error:
              "That Page ID / Meta access token combination could not be verified. Check the Page assignment and permissions, then retry.",
          });
      // Meta can return the Page-scoped token when an authorized user/System
      // User token reads the Page node. Store both encrypted, but ask the user
      // for just the one durable credential.
      // The browser submits only the user token. Resolve the Page-scoped token
      // server-side; never ask the user to paste a second credential.
      const pageToken = page.access_token || retrievalToken;
      await saveLeadConnection(db, req.businessId, "meta", {
        external_id: pageId,
        token_enc: encrypt(encodeMetaCredentials({ retrievalToken, pageToken })),
      });
      let health;
      try { health = await checkMetaConnection({ pageId, pageToken, retrievalToken, repair: true, appId: env.META_APP_ID, fetchPage, fetchEdge }); }
      catch { health = { health: 'error', message: 'Page saved, but lead delivery could not be enabled. Retry Enable lead delivery.' }; }
      res.json({ ok: true, connected: true, pageId, pageName: page.name || null,
        tokenType: tokenInfo.type, tokenExpiresAt: tokenInfo.expiresAt || tokenInfo.dataAccessExpiresAt || null,
        adsReportingAvailable: (tokenInfo.scopes || []).includes('ads_read'), ...health });
    }),
  );
}
