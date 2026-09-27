import type { Page } from 'playwright'
import { COOKIE_CONSENT_BUTTON_TEXT, COOKIE_CONSENT_SELECTORS, DISMISS_MODAL_BUTTON_LABELS } from './selectors'

const CLICK_TIMEOUT_MS = 1_500

// Best-effort, deterministic dismissal of cookie-consent/newsletter/promo
// overlays — run before every navigator-agent snapshot so the model isn't
// spending a decision step (and a repeated-action budget slot) on a popup
// that a fixed selector list already knows how to close. Never throws: a
// missing overlay is the common case, not a failure.
export async function dismissCommonOverlays(page: Page): Promise<void> {
  for (const selector of COOKIE_CONSENT_SELECTORS) {
    const button = page.locator(selector).first()
    if (await button.count().catch(() => 0)) {
      await button.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {})
    }
  }

  for (const text of [...COOKIE_CONSENT_BUTTON_TEXT, ...DISMISS_MODAL_BUTTON_LABELS]) {
    const button = page.getByRole('button', { name: text, exact: false }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {})
    }
  }
}
