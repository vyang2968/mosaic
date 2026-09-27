import { expect, test } from 'bun:test'
import { searchProducts } from '../lib/server/products'
import { createFakeSupabase } from './support/fake-supabase'

const MERCHANT_A = { id: 'merchant-a', slug: 'sol-and-clay', name: 'Sol & Clay' }
const MERCHANT_B = { id: 'merchant-b', slug: 'north-loom', name: 'North Loom' }

function seedCatalog() {
  return createFakeSupabase({
    merchants: [MERCHANT_A, MERCHANT_B],
    products: [
      {
        id: 'p1',
        merchant_id: 'merchant-a',
        name: 'Ceramic Bedside Lamp',
        description: 'Warm ceramic lamp.',
        category: 'lighting',
        price_cents: 5500,
        currency: 'usd',
        image_url: null,
        product_url: 'https://example.com/lamp',
        available: true,
      },
      {
        id: 'p2',
        merchant_id: 'merchant-b',
        name: 'Natural Wood Side Table',
        description: 'Round side table.',
        category: 'furniture',
        price_cents: 8900,
        currency: 'usd',
        image_url: null,
        product_url: 'https://example.org/table',
        available: true,
      },
      {
        id: 'p3',
        merchant_id: 'merchant-b',
        name: 'Discontinued Rug',
        description: 'No longer sold.',
        category: 'textiles',
        price_cents: 12000,
        currency: 'usd',
        image_url: null,
        product_url: 'https://example.org/rug',
        available: false,
      },
    ],
  })
}

test('searchProducts returns available products with merchant names, sorted by name', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({}, client)
  expect(products.map((p) => p.name)).toEqual(['Ceramic Bedside Lamp', 'Natural Wood Side Table'])
  expect(products.find((p) => p.id === 'p1')?.merchantName).toBe('Sol & Clay')
  expect(products.find((p) => p.id === 'p2')?.merchantName).toBe('North Loom')
})

test('searchProducts excludes unavailable products', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({}, client)
  expect(products.some((p) => p.id === 'p3')).toBe(false)
})

test('searchProducts filters by category case-insensitively', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({ category: 'Lighting' }, client)
  expect(products).toHaveLength(1)
  expect(products[0].id).toBe('p1')
})

test('searchProducts filters by maxPriceCents', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({ maxPriceCents: 6000 }, client)
  expect(products.map((p) => p.id)).toEqual(['p1'])
})

test('searchProducts filters by a case-insensitive query substring on name', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({ query: 'wood' }, client)
  expect(products.map((p) => p.id)).toEqual(['p2'])
})

test('searchProducts retrieves candidates from a multi-word vibe query', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({ query: 'warm Mediterranean ceramic lamp' }, client)
  expect(products.map((p) => p.id)).toEqual(['p1'])
})

test('searchProducts returns an empty array when nothing matches', async () => {
  const { client } = seedCatalog()
  const products = await searchProducts({ category: 'gifts' }, client)
  expect(products).toEqual([])
})

test('searchProducts separates clothing types and ranks the board vibe', async () => {
  const { client } = createFakeSupabase({
    merchants: [MERCHANT_A],
    products: [
      { id: 'gray-pants', merchant_id: MERCHANT_A.id, name: 'Gray Foldover Pants', category: 'pants' },
      { id: 'black-boots', merchant_id: MERCHANT_A.id, name: 'Black Leather Boots', category: 'shoes' },
      { id: 'green-boots', merchant_id: MERCHANT_A.id, name: 'Green Hiking Boots', category: 'shoes' },
    ].map((row) => ({ ...row, description: '', price_cents: 5000, currency: 'usd', image_url: null, product_url: null, available: true })),
  })
  const greenShoes = await searchProducts({ query: 'shoes', vibeTerms: ['green', 'outdoorsy'] }, client)
  expect(greenShoes.map((item) => item.id)).toEqual(['green-boots', 'black-boots'])
  const pants = await searchProducts({ query: 'pants' }, client)
  expect(pants.map((item) => item.id)).toEqual(['gray-pants'])
})

test('searchProducts includes products beyond the first 1,000 rows', async () => {
  const { client } = createFakeSupabase({
    merchants: [MERCHANT_A],
    products: [
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `lamp-${index}`, merchant_id: MERCHANT_A.id, name: `A Lamp ${index.toString().padStart(4, '0')}`,
        description: '', category: 'lighting', price_cents: 3000, currency: 'usd', image_url: null, product_url: null, available: true,
      })),
      { id: 'late-shoe', merchant_id: MERCHANT_A.id, name: 'Z Green Running Shoes', description: '', category: 'shoes', price_cents: 4500, currency: 'usd', image_url: null, product_url: null, available: true },
    ],
  })
  const products = await searchProducts({ query: 'shoes' }, client)
  expect(products.map((item) => item.id)).toEqual(['late-shoe'])
})

test('searchProducts prefers the current board search over another board with the same item type', async () => {
  const { client } = createFakeSupabase({
    merchants: [MERCHANT_A],
    products: [
      { id: 'alpine', name: 'Trail Boots', metadata: { query: 'pine green shoes||' } },
      { id: 'academic', name: 'Leather Loafers', metadata: { query: 'warm gray shoes||' } },
    ].map((row) => ({ ...row, merchant_id: MERCHANT_A.id, description: '', category: 'shoes', price_cents: 5000,
      currency: 'usd', image_url: null, product_url: null, available: true })),
  })
  const alpine = await searchProducts({ query: 'shoes', vibeTerms: ['pine green'] }, client)
  const academic = await searchProducts({ query: 'shoes', vibeTerms: ['warm gray'] }, client)
  expect(alpine[0].id).toBe('alpine')
  expect(academic[0].id).toBe('academic')
})

test('searchProducts deduplicates repeated cached web listings', async () => {
  const { client } = createFakeSupabase({
    merchants: [MERCHANT_A],
    products: ['old', 'new'].map((id) => ({
      id, merchant_id: MERCHANT_A.id, name: 'Green Running Shoes', description: '', category: 'shoes',
      price_cents: 4500, currency: 'usd', image_url: null, product_url: 'https://shop.example/shoes', available: true,
      updated_at: id === 'new' ? '2026-09-27T12:00:00Z' : '2026-09-26T12:00:00Z',
    })),
  })
  const products = await searchProducts({ query: 'shoes' }, client)
  expect(products.map((item) => item.id)).toEqual(['new'])
})
