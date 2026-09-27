import { afterEach, expect, test } from 'bun:test'
import { analyzeBoard, applyCartActions, createBoard, deleteBoard, getBoards, getCart, getCheckout, preparePayments, previewVibe, refreshPayments, searchProducts, setCartBudget, shopWithAgent, startCheckout } from '../lib/boards/store'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('board UI creates a saved board, uploads images, and reads the real vibe profile', async () => {
  const calls: string[] = []
  let analyzed = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    calls.push(`${init?.method ?? 'GET'} ${path}`)

    if (path === '/api/boards' && init?.method === 'POST') {
      return Response.json({ id: 'board-1', name: 'Warm room', createdAt: '2026-09-26T00:00:00Z' }, { status: 201 })
    }
    if (path === '/api/boards/board-1/images' && init?.method === 'POST') {
      expect(init.body).toBeInstanceOf(FormData)
      expect((init.body as FormData).get('image')).toBeInstanceOf(File)
      return Response.json({ id: 'image-1' }, { status: 201 })
    }
    if (path === '/api/boards/board-1/analyze' && init?.method === 'POST') {
      analyzed = true
      return Response.json({ vibeProfile: { name: 'Cozy room' } })
    }
    if (path === '/api/boards') {
      return Response.json({ boards: [{ id: 'board-1', name: 'Warm room', createdAt: '2026-09-26T00:00:00Z' }] })
    }
    if (path === '/api/boards/board-1') {
      return Response.json({
        id: 'board-1', name: 'Warm room', createdAt: '2026-09-26T00:00:00Z',
        images: [{ id: 'image-1', url: 'https://storage.example/image', note: null, createdAt: '2026-09-26T00:00:00Z' }],
        vibeProfile: analyzed ? {
          name: 'Cozy room', description: 'Warm natural textures',
          profile: { facets: { color: ['amber', 'cream'], material: ['wood'], quality: ['cozy'] } },
        } : null,
      })
    }
    throw new Error(`Unexpected request: ${path}`)
  }) as typeof fetch

  const board = await createBoard({
    name: 'Warm room',
    images: [{ file: new File(['image'], 'inspiration.png', { type: 'image/png' }) }],
  })
  expect(board.images[0]?.image_url).toBe('https://storage.example/image')
  expect(board.vibe).toBeNull()

  await analyzeBoard(board.id)
  const [refreshed] = await getBoards()
  expect(refreshed.vibe?.name).toBe('Cozy room')
  expect(refreshed.vibe?.colors).toEqual(['amber', 'cream'])
  expect(refreshed.vibe?.materials).toEqual(['wood'])
  expect(calls).toEqual([
    'POST /api/boards',
    'POST /api/boards/board-1/images',
    'GET /api/boards/board-1',
    'POST /api/boards/board-1/analyze',
    'GET /api/boards',
    'GET /api/boards/board-1',
  ])
})

test('shopping UI calls catalog, cart action, and hosted checkout routes', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.startsWith('/api/products/search')) {
      expect(new URLSearchParams(path.split('?')[1]).get('maxPrice')).toBe('30000')
      return Response.json({ products: [{ id: 'lamp', name: 'Lamp' }] })
    }
    if (path.endsWith('/cart/actions')) {
      expect(JSON.parse(String(init?.body))).toEqual({ actions: [{ type: 'LOCK', productId: 'lamp' }] })
      return Response.json({ results: [{ type: 'LOCK', ok: true }], cart: { totalCents: 5500 } })
    }
    if (path.endsWith('/cart')) {
      expect(JSON.parse(String(init?.body))).toEqual({ budgetCents: 30000 })
      return Response.json({ totalCents: 5500, budgetCents: 30000 })
    }
    if (path.endsWith('/checkout/payments')) return Response.json({ id: 'checkout-1', status: 'partial', merchantOrders: [] })
    if (path.endsWith('/checkout') && init?.method === 'POST') return Response.json({ id: 'checkout-1', status: 'approved', merchantOrders: [] })
    if (path.endsWith('/checkout')) return Response.json({ id: 'checkout-1', status: 'approved', merchantOrders: [] })
    throw new Error(`Unexpected request: ${path}`)
  }) as typeof fetch

  expect(await searchProducts('warm lamp', 30000)).toHaveLength(1)
  expect((await setCartBudget('board-1', 30000)).budgetCents).toBe(30000)
  expect((await applyCartActions('board-1', [{ type: 'LOCK', productId: 'lamp' }])).results[0].ok).toBe(true)
  expect((await startCheckout('board-1')).id).toBe('checkout-1')
  expect((await getCheckout('board-1'))?.id).toBe('checkout-1')
  expect((await preparePayments('board-1')).status).toBe('partial')
  expect((await refreshPayments('board-1')).status).toBe('partial')
  expect(calls).toEqual([
    'GET /api/products/search?query=warm+lamp&maxPrice=30000',
    'PATCH /api/boards/board-1/cart',
    'POST /api/boards/board-1/cart/actions',
    'POST /api/boards/board-1/checkout',
    'GET /api/boards/board-1/checkout',
    'POST /api/boards/board-1/checkout/payments',
    'GET /api/boards/board-1/checkout/payments',
  ])
})

