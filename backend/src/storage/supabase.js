import { createClient } from '@supabase/supabase-js'

export function createSupabaseStorage(url, serviceRoleKey) {
  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    async addLead(payload) {
      const { data, error } = await supabase
        .from('leads')
        .insert({ payload, business_id: payload.business_id ?? null })
        .select('id, payload, created_at')
        .single()

      if (error) throw error
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
