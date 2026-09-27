import type { ModelMessage } from "ai";
import type { Board, BoardImage, CreateBoardInput, VibeProfile } from "@/types/board";

type ApiBoard = { id: string; name: string; createdAt: string };
type ApiImage = { id: string; url: string; note: string | null; createdAt: string };
type ApiVibe = {
  name: string;
  description: string | null;
  profile: { facets?: Record<string, unknown> };
};
type ApiBoardDetail = ApiBoard & { images: ApiImage[]; vibeProfile: ApiVibe | null };

export type Product = {
  id: string;
  name: string;
  merchantName: string;
  checkoutMethod: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  productUrl: string | null;
};

export type Cart = {
  id: string;
  boardId: string;
  budgetCents: number | null;
  remainingCents: number | null;
  status: "open" | "checkout" | "completed" | "abandoned";
  items: { id: string; productId: string; quantity: number; locked: boolean; subtotalCents: number; product: Product | null }[];
  totalCents: number;
  currency: string;
};

export type Checkout = {
  id: string;
  boardId: string;
  cartId: string;
  status: string;
  totalCents: number;
  currency: string;
  approvalMode: "hosted_checkout" | "link_cli";
  merchantOrders: {
    id: string;
    merchantId: string;
    merchantName: string;
    amountCents: number;
    paymentStatus: string;
    paymentMethodType: string | null;
    linkVerified: boolean;
    errorMessage: string | null;
    checkoutUrl?: string | null;
  }[];
};

export type CartAction =
  | { type: "LOCK" | "UNLOCK" | "REMOVE" | "ADD"; productId: string }
  | { type: "REPLACE"; removeProductId: string; addProductId: string }
  | { type: "SET_BUDGET"; budgetCents: number | null };

export type ShoppingReply = { assistantMessage: string; cart: Cart; steps: number };

export type CheckoutProof = {
  id: string;
  boardId: string;
  productId: string;
  merchantId: string;
  success: boolean;
  stoppedReason: string;
  finalUrl: string;
  screenshotUrl: string | null;
  steps: { step: string; success: boolean; url: string; detail: string | null }[];
  error: string | null;
  createdAt: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body &&
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function facetTags(facets: Record<string, unknown>, key: string): string[] {
  const value = facets[key];
  const tags = Array.isArray(value) ? value : [value];
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    .map((tag) => tag.replaceAll("_", " "));
}

function mapVibe(vibe: ApiVibe | null): VibeProfile | null {
  if (!vibe) return null;
  const facets = vibe.profile?.facets ?? {};
  return {
    name: vibe.name,
    description: vibe.description,
    colors: ["color", "color_palette", "color_tone"].flatMap((key) => facetTags(facets, key)),
    materials: facetTags(facets, "material"),
    qualities: ["style", "quality", "terrain", "locale", "shape", "style_archetype", "era_mood", "texture_quality", "energy_mood"]
      .flatMap((key) => facetTags(facets, key)),
  };
}

function mapImage(image: ApiImage): BoardImage {
  return {
    id: image.id,
    image_url: image.url,
    note: image.note,
    created_at: image.createdAt,
  };
}

function mapBoard(board: ApiBoardDetail): Board {
  return {
    id: board.id,
    name: board.name,
    images: board.images.map(mapImage),
    vibe: mapVibe(board.vibeProfile),
    created_at: board.createdAt,
  };
}

export async function getBoards(): Promise<Board[]> {
  const { boards } = await request<{ boards: ApiBoard[] }>("/api/boards");
  return Promise.all(boards.map(async (board) => {
    try {
      return await getBoard(board.id);
    } catch {
      return { id: board.id, name: board.name, images: [], vibe: null, created_at: board.createdAt };
    }
  }));
}

export async function getBoard(boardId: string): Promise<Board> {
  const board = await request<ApiBoardDetail>(`/api/boards/${encodeURIComponent(boardId)}`);
  return mapBoard(board);
}

export async function createBoard(input: CreateBoardInput): Promise<Board> {
  const board = await request<ApiBoard>("/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name }),
  });
  try {
    for (const { file, note } of input.images) {
      await uploadImage(board.id, file, note);
    }
  } catch (error) {
    await deleteBoard(board.id).catch(() => undefined);
    throw error;
  }
  return getBoard(board.id);
}

async function uploadImage(boardId: string, file: File, note?: string): Promise<void> {
  const form = new FormData();
  form.set("image", file);
  if (note) form.set("note", note);
  await request(`/api/boards/${encodeURIComponent(boardId)}/images`, { method: "POST", body: form });
}

