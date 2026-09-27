import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import { getCart } from '@/lib/server/cart'
import { getVibeProfile } from '@/lib/server/vibe-profile'
import { runAgentTurn, runAgentTurnStream } from './harness'
import { resolveAgentModel, type AgentModelConfig } from './providers'
import { createShoppingTools } from './tools/shoppingTools'

// The concrete shopping agent: harness.ts's generic loop + the shopping tool set + this system prompt.
const SYSTEM_PROMPT = `You are Mosaic's shopping agent. You help the user build a cart of products that match their board's aesthetic (its "vibe profile") and their budget.

Rules:
- You decide *what* the cart should contain. The cart engine (via your tools) decides *whether and how* — trust its results, don't assume an action succeeded just because you called it.
- When the user asks you to shop for or find products, search the catalog, choose the best matching available product for each requested item, and add it to the cart in this turn. Do not ask the user to pick from search results or stop after listing options.
- If the requested item is already in the cart, do not add a duplicate. Explain what is already there or choose another requested item.
- Prefer the board's vibe profile when choosing what to search for, but follow explicit user requests over the vibe profile when they conflict.
- Locked items must not be removed or replaced — if a removal fails because the item is locked, tell the user instead of retrying.
- When the user wants to replace something already in the cart ("swap this out", "show me something else"), use swap_item first — it reuses close candidates from the original search instead of a fresh one. Only fall back to search_products + replace_item if swap_item reports no alternatives left.
- Always try search_products (or swap_item) before asking the user a clarifying question. If the user refers back to something you listed earlier ("add 1", "the grey one", "that sweatshirt") and you no longer have its productId in context, re-run search_products with the same terms to recover it instead of asking the user to repeat themselves — you have the full conversation history, use it to figure out what they mean.
- Respect the budget if one is set. If you can't find something that fits, say so rather than adding something over budget.
- If nothing in the catalog is a good match, say so rather than adding a weak match just to have added something.
- Use browse_webpage to navigate to product pages (from search_products results) when you need to check details, reviews, availability, or descriptions that aren't in the search snippet. Use browse_summary for a quicker overview with just the title and price.
- Keep your final reply short and concrete: what changed and why.`

export type ShoppingAgentTurnInput = {
  guestId: string
  boardId: string
  userMessage: string
  conversationHistory?: ModelMessage[]
  model?: AgentModelConfig
}

export type ShoppingAgentTurnResult = {
  assistantMessage: string
  cart: Awaited<ReturnType<typeof getCart>>
  steps: number
  conversationHistory: ModelMessage[]
}

// Caps how much prior history is replayed each turn — bounds token usage
// without needing real summarization for this catalog's conversation lengths.
const MAX_HISTORY_MESSAGES = 40

// Shared setup for the buffered and streaming entry points below.
async function prepareShoppingTurn(input: ShoppingAgentTurnInput): Promise<{
  model: LanguageModel
  tools: ToolSet
  messages: ModelMessage[]
  priorHistory: ModelMessage[]
}> {
  const { guestId, boardId, userMessage, conversationHistory = [], model } = input
  const priorHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES)

  const [vibeProfile, cart] = await Promise.all([
    getVibeProfile(guestId, boardId).catch(() => null),
    getCart(guestId, boardId),
  ])

  // Search cache is populated lazily by search_products on a cache miss
  // (shoppingTools.ts) instead of eagerly here — an eager call ran this
  // (LLM query-gen + possible internet search) on every turn, including
  // replace/swap_item turns that never touch search at all.
  const vibePhrase = (vibeProfile?.profile as { phrase?: unknown } | undefined)?.phrase ?? null
  console.log(
    `[shopping-agent] context loaded: vibePhrase=${JSON.stringify(vibePhrase)} cartItems=${cart.items.length} budgetCents=${cart.budgetCents}`,
  )

  const contextMessage: ModelMessage = {
    role: 'user',
    content: [
      'Current board/cart context (read-only, for your reasoning — not something the user typed):',
      JSON.stringify({ vibeProfile: vibeProfile?.profile ?? null, cart }, null, 2),
    ].join('\n'),
  }

  const userTurnMessage: ModelMessage = { role: 'user', content: userMessage }
  const messages: ModelMessage[] = [contextMessage, ...priorHistory, userTurnMessage]

  return { model: resolveAgentModel(model), tools: createShoppingTools(guestId, boardId), messages, priorHistory }
}

// contextMessage is rebuilt fresh each turn from live cart/vibe state, so it's
// excluded from the history handed back to the caller — only the user
// message and the model's own response (text + tool calls/results) persist.
function nextHistory(priorHistory: ModelMessage[], userTurnMessage: ModelMessage, responseMessages: ModelMessage[]): ModelMessage[] {
  return [...priorHistory, userTurnMessage, ...responseMessages].slice(-MAX_HISTORY_MESSAGES)
}

export async function runShoppingAgentTurn(input: ShoppingAgentTurnInput): Promise<ShoppingAgentTurnResult> {
  const { guestId, boardId, userMessage } = input
  console.log(`[shopping-agent] turn start: boardId=${boardId} message=${JSON.stringify(userMessage)}`)

  const { model, tools, messages, priorHistory } = await prepareShoppingTurn(input)
  const result = await runAgentTurn({ model, tools, system: SYSTEM_PROMPT, messages })

  const updatedCart = await getCart(guestId, boardId)
  console.log(
    `[shopping-agent] turn done: steps=${result.steps} finalCartItems=${updatedCart.items.length} reply=${JSON.stringify(result.assistantMessage)}`,
  )
  return {
    assistantMessage: result.assistantMessage,
    cart: updatedCart,
    steps: result.steps,
    conversationHistory: nextHistory(priorHistory, { role: 'user', content: userMessage }, result.responseMessages),
  }
}

export type ShoppingStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'done'; assistantMessage: string; cart: Awaited<ReturnType<typeof getCart>>; steps: number; conversationHistory: ModelMessage[] }

export async function* runShoppingAgentTurnStream(input: ShoppingAgentTurnInput): AsyncGenerator<ShoppingStreamEvent> {
  const { guestId, boardId, userMessage } = input
  console.log(`[shopping-agent] stream turn start: boardId=${boardId} message=${JSON.stringify(userMessage)}`)

  const { model, tools, messages, priorHistory } = await prepareShoppingTurn(input)

  for await (const event of runAgentTurnStream({ model, tools, system: SYSTEM_PROMPT, messages })) {
    if (event.type === 'done') {
      const updatedCart = await getCart(guestId, boardId)
      console.log(
        `[shopping-agent] stream turn done: steps=${event.steps} finalCartItems=${updatedCart.items.length} reply=${JSON.stringify(event.assistantMessage)}`,
      )
      yield {
        type: 'done',
        assistantMessage: event.assistantMessage,
        cart: updatedCart,
        steps: event.steps,
        conversationHistory: nextHistory(priorHistory, { role: 'user', content: userMessage }, event.responseMessages),
      }
    } else {
      yield event
    }
  }
}
