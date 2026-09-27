"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  applyCartActions, getCart, getCheckout, getCheckoutProofs, preparePayments, refreshPayments,
  runMerchantCheckout, setCartBudget, shopWithAgent, startCheckout, updateCartItem,
  type Cart, type Checkout, type CheckoutProof,
} from "@/lib/boards/store";

type CartItem = Cart["items"][number];
type Message = { id: number; role: "shopper" | "mosaic"; text: string; products?: CartItem[]; streaming?: boolean };
type LightboxImage = { url: string; alt: string };

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

// Rotates while idle; swaps to a real tool label the instant one is active.
const LOADING_WORDS = [
  "Vibing", "Sensing", "Scouting", "Curating", "Rummaging", "Cross-checking",
  "Noodling", "Percolating", "Sniffing around", "Eyeballing options", "Daydreaming",
  "Window shopping", "Mood-boarding", "Pondering", "Taste-testing", "Digging in",
  "Locking in", "Manifesting", "Vibe-checking", "Glowing up the cart", "Serving looks",
  "Main character energy", "It's giving searching", "Understood the assignment", "Aura farming",
  "Girl-mathing the budget", "Rizzing up options", "No cap, searching", "Cooking something up",
  "Simmering", "Marinating on it", "Brewing", "Untangling threads", "Connecting dots",
  "Piecing it together", "Sketching options", "Shuffling the deck", "Flipping through racks",
  "Thrifting the internet", "Combing the aisles", "Peeking behind the curtain", "Reading the room",
  "Checking vibes", "Tuning in", "Dialing it in", "Fine-tuning", "Zeroing in", "Homing in",
  "Triangulating", "Calibrating", "Syncing up", "Mapping it out", "Charting a course", "Plotting",
  "Scheming (the good kind)", "Conjuring options", "Summoning picks", "Assembling the lineup",
  "Auditioning options", "Casting the net", "Trawling for finds", "Prospecting", "Panning for gold",
  "Treasure hunting", "Sleuthing", "Snooping around", "Nosing about", "On the case",
  "Hot on the trail", "Chasing the drip", "Securing the bag", "Bet, searching",
];
const TOOL_LABELS: Record<string, string> = {
  search_products: "Searching shopping sites",
  browse_webpage: "Reading a product page",
  browse_summary: "Skimming a product page",
  run_merchant_checkout: "Walking through checkout",
  add_item: "Adding to cart",
  remove_item: "Updating cart",
  replace_item: "Swapping items",
  swap_item: "Swapping items",
  lock_item: "Updating cart",
  unlock_item: "Updating cart",
  set_budget: "Updating budget",
};

function AgentActivity({ toolName }: { toolName: string | null }) {
  const [wordIndex, setWordIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setWordIndex((n) => (n + 1) % LOADING_WORDS.length), 2200);
    return () => clearInterval(id);
  }, []);
  const label = toolName ? TOOL_LABELS[toolName] ?? "Working on it" : LOADING_WORDS[wordIndex];
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-stone-600">
      <span className="flex gap-0.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400" />
      </span>
      {label}…
    </span>
  );
}

// No typography plugin installed — map tags to the existing text-sm scale.
const MARKDOWN_COMPONENTS = {
  p: (props: React.ComponentPropsWithoutRef<"p">) => <p className="mb-1 last:mb-0" {...props} />,
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => <ul className="mb-1 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />,
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => <ol className="mb-1 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />,
  a: (props: React.ComponentPropsWithoutRef<"a">) => <a target="_blank" rel="noreferrer" className="underline" {...props} />,
  code: (props: React.ComponentPropsWithoutRef<"code">) => <code className="rounded bg-black/10 px-1 py-0.5 text-xs" {...props} />,
  strong: (props: React.ComponentPropsWithoutRef<"strong">) => <strong className="font-semibold" {...props} />,
};

// Thumbnail opens a lightbox; the rest of the card is a separate link to the
// merchant page — kept as siblings since nesting <a>/<button> is invalid HTML.
function ProductThumb({ item, size = 48, onOpen }: { item: CartItem; size?: number; onOpen?: (image: LightboxImage) => void }) {
  const style = { width: size, height: size };
  if (!item.product?.imageUrl) {
    return <div style={style} className="shrink-0 rounded-lg border border-stone-200 bg-stone-100" aria-hidden="true" />;
  }
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant-hosted URLs, not part of the Next.js image pipeline
    <img src={item.product.imageUrl} alt={item.product.name} style={style} className="shrink-0 rounded-lg border border-stone-200 object-cover" />
  );
  if (!onOpen) return img;
  return (
    <button
      type="button"
      onClick={() => onOpen({ url: item.product!.imageUrl!, alt: item.product!.name })}
      aria-label={`View a larger image of ${item.product.name}`}
      className="shrink-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
    >
      {img}
    </button>
  );
}