export async function addImagesToBoard(boardId: string, files: File[]): Promise<void> {
  for (const file of files) await uploadImage(boardId, file);
}

export async function analyzeBoard(boardId: string): Promise<void> {
  await request(`/api/boards/${encodeURIComponent(boardId)}/analyze`, { method: "POST" });
}

export async function previewVibe(boardId: string, scenario: "mediterranean" | "alpine"): Promise<void> {
  await request(`/api/boards/${encodeURIComponent(boardId)}/analyze/mock`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }),
  });
}

export async function deleteBoard(boardId: string): Promise<void> {
  await request(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });
}

export async function searchProducts(query: string, maxPriceCents?: number): Promise<Product[]> {
  const params = new URLSearchParams({ query });
  if (maxPriceCents !== undefined) params.set("maxPrice", String(maxPriceCents));
  const { products } = await request<{ products: Product[] }>(`/api/products/search?${params}`);
  return products;
}

export type ShoppingStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string }
  | { type: "done"; assistantMessage: string; cart: Cart; steps: number; conversationHistory: ModelMessage[] }
  | { type: "error"; message: string };

// Per-board turn history (assistant text + tool calls/results), kept in
// memory only — sent back to the chat route on every turn so the model can
// resolve references like "add 1" or "yes" to what it said/did earlier.
// Without this, each turn looked like the start of a brand new conversation.
const conversationHistories = new Map<string, ModelMessage[]>();

// The chat route streams newline-delimited JSON; onEvent drives live text and an activity indicator.
export async function shopWithAgent(
  boardId: string,
  message: string,
  onEvent?: (event: ShoppingStreamEvent) => void,
): Promise<ShoppingReply> {
  const conversationHistory = conversationHistories.get(boardId) ?? [];
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationHistory }),
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => null);
    const fallback = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(fallback);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ShoppingReply | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      const event = JSON.parse(line) as ShoppingStreamEvent;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") {
        conversationHistories.set(boardId, event.conversationHistory);
        result = { assistantMessage: event.assistantMessage, cart: event.cart, steps: event.steps };
      } else onEvent?.(event);
    }
  }
  if (!result) throw new Error("Agent stream ended without a result");
  return result;
}

const inFlightCarts = new Map<string, Promise<Cart>>();

export function getCart(boardId: string): Promise<Cart> {
  const existing = inFlightCarts.get(boardId);
  if (existing) return existing;
  const pending = request<Cart>(`/api/boards/${encodeURIComponent(boardId)}/cart`)
    .finally(() => inFlightCarts.delete(boardId));
  inFlightCarts.set(boardId, pending);
  return pending;
}

export async function addCartItem(boardId: string, productId: string): Promise<Cart> {
  return request<Cart>(`/api/boards/${encodeURIComponent(boardId)}/cart/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId, quantity: 1 }),
  });
}

export async function updateCartItem(boardId: string, itemId: string, patch: { quantity?: number; locked?: boolean }): Promise<Cart> {
  return request<Cart>(`/api/boards/${encodeURIComponent(boardId)}/cart/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  });
}

export async function removeCartItem(boardId: string, itemId: string): Promise<Cart> {
  return request<Cart>(`/api/boards/${encodeURIComponent(boardId)}/cart/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export async function setCartBudget(boardId: string, budgetCents: number | null): Promise<Cart> {
  return request<Cart>(`/api/boards/${encodeURIComponent(boardId)}/cart`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetCents }),
  });
}

export async function applyCartActions(boardId: string, actions: CartAction[]): Promise<{ cart: Cart; results: { type: string; ok: boolean; error?: string }[] }> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/cart/actions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions }),
  });
}

export async function getCheckout(boardId: string): Promise<Checkout | null> {
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/checkout`, { cache: "no-store" });
  if (response.status === 404) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body as Checkout;
}

export async function startCheckout(boardId: string): Promise<Checkout> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/checkout`, { method: "POST" });
}

export async function preparePayments(boardId: string): Promise<Checkout> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/checkout/payments`, { method: "POST" });
}

export async function refreshPayments(boardId: string): Promise<Checkout> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/checkout/payments`);
}

export async function getCheckoutProofs(boardId: string): Promise<CheckoutProof[]> {
  const { proofs } = await request<{ proofs: CheckoutProof[] }>(`/api/boards/${encodeURIComponent(boardId)}/checkout/proof`);
  return proofs;
}

export async function runMerchantCheckout(boardId: string, productId: string): Promise<CheckoutProof> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/checkout/proof`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId }),
  });
}
