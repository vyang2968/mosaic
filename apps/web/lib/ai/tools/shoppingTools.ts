import type { SupabaseClient } from '@supabase/supabase-js'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { applyCartActions, type CartAction } from '@/lib/server/cart-actions'
import { searchProducts } from '@/lib/server/products'
import { dropAlternates, popNextAlternate, storeAlternates } from '@/lib/server/agent-alternates'
import { getSupabaseAdmin } from '@/lib/server/supabase'
import { searchAndCacheQuery } from '@/lib/server/searchOrchestrator'
import { vibeTermsFromProfile } from '@/lib/ai/productType'
import { fallbackQueries } from '@/lib/ai/searchQueryGenerator'
import { browseWebpage, getPageSummary } from '@/lib/server/browser'
import { runMerchantCheckout } from '@/lib/server/browserCheckout'
import { isGoogleInterstitialUrl, resolveDirectProductUrl } from '@/lib/server/internetSearch'

// Fallback candidates stashed for a later swap_item call (see agent-alternates.ts).
const CANDIDATE_POOL_SIZE = 4

// Cached productUrl is often a Google Shopping interstitial (see internetSearch.ts); resolve before browsing.
async function resolveBrowseTarget(url: string): Promise<string> {
  if (!isGoogleInterstitialUrl(url)) return url
  const query = new URL(url).searchParams.get('q')
  if (!query) return url
  return (await resolveDirectProductUrl(query)) ?? url
}

// search_products previously handed the model the raw cached productUrl —
// often the same Google Shopping interstitial fixed for run_merchant_checkout/
// browse_webpage — and the model would paste it verbatim into its reply
// text, rendered as a real clickable link by the chat UI's markdown
// renderer. That bypassed the app's own resolve-on-click redirect route
// entirely (which only the structured product card in the UI used).
// Routing the model's own view through the same redirect fixes it
// regardless of where the link ends up: a product card, or pasted into text.
function displayUrlFor(productId: string): string | null {
  let baseUrl = process.env.APP_BASE_URL
  if (process.env.VERCEL_URL && (!baseUrl || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(baseUrl))) {
    baseUrl = `https://${process.env.VERCEL_URL}`
  }
  if (!baseUrl) return null
  return new URL(`/api/products/${productId}/link`, baseUrl).toString()
}

