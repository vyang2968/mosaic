/**
 * Search orchestrator.
 * Generates search queries from vibe terms, calls internet search providers,
 * and caches results in Postgres.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from './supabase'
import { searchInternet } from './internetSearch'
import { cacheSearchResults } from './productCache'
import type { VibeProfile } from './vibe-profile'
import { generateSearchQueries } from '@/lib/ai/searchQueryGenerator'

const CACHE_TTL_MS = 30 * 60 * 1000

export async function searchAndCacheQuery(
  query: string,
  db: SupabaseClient = getSupabaseAdmin(),
  category?: string,
  maxPriceCents?: number,
): Promise<void> {
  const normalized = query.trim()
  if (!normalized) return
  const cacheKey = `${normalized.toLowerCase()}|${category?.toLowerCase() ?? ''}|${maxPriceCents ?? ''}`
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString()
  const { data, error } = await db.from('products').select('id')
    .contains('metadata', { query: cacheKey })
    .eq('available', true)
    .gte('updated_at', cutoff)
    .limit(1)
  if (!error && data?.length) return
  if (error) console.warn(`[searchOrchestrator] Cache lookup failed for "${normalized}":`, error.message)
  const results = await searchInternet(normalized, category, maxPriceCents)
  if (results.length) await cacheSearchResults(cacheKey, results, db)
}

export async function performSearch(
  vibeProfile: VibeProfile,
  userRequest: string,
  guestId: string,
  db: SupabaseClient = getSupabaseAdmin(),
): Promise<void> {
  // Step 1: Generate search queries from vibe terms + user request
  const queries = await generateSearchQueries(vibeProfile.profile, userRequest)
  console.log(`[searchOrchestrator] Generated ${queries.length} queries: ${JSON.stringify(queries)}`)

  // Search independent queries concurrently so web lookups do not add their
  // latencies together. A failure in one query still leaves the others usable.
  const outcomes = await Promise.allSettled(queries.map((query) => searchAndCacheQuery(query, db)))
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      console.warn(`[searchOrchestrator] Query "${queries[index]}" failed:`, outcome.reason)
    }
  })

  console.log(`[searchOrchestrator] Done searching for guest ${guestId}`)
}
