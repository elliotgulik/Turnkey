import fs from 'node:fs/promises'
import path from 'node:path'

export function createFileStorage(dataDir) {
  const dir = path.resolve(dataDir)
  const leadsPath = path.join(dir, 'leads.json')

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true })
  }

  async function readJson(file, fallback) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  async function writeJson(file, data) {
    await ensureDir()
    await fs.writeFile(file, JSON.stringify(data, null, 2))
  }

  return {
    async addLead(payload) {
      const leads = await readJson(leadsPath, [])
      // Same redelivery dedupe as the Supabase storage's unique index —
      // local/file mode has no DB constraint to lean on, so check by hand.
      if (payload.external_id && payload.source) {
        const dup = leads.find((l) =>
          l.businessId === (payload.business_id ?? null) &&
          l.payload?.source === payload.source &&
          l.payload?.external_id === payload.external_id
        )
        if (dup) return dup
      }
      const lead = {
        id: crypto.randomUUID(),
        payload,
        businessId: payload.business_id ?? null,
        createdAt: Date.now(),
      }
      leads.push(lead)
      await writeJson(leadsPath, leads)
      return lead
    },

    async getPendingLeads(businessId) {
      if (!businessId) return []
      // Same atomic-claim idea as the Supabase backend (see
      // schema-leads-claim.sql) — mark rows claimed in the same pass that
      // reads them, so a second concurrent poll doesn't also pick them up.
      const now = Date.now()
      const claimCutoff = now - 60000
      const leads = await readJson(leadsPath, [])
      const claimed = []
      for (const l of leads) {
        if (l.ackedAt || l.businessId !== businessId) continue
        if (l.claimedAt && l.claimedAt >= claimCutoff) continue
        l.claimedAt = now
        claimed.push(l)
      }
      if (claimed.length) await writeJson(leadsPath, leads)
      return claimed
    },

    async ackLeads(businessId, ids) {
      if (!businessId) return { acked: 0 }
      const leads = await readJson(leadsPath, [])
      const idSet = new Set(ids)
      const now = Date.now()
      let acked = 0
      for (const lead of leads) {
        if (idSet.has(lead.id) && lead.businessId === businessId) {
          lead.ackedAt = now
          acked++
        }
      }
      await writeJson(leadsPath, leads)
      return { acked }
    },
  }
}