test('simultaneous UI cart loads share one request', async () => {
  let calls = 0
  let complete!: (response: Response) => void
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/boards/board-concurrent/cart')
    calls += 1
    return new Promise<Response>((resolve) => { complete = resolve })
  }) as typeof fetch

  const first = getCart('board-concurrent')
  const second = getCart('board-concurrent')
  expect(calls).toBe(1)
  complete(Response.json({ id: 'cart-1', items: [], totalCents: 0 }))
  expect((await first).id).toBe('cart-1')
  expect((await second).id).toBe('cart-1')
})

test('sample vibe UI calls the board mock analysis route', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/boards/board-1/analyze/mock')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ scenario: 'alpine' })
    return Response.json({ vibeProfile: { name: 'Alpine' } })
  }) as typeof fetch

  await previewVibe('board-1', 'alpine')
})

test('shopping conversation sends one request and receives an updated cart', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/boards/board-1/chat')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'Find a warm lamp under $100', conversationHistory: [] })
    // The chat route streams newline-delimited JSON events, not one buffered
    // body — see shoppingAgent.ts's runShoppingAgentTurnStream.
    const events = [
      { type: 'tool-call', toolName: 'search_products' },
      { type: 'text-delta', text: 'Added a ' },
      { type: 'text-delta', text: 'lamp.' },
      {
        type: 'done',
        assistantMessage: 'Added a lamp.',
        cart: { items: [{ productId: 'lamp' }], totalCents: 5500 },
        steps: 3,
        conversationHistory: [{ role: 'user', content: 'Find a warm lamp under $100' }],
      },
    ]
    const body = events.map((event) => `${JSON.stringify(event)}\n`).join('')
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
  }) as typeof fetch

  const streamed: string[] = []
  const reply = await shopWithAgent('board-1', 'Find a warm lamp under $100', (event) => {
    if (event.type === 'text-delta') streamed.push(event.text)
  })
  expect(streamed.join('')).toBe('Added a lamp.')
  expect(reply.assistantMessage).toBe('Added a lamp.')
  expect(reply.cart.items[0].productId).toBe('lamp')
})

test('board deletion calls the guest-scoped delete route', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/boards/board-1')
    expect(init?.method).toBe('DELETE')
    return Response.json({ ok: true })
  }) as typeof fetch

  await deleteBoard('board-1')
})

test('one failed board detail does not hide the other boards', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/boards') return Response.json({ boards: [
      { id: 'good', name: 'Good board', createdAt: '2026-09-27T00:00:00Z' },
      { id: 'broken', name: 'Broken board', createdAt: '2026-09-27T00:00:00Z' },
    ] })
    if (path === '/api/boards/good') return Response.json({ id: 'good', name: 'Good board', createdAt: '2026-09-27T00:00:00Z', images: [], vibeProfile: null })
    if (path === '/api/boards/broken') return Response.json({ error: 'Could not sign an image' }, { status: 502 })
    throw new Error(`Unexpected request: ${path}`)
  }) as typeof fetch

  const boards = await getBoards()
  expect(boards.map((board) => board.name)).toEqual(['Good board', 'Broken board'])
  expect(boards[1].images).toEqual([])
})
