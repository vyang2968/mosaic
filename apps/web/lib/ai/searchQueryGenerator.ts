/**
 * AI-powered search query generator.
 * Given a vibe profile and user request, generates search queries
 * for internet product search.
 */
import { generateText } from 'ai'
import { resolveAgentModel } from '@/lib/ai/providers'
import { productFamilyFor, vibeTermsFromProfile } from './productType'

// Max search queries generated per shopping-agent turn. More queries means
// broader catalog coverage but more Serper calls (and more categorizer/
// resolveDirectProductUrl calls downstream) per turn — tune via env instead
// of a code change.
const MAX_QUERIES = Number(process.env.SEARCH_QUERY_COUNT ?? 3)

export async function generateSearchQueries(
  vibeProfile: Record<string, unknown>,
  userRequest: string,
): Promise<string[]> {
  try {
    const model = resolveAgentModel()

    const vibeJson = JSON.stringify(vibeProfile, null, 2)

    const result = await generateText({
      model,
      maxOutputTokens: 256,
      system: `You are a product search query generator for a shopping AI.

Given a vibe profile and a user request, generate up to ${MAX_QUERIES} concise, specific search queries
that would find relevant products on an online store (e.g., Amazon, Google Shopping).

Rules:
- Each query should be 3-5 words max
- Include the price constraint from the user request if present
- Use the vibe profile terms (colors, materials, styles) in the queries
- Return ONLY a JSON array of strings, no other text
- Make queries specific enough to find real products

Vibe profile: ${vibeJson}
User request: ${userRequest}`,
      messages: [{ role: 'user' as const, content: `Generate search queries from this vibe profile and request. Return only a JSON array.` }],
    })

    // Parse the LLM's response as JSON array
    const text = result.text.trim()
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown
      if (!Array.isArray(parsed)) return fallbackQueries(vibeProfile, userRequest)
      const family = productFamilyFor(userRequest)
      const queries = [...new Set(parsed.filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value) => !family || !productFamilyFor(value) || productFamilyFor(value) === family)
        .map((value) => family && !productFamilyFor(value) ? `${value} ${family}` : value))].slice(0, MAX_QUERIES)
      if (queries.length === 0) return fallbackQueries(vibeProfile, userRequest)
      console.log(`[searchQueryGenerator] Generated ${queries.length} queries`)
      return queries
    }

    // Fallback: simple keyword-based generation
    console.warn('[searchQueryGenerator] Could not parse LLM response, using fallback')
    return fallbackQueries(vibeProfile, userRequest)
  } catch (err) {
    console.error('[searchQueryGenerator] Failed:', err)
    return fallbackQueries(vibeProfile, userRequest)
  }
}

export function fallbackQueries(
  vibeProfile: Record<string, unknown>,
  userRequest: string,
): string[] {
  const facets = vibeProfile.facets as Record<string, unknown> | undefined
  const first = (key: string): string | null => {
    const values = facets?.[key]
    return Array.isArray(values) && typeof values[0] === 'string' ? values[0].replaceAll('_', ' ') : null
  }
  const request = userRequest.trim()
  const explicitColor = /\b(?:red|blue|green|yellow|orange|purple|pink|black|white|gr[ae]y|brown|beige|cream|navy|olive|tan|gold|silver)\b/i.test(request)
  const colors = Array.isArray(facets?.color) ? (facets.color as unknown[])
    .filter((value): value is string => typeof value === 'string').map((value) => value.replaceAll('_', ' ')) : []
  const terms = [...new Set([
    explicitColor ? null : first('color'), first('style'),
    ...vibeTermsFromProfile(vibeProfile).filter((value) => !explicitColor || !colors.includes(value)),
  ].filter((value): value is string => Boolean(value)))]
  const family = productFamilyFor(request)
  const base = request.replace(/^(?:please\s+)?(?:find(?: me)?|shop for|show me|look for|get me|add)\s+/i, '').trim() || family || request
  const queries = terms.map((term) => `${term} ${base}`.trim())
  if (request && !family) queries.unshift(request)
  if (queries.length === 0) queries.push(request)
  return [...new Set(queries)].slice(0, MAX_QUERIES)
}
