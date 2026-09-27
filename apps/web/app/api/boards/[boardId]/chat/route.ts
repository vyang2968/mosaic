import type { ModelMessage } from 'ai'
import { getOrCreateGuest, guestCookie, type GuestSession } from '@/lib/server/guest-session'
import { routeError } from '@/lib/server/http'
import { validationError } from '@/lib/server/errors'
import { runShoppingAgentTurnStream } from '@/lib/ai/shoppingAgent'

export const runtime = 'nodejs'

type Context = { params: Promise<{ boardId: string }> }

// Streams newline-delimited JSON events (ShoppingStreamEvent) instead of one buffered body.
export async function POST(request: Request, { params }: Context) {
  let guest: GuestSession | undefined
  try {
    guest = await getOrCreateGuest(request)
    const { boardId } = await params
    const body = await request.json().catch(() => null)
    const userMessage = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      throw validationError('Request body must be { message: string }')
    }
    const conversationHistory = Array.isArray((body as { conversationHistory?: unknown })?.conversationHistory)
      ? ((body as { conversationHistory: unknown[] }).conversationHistory as ModelMessage[])
      : []

    const guestId = guest.id
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of runShoppingAgentTurnStream({ guestId, boardId, userMessage, conversationHistory })) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          }
        } catch (err) {
          console.error(`[chat-route] stream failed: ${err instanceof Error ? err.stack : String(err)}`)
          const message = err instanceof Error ? err.message : 'Request failed'
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message })}\n`))
        } finally {
          controller.close()
        }
      },
    })

    const headers = new Headers({ 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    if (guest.newToken) headers.set('set-cookie', guestCookie(guest.newToken))
    return new Response(stream, { headers })
  } catch (error) {
    console.error(`[chat-route] request failed: ${error instanceof Error ? error.stack : String(error)}`)
    return routeError(error, guest)
  }
}
