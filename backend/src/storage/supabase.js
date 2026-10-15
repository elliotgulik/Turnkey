import { createClient } from '@supabase/supabase-js'

// The optional `client` override exists purely for tests (see
// supabase.test.js) to inject a fake Supabase client and exercise the
// dedupe/error-handling branches without a real database — every real
// caller (backend/src/index.js) omits it and gets the same client this
// always created.
export function createSupabaseStorage(url, serviceRoleKey, { client } = {}) {
  const supabase = client || createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    async addLead(payload) {
      const row = {
        payload,
        business_id: payload.business_id ?? null,
        source: payload.source ?? null,
        external_id: payload.external_id ?? null,
      }
      const { data, error } = await supabase
        .from('leads')
        .insert(row)
        .select('id, payload, created_at')
        .single()

      if (error) {
        // Unique violation on (business_id, source, external_id) means a
        // webhook redelivered an event already ingested (Wix Automations
        // and Meta's leadgen webhook both retry on anything but a fast
        // 2xx) — idempotent no-op: return the existing row instead of
        // erroring, so a redelivery never creates a duplicate lead.
        if (error.code === '23505' && row.external_id) {
          const { data: existing, error: findErr } = await supabase
            .from('leads')
            .select('id, payload, created_at')
            .eq('business_id', row.business_id)
            .eq('source', row.source)
            .eq('external_id', row.external_id)
            .maybeSingle()
          if (!findErr && existing) {
            return {
              id: existing.id,
              payload: existing.payload,
              createdAt: new Date(existing.created_at).getTime(),
              deduped: true,
            }
          }
        }
        throw error
      }
      return {
        id: data.id,
        payload: data.payload,
        createdAt: new Date(data.created_at).getTime(),
      }
    },

    async getPendingLeads(businessId) {
      if (!businessId) return []

      // Atomically CLAIM rows in the same statement that reads them — a
      // plain SELECT here would let two concurrent polls (two tabs, or a
      // slow ack) both fetch and ingest the same lead. Only rows unacked
      // AND not claimed within the last 60s match, so a second poll racing
      // right behind this one sees nothing left to claim. If this poll's
      // ack never lands, the claim expires and the lead is pollable again.
      const claimCutoff = new Date(Date.now() - 60000).toISOString()
      const { data, error } = await supabase
        .from('leads')
        .update({ claimed_at: new Date().toISOString() })
        .eq('business_id', businessId)
        .is('acked_at', null)
        .or(`claimed_at.is.null,claimed_at.lt.${claimCutoff}`)
        .select('id, payload, created_at')

      if (error) throw error
      return (data ?? [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((row) => ({
          id: row.id,
          payload: row.payload,
          createdAt: new Date(row.created_at).getTime(),
        }))
    },

    async ackLeads(businessId, ids) {
      if (!businessId || !ids.length) return { acked: 0 }

      const { data, error } = await supabase
        .from('leads')
        .update({ acked_at: new Date().toISOString() })
        .in('id', ids)
        .eq('business_id', businessId)
        .select('id')

      if (error) throw error
      return { acked: data?.length ?? 0 }
    },
  }
}