// Built by a factory so each tool can close over guestId/boardId. Cart
// actions execute immediately (one per tool call) so the model sees success/failure within the same turn.
export function createShoppingTools(
  guestId: string,
  boardId: string,
  db: SupabaseClient = getSupabaseAdmin(),
): ToolSet {
  async function runAction(action: CartAction) {
    console.log(`[shopping-tools] cart action: ${JSON.stringify(action)}`)
    const outcome = await applyCartActions(guestId, boardId, { actions: [action] }, db)
    console.log(`[shopping-tools] cart action result: ${JSON.stringify(outcome.results[0])}`)
    return outcome.results[0]
  }

  // Wraps a tool's execute so every call is logged the same way.
  function logged<TArgs, TResult>(name: string, execute: (args: TArgs) => Promise<TResult>) {
    return async (args: TArgs): Promise<TResult> => {
      console.log(`[shopping-tools] ${name} called with: ${JSON.stringify(args)}`)
      const result = await execute(args)
      console.log(`[shopping-tools] ${name} returned: ${JSON.stringify(result)}`)
      return result
    }
  }

  // Correlates a search_products call with the add_item call that follows it, turn-scoped only.
  let lastSearchCandidateIds: string[] = []

  return {
    search_products: tool({
      description: `Search current web shopping results and the product catalog by query, category, and max price. Returns up to ${CANDIDATE_POOL_SIZE} close matches with product URLs you can visit. Include the requested item type and board vibe in the query. Use this to find a productId before adding it to the cart.`,
      inputSchema: z.object({
        query: z.string().optional().describe('Free-text search, e.g. "desk lamp"'),
        category: z.string().optional(),
        // price_cents is a Postgres `integer` column — cap avoids a "no limit" sentinel overflowing it.
        maxPriceCents: z.number().int().positive().max(2_147_483_647).optional(),
      }),
      execute: logged('search_products', async ({ query, category, maxPriceCents }) => {
        // Catches thrown errors so they log instead of vanishing into the ai SDK's tool-call loop.
        try {
          const toResult = (list: Awaited<ReturnType<typeof searchProducts>>) => {
            lastSearchCandidateIds = list.map((p) => p.id)
            return list.map((p) => ({
              productId: p.id,
              name: p.name,
              merchantName: p.merchantName,
              priceCents: p.priceCents,
              category: p.category,
              description: p.description,
              productUrl: p.productUrl ? displayUrlFor(p.id) ?? p.productUrl : null,
              imageUrl: p.imageUrl,
            }))
          }

          const { data: vibeRow } = await db.from('vibe_profiles').select('profile_json').eq('board_id', boardId).maybeSingle()
          const profile = (vibeRow as { profile_json?: Record<string, unknown> } | null)?.profile_json ?? null
          const vibeTerms = vibeTermsFromProfile(profile)
          const searchTerm = query?.trim() || category?.trim()
          if (searchTerm) {
            const queries = [searchTerm, ...fallbackQueries(profile ?? {}, searchTerm).filter((value) => value !== searchTerm).slice(0, 2)]
            const searches = await Promise.allSettled(queries.map((value, index) =>
              searchAndCacheQuery(value, db, index === 0 ? category : undefined, maxPriceCents)))
            searches.forEach((outcome, index) => {
              if (outcome.status === 'rejected') console.warn(`[shopping-tools] Live search failed for "${queries[index]}":`, outcome.reason)
            })
          }
          return toResult((await searchProducts({ query, category, maxPriceCents, vibeTerms }, db)).slice(0, CANDIDATE_POOL_SIZE))
        } catch (err) {
          console.error('[shopping-tools] search_products failed:', err)
          return []
        }
      }),
    }),

    browse_webpage: tool({
      description: `Navigate to a product URL and return the page content as text. Use this to view the full product page, check reviews, verify availability, or read details not in the search snippet. Returns the page title and text content.`,
      inputSchema: z.object({ url: z.string().url().describe('The URL to navigate to (from search_products productUrl)') }),
      execute: logged('browse_webpage', async ({ url }) => {
        return await browseWebpage(await resolveBrowseTarget(url))
      }),
    }),

    browse_summary: tool({
      description: `Get a quick summary of a product page — title, key text excerpt, and any visible price. Faster than browse_webpage when you just need a quick overview.`,
      inputSchema: z.object({ url: z.string().url().describe('The URL to summarize (from search_products productUrl)') }),
      execute: logged('browse_summary', async ({ url }) => {
        return await getPageSummary(await resolveBrowseTarget(url))
      }),
    }),

    run_merchant_checkout: tool({
      description: `Attempt to add a cart item's product to its merchant's real site cart and walk their checkout flow up to (but never past) the payment-submission step. Returns a screenshot proving the flow reached checkout, or an error if a step failed. Never completes a real purchase. Only works for products from merchants with browser-based checkout — the two demo merchants (Sol & Clay, North Loom) use the regular checkout flow instead and will reject this call.`,
      inputSchema: z.object({ productId: z.string() }),
      execute: logged('run_merchant_checkout', async ({ productId }) => {
        try {
          return { ok: true, proof: await runMerchantCheckout(guestId, boardId, productId, db) }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }),
    }),

    add_item: tool({
      description: 'Add a product to the cart by productId.',
      inputSchema: z.object({ productId: z.string(), quantity: z.number().int().positive().optional() }),
      execute: logged('add_item', async ({ productId, quantity }) => {
        const result = await runAction({ type: 'ADD', productId, quantity })
        if (result.ok) {
          const alternates = lastSearchCandidateIds.filter((id) => id !== productId)
          await storeAlternates(boardId, productId, alternates, db)
          console.log(`[shopping-tools] stashed ${alternates.length} alternate(s) for ${productId}`)
        }
        return result
      }),
    }),

    remove_item: tool({
      description: 'Remove a product from the cart by productId. Fails if the item is locked.',
      inputSchema: z.object({ productId: z.string() }),
      execute: logged('remove_item', async ({ productId }) => {
        const result = await runAction({ type: 'REMOVE', productId })
        if (result.ok) await dropAlternates(boardId, productId, db)
        return result
      }),
    }),

    replace_item: tool({
      description: 'Remove one product and add another in the same action, e.g. swapping the rug for a different one. Prefer swap_item when the user just wants an alternative to something already in the cart — it reuses candidates from the original search instead of a fresh one.',
      inputSchema: z.object({
        removeProductId: z.string(),
        addProductId: z.string(),
        quantity: z.number().int().positive().optional(),
      }),
      execute: logged('replace_item', async ({ removeProductId, addProductId, quantity }) => {
        const result = await runAction({ type: 'REPLACE', removeProductId, addProductId, quantity })
        if (result.ok) await dropAlternates(boardId, removeProductId, db)
        return result
      }),
    }),

    swap_item: tool({
      description: 'Swap a product already in the cart for the next-best alternative from its original search, without re-searching. Use this when the user says something like "swap this out" / "show me something else" for an item already in the cart. If there are no queued alternatives left, fall back to search_products + replace_item instead.',
      inputSchema: z.object({ productId: z.string().describe('The product currently in the cart to swap out') }),
      execute: logged('swap_item', async ({ productId }) => {
        const next = await popNextAlternate(boardId, productId, db)
        if (!next) {
          console.log(`[shopping-tools] no queued alternates for ${productId}`)
          return { ok: false, error: 'No queued alternatives for this item — search for a replacement instead.', code: 'NO_ALTERNATES' }
        }
        const result = await runAction({ type: 'REPLACE', removeProductId: productId, addProductId: next.nextProductId })
        if (result.ok && next.remaining.length > 0) {
          await storeAlternates(boardId, next.nextProductId, next.remaining, db)
        }
        return { ...result, swappedToProductId: next.nextProductId }
      }),
    }),

    lock_item: tool({
      description: 'Lock a product in the cart so future edits leave it untouched, e.g. "keep the lamp".',
      inputSchema: z.object({ productId: z.string() }),
      execute: logged('lock_item', ({ productId }) => runAction({ type: 'LOCK', productId })),
    }),

    unlock_item: tool({
      description: 'Unlock a previously locked product.',
      inputSchema: z.object({ productId: z.string() }),
      execute: logged('unlock_item', ({ productId }) => runAction({ type: 'UNLOCK', productId })),
    }),

    set_budget: tool({
      description: 'Set or clear the cart budget in cents. Pass null to clear it.',
      inputSchema: z.object({ budgetCents: z.number().int().positive().nullable() }),
      execute: logged('set_budget', ({ budgetCents }) => runAction({ type: 'SET_BUDGET', budgetCents })),
    }),
  }
}
