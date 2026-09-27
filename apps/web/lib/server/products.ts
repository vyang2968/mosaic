import type { SupabaseClient } from '@supabase/supabase-js'
import { isGoogleInterstitialUrl, resolveDirectProductUrl } from './internetSearch'
import { getSupabaseAdmin } from './supabase'
import { matchesProductFamily, productFamilyFor } from '@/lib/ai/productType'

// This is the `searchProducts(query, category, maxPrice)` interface described
// in the root README's "Product discovery" section. Today it queries the
// `products`/`merchants` tables (seeded by scripts/seed-products.ts). Swapping
// in a real merchant feed or shopping API later only means changing this
// file's implementation — the shape returned to callers should stay the same.
export type Product = {
  id: string
  merchantId: string
  merchantName: string
  checkoutMethod: string
  name: string
  description: string | null
  category: string | null
  priceCents: number
  currency: string
  imageUrl: string | null
  productUrl: string | null
  available: boolean
}

export type ProductSearchFilters = {
  query?: string
  category?: string
  maxPriceCents?: number
  vibeTerms?: string[]
}

type ProductRow = {
  id: string
  merchant_id: string
  name: string
  description: string | null
  category: string | null
  price_cents: number
  currency: string
  image_url: string | null
  product_url: string | null
  available: boolean
  updated_at?: string
  metadata?: { query?: string }
}

const PRODUCT_COLUMNS = 'id, merchant_id, name, description, category, price_cents, currency, image_url, product_url, available, updated_at, metadata'

function mapProductRow(row: ProductRow, merchantName: string, checkoutMethod: string): Product {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantName,
    checkoutMethod,
    name: row.name,
    description: row.description,
    category: row.category,
    priceCents: row.price_cents,
    currency: row.currency,
    imageUrl: row.image_url,
    productUrl: row.product_url,
    available: row.available,
  }
}

async function attachMerchantNames(rows: ProductRow[], db: SupabaseClient): Promise<Product[]> {
  if (rows.length === 0) return []
  const merchantIds = [...new Set(rows.map((row) => row.merchant_id))]
  const { data, error } = await db.from('merchants').select('id, name, checkout_method').in('id', merchantIds)
  if (error) throw new Error('Could not load merchants for products')
  const merchantById = new Map(
    ((data ?? []) as Array<{ id: string; name: string; checkout_method: string }>).map((m) => [m.id, m]),
  )
  return rows.map((row) => {
    const merchant = merchantById.get(row.merchant_id)
    return mapProductRow(row, merchant?.name ?? 'Unknown merchant', merchant?.checkout_method ?? 'manual')
  })
}