// Links through /api/products/[productId]/link (a redirect) instead of the
// item's raw stored productUrl — that's frequently a Google Shopping
// interstitial for internet-sourced products (see internetSearch.ts), not
// the merchant's actual page. The redirect route resolves the real one.
function ProductLink({ productId, hasUrl, className, children }: { productId: string; hasUrl: boolean; className: string; children: React.ReactNode }) {
  if (!hasUrl) return <div className={className}>{children}</div>;
  return <a href={`/api/products/${encodeURIComponent(productId)}/link`} target="_blank" rel="noreferrer" className={`${className} hover:underline`}>{children}</a>;
}

function ImageLightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (image && !dialog.open) dialog.showModal();
    if (!image && dialog.open) dialog.close();
  }, [image]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
      className="max-h-[90vh] max-w-[90vw] rounded-2xl bg-transparent p-0 backdrop:bg-black/70"
    >
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant-hosted URL
        <img src={image.url} alt={image.alt} className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain" />
      )}
    </dialog>
  );
}

export function BoardCommerce({ boardId, vibeName }: { boardId: string; vibeName: string | null }) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [paymentLinks, setPaymentLinks] = useState<Checkout | null>(null);
  const [browserProofs, setBrowserProofs] = useState<Record<string, CheckoutProof>>({});
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [budgetInput, setBudgetInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const returnedFromStripe = new URLSearchParams(window.location.search).has("merchant");
        const latestCheckout = returnedFromStripe ? await refreshPayments(boardId) : await getCheckout(boardId);
        const latestCart = await getCart(boardId);
        if (!active) return;
        setCheckout(latestCheckout);
        setCart(latestCart);
        setBudgetInput(latestCart.budgetCents === null ? "" : String(latestCart.budgetCents / 100));
        // Fetched separately so a failure here can't break cart/checkout loading.
        getCheckoutProofs(boardId)
          .then((proofs) => { if (active) setBrowserProofs(Object.fromEntries(proofs.map((proof) => [proof.productId, proof]))); })
          .catch((cause) => console.error("Could not load checkout proofs:", cause));
        if (returnedFromStripe) {
          window.history.replaceState(window.history.state, "", window.location.pathname);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load shopping state");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [boardId]);

  function report(cause: unknown, fallback: string) {
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function sendToAgent(message: string, displayText = message) {
    if (!message.trim() || busy || cart?.status !== "open") return false;
    const priorItemIds = new Set(cart?.items.map((item) => item.id) ?? []);
    const streamId = Date.now() + 1;
    setMessages((current) => [
      ...current,
      { id: streamId - 1, role: "shopper", text: displayText },
      { id: streamId, role: "mosaic", text: "", streaming: true },
    ]);
    // Cleared immediately, not after the reply — a turn can take 10s+.
    setQuery((current) => current.trim() === message.trim() ? "" : current);
    setBusy("shop");
    setError(null);
    setAgentActivity(null);
    try {
      const result = await shopWithAgent(boardId, message, (event) => {
        if (event.type === "tool-call") {
          setAgentActivity(event.toolName);
        } else if (event.type === "text-delta") {
          setAgentActivity(null);
          setMessages((current) => current.map((m) => m.id === streamId ? { ...m, text: m.text + event.text } : m));
        }
      });
      setCart(result.cart);
      setBudgetInput(result.cart.budgetCents === null ? "" : String(result.cart.budgetCents / 100));
      // Cart items the agent touched this turn — new cart_item ids, even if the productId slot was reused.
      const touchedItems = result.cart.items.filter((item) => !priorItemIds.has(item.id));
      setMessages((current) => current.map((m) => m.id === streamId ? {
        ...m,
        text: result.assistantMessage.trim() || "I reviewed your request. Check the cart for any changes.",
        products: touchedItems.length > 0 ? touchedItems : undefined,
        streaming: false,
      } : m));
      return true;
    } catch (cause) {
      setMessages((current) => current.filter((m) => m.id !== streamId));
      report(cause, "Could not shop for products");
      return false;
    } finally {
      setBusy(null);
      setAgentActivity(null);
    }
  }

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = query.trim();
    if (!message || busy || cart?.status !== "open") return;
    setQuery("");
    const sent = await sendToAgent(message);
    if (!sent) setQuery((current) => current || message);
  }

  async function changeItem(item: Cart["items"][number], action: "lock" | "remove" | "decrease" | "increase") {
    if (!cart || busy || cart.status !== "open") return;
    setBusy(item.id);
    setError(null);
    try {
      if (action === "lock" || action === "remove") {
        const result = await applyCartActions(boardId, [{ type: action === "remove" ? "REMOVE" : item.locked ? "UNLOCK" : "LOCK", productId: item.productId }]);
        setCart(result.cart);
        const failure = result.results.find((entry) => !entry.ok);
        if (failure) throw new Error(failure.error ?? "Could not update item");
      } else {
        const quantity = item.quantity + (action === "increase" ? 1 : -1);
        if (quantity < 1 || quantity > 99) return;
        setCart(await updateCartItem(boardId, item.id, { quantity }));
      }
    } catch (cause) {
      report(cause, "Could not update item");
    } finally {
      setBusy(null);
    }
  }

  async function saveBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart || busy || cart.status !== "open") return;
    const enteredBudget = budgetInput.trim();
    const amount = enteredBudget === "" ? null : Number(enteredBudget);
    if (amount !== null && !/^\d+(?:\.\d{1,2})?$/.test(enteredBudget)) {
      setError("Enter a valid dollar budget with at most two decimal places.");
      return;
    }
    setBusy("budget");
    setError(null);
    try {
      setCart(await setCartBudget(boardId, amount === null ? null : Math.round(amount * 100)));
    } catch (cause) {
      report(cause, "Could not save budget");
    } finally {
      setBusy(null);
    }
  }

  async function beginCheckout() {
    if (!cart || busy || cart.items.length === 0 || cart.status !== "open") return;
    if (cart.remainingCents !== null && cart.remainingCents < 0) {
      setError("This cart is over budget. Update the budget or cart before checkout.");
      return;
    }
    setBusy("checkout");
    setError(null);
    try {
      // 'browser' merchants get the screenshot-proof flow; everything else uses Stripe test-checkout.
      const browserItems = cart.items.filter((item) => item.product?.checkoutMethod === "browser");
      const hasOtherItems = cart.items.some((item) => item.product && item.product.checkoutMethod !== "browser");

      const [proofResults] = await Promise.all([
        Promise.all(browserItems.map((item) => runMerchantCheckout(boardId, item.productId).catch((cause) => {
          report(cause, `Could not run checkout for ${item.product?.name ?? "an item"}`);
          return null;
        }))),
        hasOtherItems ? startCheckout(boardId).then(setCheckout) : Promise.resolve(),
      ]);

      const newProofs = proofResults.filter((proof): proof is CheckoutProof => proof !== null);
      if (newProofs.length > 0) {
        setBrowserProofs((current) => ({ ...current, ...Object.fromEntries(newProofs.map((proof) => [proof.productId, proof])) }));
      }
      setCart(await getCart(boardId));
    } catch (cause) {
      report(cause, "Could not start checkout");
    } finally {
      setBusy(null);
    }
  }

  async function loadPaymentLinks() {
    if (busy) return;
    setBusy("payments");
    setError(null);
    try {
      const prepared = await preparePayments(boardId);
      setCheckout(prepared);
      setPaymentLinks(prepared);
    } catch (cause) {
      report(cause, "Could not prepare test payments");
    } finally {
      setBusy(null);
    }
  }

  async function checkPaymentStatus() {
    if (busy) return;
    setBusy("refresh");
    setError(null);
    try {
      setCheckout(await refreshPayments(boardId));
      setCart(await getCart(boardId));
      setPaymentLinks(null);
    } catch (cause) {
      report(cause, "Could not verify payments");
    } finally {
      setBusy(null);
    }
  }

  const activeCheckout = checkout && (checkout.status !== "completed" || checkout.cartId === cart?.id || cart?.items.length === 0);
  const merchantOrders = checkout?.merchantOrders ?? [];

  return (
    <div className="mt-8 grid gap-6 border-t border-stone-200 pt-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
      <section aria-label="Shopping conversation" className="min-w-0">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-heading text-2xl text-stone-900">Shop this vibe</h2>
            <p className="mt-1 text-sm text-stone-500">{vibeName ? `Inspired by ${vibeName}. ` : ""}Tell Mosaic what you want, and it will add its pick to your cart.</p>
          </div>
        </div>
        <div aria-live="polite" className="mt-4 min-h-32 space-y-3 rounded-2xl border border-stone-200 bg-white/70 p-4">
          {messages.length === 0 && <p className="text-sm text-stone-500">Try “a warm ceramic lamp under $100” or “linen for my room”.</p>}
          {messages.map((message) => (
            <div key={message.id} className={`max-w-[90%] space-y-2 rounded-2xl px-4 py-2 text-sm ${message.role === "shopper" ? "ml-auto bg-stone-900 text-white" : "bg-[#efe4d2] text-stone-800"}`}>
              {message.role === "mosaic" ? (
                message.streaming && !message.text ? (
                  <AgentActivity toolName={agentActivity} />
                ) : (
                  <div>
                    <ReactMarkdown components={MARKDOWN_COMPONENTS}>{message.text}</ReactMarkdown>
                    {message.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-stone-500 align-text-bottom" aria-hidden="true" />}
                  </div>
                )
              ) : (
                <p>{message.text}</p>
              )}
              {message.products?.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-xl bg-white/60 p-2">
                  <ProductThumb item={item} onOpen={setLightboxImage} />
                  <ProductLink productId={item.productId} hasUrl={Boolean(item.product?.productUrl)} className="min-w-0">
                    <p className="truncate font-medium text-stone-900">{item.product?.name ?? "Unavailable product"}</p>
                    <p className="text-xs text-stone-600">{item.product ? money(item.product.priceCents, item.product.currency) : null}</p>
                  </ProductLink>
                </div>
              ))}
            </div>
          ))}
        </div>
        <form onSubmit={(event) => void submitMessage(event)} className="mt-3 flex gap-2">
          <label htmlFor="shopping-message" className="sr-only">Shopping request</label>
          <input id="shopping-message" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What would you like to find?" className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm outline-none focus:border-stone-500" />
          <button type="submit" disabled={loading || Boolean(busy) || !query.trim() || cart?.status !== "open"} className="rounded-xl bg-stone-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-40">{busy === "shop" ? "Shopping…" : "Send"}</button>
        </form>
        <p className="mt-2 text-xs text-stone-500">Mosaic searches shopping sites for products that fit this board. You can adjust or remove items in your cart.</p>
      </section>

      <aside aria-label="Cart and checkout" className="min-w-0 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="font-heading text-2xl text-stone-900">Your cart</h2>
        {loading && <p className="mt-3 text-sm text-stone-500">Loading cart…</p>}
        {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {cart && <>
          <div className="mt-4 space-y-4">
            {cart.items.length === 0 && <p className="text-sm text-stone-500">No items yet. Ask Mosaic what you want to shop for.</p>}
            {cart.items.map((item) => <div key={item.id} className="border-b border-stone-100 pb-4 text-sm">
              <div className="flex gap-3">
                <ProductThumb item={item} size={56} onOpen={setLightboxImage} />
                <ProductLink productId={item.productId} hasUrl={Boolean(item.product?.productUrl)} className="min-w-0 flex-1">
                  <div className="flex justify-between gap-3"><p className="truncate font-medium text-stone-900">{item.product?.name ?? "Unavailable product"}</p><p className="whitespace-nowrap">{money(item.subtotalCents, cart.currency)}</p></div>
                  <p className="mt-1 text-xs text-stone-500">{item.product?.merchantName ?? "Merchant unavailable"}</p>
                </ProductLink>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <button type="button" aria-label={`Decrease ${item.product?.name ?? "item"} quantity`} disabled={Boolean(busy) || item.locked || item.quantity <= 1 || cart.status !== "open"} onClick={() => void changeItem(item, "decrease")} className="rounded border px-2 py-1 disabled:opacity-40">−</button>
                <span>{item.quantity}</span>
                <button type="button" aria-label={`Increase ${item.product?.name ?? "item"} quantity`} disabled={Boolean(busy) || item.locked || item.quantity >= 99 || cart.status !== "open"} onClick={() => void changeItem(item, "increase")} className="rounded border px-2 py-1 disabled:opacity-40">+</button>
                <button type="button" disabled={Boolean(busy) || cart.status !== "open"} onClick={() => void changeItem(item, "lock")} className="ml-1 underline disabled:opacity-40">{item.locked ? "Unlock" : "Lock"}</button>
                <button type="button" disabled={Boolean(busy) || item.locked || cart.status !== "open"} onClick={() => void sendToAgent(`Replace the cart item with productId ${item.productId} with a similar product that fits this board's vibe and budget.`, `Find another option for ${item.product?.name ?? "this item"}.`)} className="underline disabled:opacity-40">Replace</button>
                <button type="button" disabled={Boolean(busy) || item.locked || cart.status !== "open"} onClick={() => void changeItem(item, "remove")} className="underline disabled:opacity-40">Remove</button>
              </div>
              {browserProofs[item.productId] && (() => {
                const proof = browserProofs[item.productId];
                return <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-medium text-stone-900">
                    {proof.success ? "Reached checkout — stopped before payment" : `Checkout attempt: ${proof.stoppedReason.replaceAll("_", " ")}`}
                  </p>
                  {proof.screenshotUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not a static asset
                    <img src={proof.screenshotUrl} alt={`Checkout page reached for ${item.product?.name ?? "this item"}`} className="mt-2 w-full rounded-md border border-stone-200" />
                  )}
                  <a href={proof.finalUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-stone-900 underline">
                    Open this checkout page to enter your info →
                  </a>
                </div>;
              })()}
            </div>)}
          </div>
          <form onSubmit={(event) => void saveBudget(event)} className="mt-3 flex items-end gap-2">
            <label className="flex-1 text-xs text-stone-600">Budget ($)<input inputMode="decimal" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} disabled={cart.status !== "open"} placeholder="Optional" className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" /></label>
            <button type="submit" disabled={Boolean(busy) || cart.status !== "open"} className="rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:opacity-40">Save</button>
          </form>
          <div className="mt-4 flex justify-between border-t border-stone-200 pt-4 font-semibold"><span>Total</span><span>{money(cart.totalCents, cart.currency)}</span></div>
          {cart.budgetCents !== null && <p className={`mt-2 text-sm ${cart.remainingCents !== null && cart.remainingCents < 0 ? "text-red-700" : "text-stone-600"}`}>{cart.remainingCents !== null && cart.remainingCents < 0 ? `${money(-cart.remainingCents)} over budget` : `${money(cart.remainingCents ?? 0)} remaining`}</p>}
        </>}

        {cart && cart.status === "open" && cart.items.length > 0 && <div className="mt-6 rounded-xl bg-[#f8f1e7] p-4">
          <h3 className="font-medium text-stone-900">Review checkout</h3>
          <p className="mt-1 text-xs text-stone-600">Demo-catalog items use Stripe test mode — you approve a separate hosted payment per merchant. Internet-sourced items instead get walked to their real checkout page and stopped right before payment, with a screenshot as proof. No real money moves either way.</p>
          <button type="button" disabled={Boolean(busy)} onClick={() => void beginCheckout()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">
            {busy === "checkout" && <Spinner className="text-white" />}
            {busy === "checkout" ? "Starting…" : "Start checkout"}
          </button>
        </div>}

        {activeCheckout && checkout && <div className="mt-6 border-t border-stone-200 pt-5">
          <h3 className="font-medium text-stone-900">Merchant payments</h3>
          <p className="mt-1 text-xs text-stone-600">{checkout.status === "completed" ? "All test payments verified." : `Checkout total: ${money(checkout.totalCents, checkout.currency)}. Complete each store separately.`}</p>
          <div className="mt-3 space-y-3">
            {merchantOrders.map((order) => {
              const link = paymentLinks?.merchantOrders.find((entry) => entry.merchantId === order.merchantId)?.checkoutUrl;
              const safeLink = link?.startsWith("https://checkout.stripe.com/") ? link : null;
              return <div key={order.id} className="rounded-lg border border-stone-200 p-3 text-sm">
                <div className="flex justify-between gap-3"><span className="font-medium">{order.merchantName}</span><span>{money(order.amountCents, checkout.currency)}</span></div>
                <p className="mt-1 text-xs text-stone-500">{order.paymentStatus === "paid" ? `Paid${order.linkVerified ? " with Link" : ""}` : order.paymentStatus === "failed" ? "Needs retry" : "Awaiting payment"}</p>
                {order.errorMessage && <p className="mt-1 text-xs text-red-700">{order.errorMessage}</p>}
                {order.paymentStatus !== "paid" && safeLink && <a href={safeLink} className="mt-2 inline-block text-xs font-semibold text-stone-900 underline">Pay {money(order.amountCents, checkout.currency)} at {order.merchantName}</a>}
              </div>;
            })}
          </div>
          {checkout.status !== "completed" && <button type="button" disabled={Boolean(busy)} onClick={() => void loadPaymentLinks()} className="mt-3 w-full rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">{busy === "payments" ? "Preparing…" : "Get payment links"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void checkPaymentStatus()} className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-2.5 text-sm disabled:opacity-40">{busy === "refresh" ? "Checking…" : "Refresh payment status"}</button>
        </div>}
      </aside>
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
