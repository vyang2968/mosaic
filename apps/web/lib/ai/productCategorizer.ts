/**
 * AI-powered product categorizer. Labels a batch of product titles with a
 * short category using the model's actual understanding of what kind of
 * item something is — not a keyword/substring list (which can only ever
 * cover the specific words its author thought of: a jacket/coat/blazer
 * query silently fell through a list that only knew "shirt"/"pants",
 * permanently miscategorizing every result), and not a fixed enum either
 * (a hardcoded taxonomy has the same blind-spot problem one level up —
 * whatever categories its author thought to list). The model picks
 * whatever label fits; category matching downstream (products.ts) is
 * token-based, not an exact-match filter, so free-form labels work fine.
 *
 * One batched call per query's result set (not one call per product) keeps
 * this cheap: ~5 calls per shopping turn, not up to 40.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveAgentModel } from './providers'

export async function categorizeProducts(titles: string[]): Promise<string[]> {
  if (titles.length === 0) return []
  try {
    const model = resolveAgentModel()
    const { object } = await generateObject({
      model,
      maxOutputTokens: 256,
      // Not an exact-length array: the model occasionally drops or adds an
      // item on a 40-title batch, and an exact `.length()` constraint used
      // to reject the *entire* response over one miscount — turning 38
      // correct labels into 40 "general"s. Reconciled by index below
      // instead, so a miscount only affects the entries actually missing.
      schema: z.object({
        categories: z.array(z.string().min(1))
          .describe('One short category label per title (e.g. "lighting", "jacket", "rug"), in the same order as the input titles'),
      }),
      system: `You label shopping product titles with a short category (one or two words) describing what kind of item each one is — judge by what the item actually is, not by guessing from a fixed list. Return a JSON object with a "categories" array: exactly one label per title, same order as the input titles.`,
      prompt: JSON.stringify(titles),
    })
    if (object.categories.length !== titles.length) {
      console.warn(`[productCategorizer] Model returned ${object.categories.length} categories for ${titles.length} titles, reconciling by index`)
    }
    return titles.map((_, i) => object.categories[i] ?? 'general')
  } catch (err) {
    console.error('[productCategorizer] Failed, falling back to "general" for all:', err)
    return titles.map(() => 'general')
  }
}
