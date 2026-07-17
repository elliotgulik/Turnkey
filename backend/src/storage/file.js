import fs from 'node:fs/promises'
import path from 'node:path'

const STATE_FILE = 'state.json'

export function createFileStorage(dataDir) {
  const dir = path.resolve(dataDir)
  const statePath = path.join(dir, STATE_FILE)
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
    async getState() {
      return readJson(statePath, null)
    },

    async saveState(state, savedAt) {
      await writeJson(statePath, { state, savedAt })
      return { state, savedAt }
    },

    async addLead(payload) {
      const leads = await readJson(leadsPath, [])
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
      const leads = await readJson(leadsPath, [])
      return leads.filter((l) => !l.ackedAt && l.businessId === businessId)
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
