import { createClient } from '@supabase/supabase-js'

const STATE_ID = 'default'

export function createSupabaseStorage(url, serviceRoleKey) {
  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    async getState() {
      const { data, error } = await supabase
        .from('crm_state')
        .select('state, saved_at')
        .eq('id', STATE_ID)
        .maybeSingle()

      if (error) throw error
      if (!data) return null
      return { state: data.state, savedAt: data.saved_at }
    },

    async saveState(state, savedAt) {
      const { error } = await supabase.from('crm_state').upsert({
        id: STATE_ID,
        state,
        saved_at: savedAt,
        updated_at: new Date().toISOString(),
      })

      if (error) throw error
      return { state, savedAt }
    },

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

      const { data, error } = await supabase
        .from('leads')
        .select('id, payload, created_at')
        .is('acked_at', null)
        .eq('business_id', businessId)
        .order('created_at', { ascending: true })

      if (error) throw error
      return (data ?? []).map((row) => ({
        id: row.id,
        payload: row.payload,
        createdAt: new Date(row.created_at).getTime(),
      }))
    },

    async ackLeads(ids) {
      if (!ids.length) return { acked: 0 }

      const { error } = await supabase
        .from('leads')
        .update({ acked_at: new Date().toISOString() })
        .in('id', ids)

      if (error) throw error
      return { acked: ids.length }
    },
  }
}
