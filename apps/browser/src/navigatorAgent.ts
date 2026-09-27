import { generateText, tool } from 'ai'
import { z } from 'zod'
import { resolveNavigatorModel } from './provider'
import { PLACEHOLDER_IDENTITY } from './placeholder'

// General e-commerce navigation, not a per-site selector list: the model
// reads a Playwright AI-mode ARIA snapshot (see checkoutFlow.ts) — a text
// accessibility tree with `[ref=eN]` markers — and decides the single next
// action toward checkout. This generalizes past "click the add to cart
// button": a clothing PDP with a required size/color selector, a quantity
// stepper, or a multi-step mini-cart drawer all just show up differently in
// the same tree, and the model's general knowledge of e-commerce covers each
// case instead of a fixed pattern list that must name it in advance.
//
// Uses a forced tool call rather than generateObject/response_format: this
// OpenRouter-fronted model doesn't support native structured outputs
// (confirmed live — response_format silently degrades to free-form JSON with
// no schema enforcement, so field names like `ref` come back as `reference`
// or `element` instead). Tool-calling goes through the standard
// function-calling path instead, which this provider does support reliably
// (the shopping agent's own tools already depend on this working).
const DecisionSchema = z.object({
  action: z.enum(['click', 'select', 'fill', 'goal_reached', 'stuck']).describe(
    'click: activate a button/link. select: choose an option in a dropdown/listbox/radio group (e.g. size, color). fill: type into a text field (e.g. email, name — use the provided placeholder identity, never payment fields). goal_reached: this page already is the checkout/payment step. stuck: no viable next action exists.',
  ),
  ref: z.string().optional().describe('The [ref=eN] of the target element. Required for click/select/fill.'),
  value: z.string().optional().describe('The option/text value for select/fill. Required for those actions.'),
  reasoning: z.string().describe('One short sentence on why this action moves toward checkout.'),
})

export type NavigatorDecision = z.infer<typeof DecisionSchema>

const SYSTEM_PROMPT = `You control a headless browser navigating a single product's page toward checkout. Your only goal: get this exact product into the shopping cart (selecting any required variant first — size, color, style, quantity, etc., using ordinary judgment like a real shopper would: a common size such as "M" or the first in-stock option is fine when the exact preference doesn't matter), then reach the checkout/cart-review step.

You will never see or act on a real payment step — a separate hard-coded check stops the flow before any card-entry page, so if the page in front of you already looks like a payment/billing form, respond "goal_reached" and do nothing else.

If a guest-checkout or shipping form appears, you may fill it using this fixed placeholder identity — never invent real user data, and never fill a card/payment field under any circumstance:
${JSON.stringify(PLACEHOLDER_IDENTITY)}

You are given a Playwright ARIA accessibility snapshot (YAML-like text) of the current page. Each interactive element is tagged with a [ref=eN] you must reference exactly. Decide ONE single next action that makes the most progress by calling the decide_next_action tool. If the page offers nothing useful (e.g. you are blocked, logged out, or the tree has no relevant controls), respond "stuck".

Common obstacles and how to handle them:
- Cookie-consent, newsletter, or promo overlays are usually dismissed automatically before you see this snapshot. If one is still visible anyway, closing/accepting it is always the right next action — it blocks clicks on everything underneath.
- If the previous action is reported as failed below, do not repeat the exact same action — the ref may be stale (elements re-ref after the page changes) or the wrong element entirely. Re-read the current snapshot and pick a different ref or approach.
- Sites vary in wording ("Add to Bag", "Add to Cart", "Add to Basket") and flow (a mini-cart drawer vs. a full cart page vs. an inline quantity stepper) — use the snapshot's actual labels, not a fixed pattern.`

export async function decideNextAction(
  snapshot: string,
  currentUrl: string,
  lastActionResult?: { action: string; ref?: string; success: boolean; detail: string | null },
): Promise<NavigatorDecision> {
  const model = resolveNavigatorModel()
  const lastActionLine = lastActionResult
    ? `Previous action: ${lastActionResult.action}${lastActionResult.ref ? ` on ${lastActionResult.ref}` : ''} — ${lastActionResult.success ? 'succeeded' : `FAILED (${lastActionResult.detail ?? 'no detail'})`}\n\n`
    : ''
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: `${lastActionLine}Current URL: ${currentUrl}\n\nAccessibility snapshot:\n${snapshot}`,
    tools: { decide_next_action: tool({ description: 'Report the single next browser action to take.', inputSchema: DecisionSchema }) },
    toolChoice: { type: 'tool', toolName: 'decide_next_action' },
  })

  const call = result.toolCalls[0]
  if (!call) throw new Error('Navigator model did not call decide_next_action')
  return call.input as NavigatorDecision
}
