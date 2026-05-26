import { syncConfig } from './sync.config'
import { retailClient } from './retailApi'
import IdMap from './idMap.model'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('sync.utils')

// Resolve the retail location ID for a given wholesale location ID.
// Falls back to the env-configured default, then auto-discovers the
// first active retail location and caches it in the id map.
export async function resolveRetailLocationId(wholesaleLocationId) {
  const wlId = wholesaleLocationId ? String(wholesaleLocationId) : null

  if (wlId) {
    const mapping = await IdMap.findOne({ entityType: 'location', wholesaleId: wlId })
    if (mapping) return mapping.retailId
  }

  if (syncConfig.retailLocationId) return syncConfig.retailLocationId

  // Auto-discover and cache
  const data = await retailClient.get('locations.json?active=true&limit=1')
  const loc = data?.locations?.[0]
  if (!loc) {
    log.warn('resolve_retail_location.not_found', { wholesaleLocationId: wlId })
    return null
  }
  const retailLocationId = String(loc.id)
  if (wlId) {
    await IdMap.updateOne(
      { entityType: 'location', wholesaleId: wlId },
      { $set: { entityType: 'location', wholesaleId: wlId, retailId: retailLocationId } },
      { upsert: true },
    )
  }
  return retailLocationId
}

// Resolve the wholesale default location ID.
// Uses env-configured WHOLESALE_LOCATION_ID or auto-discovers via REST.
let _wholesaleLocationIdCache = null
export async function resolveWholesaleLocationId(admin) {
  if (_wholesaleLocationIdCache) return _wholesaleLocationIdCache
  if (process.env.WHOLESALE_LOCATION_ID) {
    _wholesaleLocationIdCache = process.env.WHOLESALE_LOCATION_ID
    return _wholesaleLocationIdCache
  }
  const res = await admin.graphql(`
    query {
      locations(first: 1, includeInactive: false) {
        nodes { id legacyResourceId }
      }
    }
  `)
  const json = await res.json()
  const loc = json?.data?.locations?.nodes?.[0]
  if (!loc) return null
  _wholesaleLocationIdCache = loc.legacyResourceId
  return _wholesaleLocationIdCache
}
