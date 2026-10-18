import crypto from "node:crypto";
import express from "express";
import { generateWixToken, hashWixToken } from "./wixLeads.js";
import { encryptToken } from "./crypto.js";
import { fetchMetaObject } from "./metaGraph.js";

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
    encrypt = encryptToken,
    generateToken = generateWixToken,
    env = process.env,
  },
) {
  const wrap = (message, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const isConflict = error.status === 409 || error.code === "23505";
      console.error(
        "[Lead connections]",
        error.code || error.status || error.name,
      );
      res
        .status(isConflict ? 409 : 503)
        .json({
          error: isConflict
            ? error.publicMessage ||
              "This connection is already linked or changed. Refresh Connections and try again."
            : message,
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
        res.json(
          provider === "meta"
            ? { connected: !!row, pageId: row?.external_id || null }
            : { connected: !!row },
        );
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
      const pageId = String(req.body?.pageId || "").trim(),
        pageToken = String(req.body?.pageToken || "").trim();
      if (!pageId || !pageToken)
        return res
          .status(400)
          .json({ error: "Page ID and Page Access Token are required" });
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
      const check = await fetchPage(pageId, {
          token: pageToken,
          fields: "id,name",
        }),
        page = await check.json();
      if (!check.ok || page.id !== pageId)
        return res
          .status(400)
          .json({
            error:
              "That Page ID / token combination could not be verified with Meta",
          });
      await saveLeadConnection(db, req.businessId, "meta", {
        external_id: pageId,
        token_enc: encrypt(pageToken),
      });
      res.json({ ok: true, pageName: page.name || null });
    }),
  );
}