export async function searchProducts(
  filters: ProductSearchFilters,
  db: SupabaseClient = getSupabaseAdmin(),
): Promise<Product[]> {
  const family = productFamilyFor(filters.query ?? '') ?? productFamilyFor(filters.category ?? '')
  const tokens = [...new Set(`${filters.query ?? ''} ${filters.category ?? ''}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const vibeTokens = [...new Set((filters.vibeTerms ?? []).flatMap((term) => term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))]
  // PostgREST caps a response at 1,000 rows by default. Page through the
  // catalog so new web results cannot disappear behind older alphabetic rows.
  const rows: ProductRow[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    let request = db.from('products').select(PRODUCT_COLUMNS).eq('available', true)
      .order('id', { ascending: true }).range(offset, offset + pageSize - 1)
    if (typeof filters.maxPriceCents === 'number') request = request.lte('price_cents', filters.maxPriceCents)
    // Preserve the indexed SQL prefilter for free-text searches. Product
    // families use local synonym matching ("shoes" can mean "boots"), so
    // their candidates need the complete available catalog.
    if (!family && tokens.length) {
      request = request.or(tokens.flatMap((token) => ['name', 'description', 'category']
        .map((column) => `${column}.ilike.%${token}%`)).join(','))
    }
    const { data, error } = await request
    if (error) throw new Error('Could not search products')
    const page = (data ?? []) as ProductRow[]
    rows.push(...page)
    if (page.length < pageSize) break
  }

  const hasWord = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, 'u').test(text)
  const candidates = rows.flatMap((row) => {
    if (family && !matchesProductFamily(`${row.name} ${row.category ?? ''}`, family)) return []
    const name = row.name.toLowerCase()
    const category = (row.category ?? '').toLowerCase()
    const description = (row.description ?? '').toLowerCase()
    const sourceQuery = (row.metadata?.query ?? '').toLowerCase()
    const queryScore = (family ? 2 : 0) + tokens.reduce((score, token) => score +
      (hasWord(name, token) ? 4 : 0) + (hasWord(category, token) ? 2 : 0) + (hasWord(description, token) ? 1 : 0), 0)
    if (tokens.length && queryScore === 0) return []
    const vibeScore = vibeTokens.reduce((score, token) => score +
      (hasWord(name, token) ? 3 : 0) + (hasWord(description, token) ? 1 : 0)
      + (hasWord(sourceQuery, token) ? 2 : 0), 0)
    return [{ row, score: queryScore + vibeScore }]
  })
  candidates.sort((a, b) => b.score - a.score
    || (b.row.updated_at ?? '').localeCompare(a.row.updated_at ?? '')
    || a.row.name.localeCompare(b.row.name))
  const seenUrls = new Set<string>()
  const seenNames = new Set<string>()
  const unique = candidates.filter(({ row }) => {
    const name = row.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const url = row.product_url?.toLowerCase() ?? ''
    if (seenNames.has(name) || (url && seenUrls.has(url))) return false
    seenNames.add(name)
    if (url) seenUrls.add(url)
    return true
  })
  return attachMerchantNames(unique.map(({ row }) => row), db)
}

// Used by the cart service to resolve current catalog prices/details for
// items already in a cart — includes unavailable products (a cart shouldn't
// silently drop an item just because the merchant marked it unavailable).
export async function getProductsByIds(
  ids: string[],
  db: SupabaseClient = getSupabaseAdmin(),
): Promise<Map<string, Product>> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return new Map()
  const { data, error } = await db.from('products').select(PRODUCT_COLUMNS).in('id', uniqueIds)
  if (error) throw new Error('Could not load products')
  const products = await attachMerchantNames((data ?? []) as ProductRow[], db)
  return new Map(products.map((product) => [product.id, product]))
}

// The cached productUrl for internet-sourced products is frequently a
// Google Shopping interstitial, not the merchant's real page (see
// internetSearch.ts — same reason run_merchant_checkout and browse_webpage
// resolve it before acting). "View product" needs the same treatment: a
// user clicking through should land on the actual retailer page, not
// Google's aggregator. Resolved lazily on first view, then the resolution
// is written back to products.product_url so later views for the same
// product skip the extra Serper call.
export async function resolveProductViewUrl(
  productId: string,
  db: SupabaseClient = getSupabaseAdmin(),
): Promise<string | null> {
  const { data, error } = await db.from('products').select('name, product_url, merchant_id').eq('id', productId).maybeSingle()
  if (error) throw new Error('Could not look up product')
  const row = data as { name: string; product_url: string | null; merchant_id: string } | null
  if (!row?.product_url) return null
  if (!isGoogleInterstitialUrl(row.product_url)) return row.product_url

  const { data: merchantRow } = await db.from('merchants').select('name').eq('id', row.merchant_id).maybeSingle()
  const merchantName = (merchantRow as { name: string } | null)?.name ?? ''
  const resolved = await resolveDirectProductUrl(`${row.name} ${merchantName}`.trim())
  if (!resolved) return null

  const { error: updateError } = await db.from('products').update({ product_url: resolved }).eq('id', productId)
  if (updateError) console.warn(`[products] Could not cache resolved URL for ${productId}:`, updateError.message)

  return resolved
}
