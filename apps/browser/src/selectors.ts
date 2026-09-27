// Any match trips the hard-stop payment gate (.spec §8). Checked before every
// click in the flow, not just once — a Checkout click can land directly on a
// payment page with no intermediate step.
export const PAYMENT_GATE_SELECTORS = [
  "iframe[src*='stripe' i]",
  "iframe[name*='braintree' i]",
  "iframe[src*='paypal' i]",
  "input[name*='card' i]",
  "input[autocomplete='cc-number']",
  "input[autocomplete='cc-csc']",
]

export const PAYMENT_GATE_BUTTON_TEXT = [
  'Place Order',
  'Pay Now',
  'Complete Purchase',
  'Buy Now',
  'Submit Payment',
]

export const CAPTCHA_TEXT_PATTERNS = [/verify you are human/i, /captcha/i, /are you a robot/i]

// Cookie-consent and newsletter/promo modals are the most common cause of a
// stuck navigator agent: they render on top of the page, intercept the
// click meant for the real element underneath, and the ARIA snapshot alone
// doesn't make "this is blocking you" obvious to the model. Dismissed
// deterministically (no LLM call) before every snapshot instead of relying
// on the model to notice and pick the right close button — known consent
// platforms (OneTrust, Cookiebot, Osano) expose a stable selector; anything
// custom falls back to common accept/close button text.
export const COOKIE_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.CybotCookiebotDialogBodyButtonAccept',
  '#osano-cm-accept-all',
  '[data-testid="cookie-accept"]',
  '[aria-label="Accept cookies" i]',
]

export const COOKIE_CONSENT_BUTTON_TEXT = ['Accept all', 'Accept All Cookies', 'Accept cookies', 'I accept', 'Got it', 'Allow all']

export const DISMISS_MODAL_BUTTON_LABELS = ['Close', 'No thanks', 'Not now', 'Dismiss', 'Maybe later']
