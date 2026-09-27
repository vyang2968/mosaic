const PRODUCT_FAMILIES = [
  { name: 'pants', pattern: /\b(?:pants?|trousers?|jeans?|chinos?|leggings?|joggers?|sweatpants?)\b/i },
  { name: 'shoes', pattern: /\b(?:shoes?|footwear|sneakers?|trainers?|boots?|sandals?|heels?|flats?|loafers?|oxfords?)\b/i },
  { name: 'jackets', pattern: /\b(?:jackets?|coats?|parkas?|blazers?|outerwear|bombers?)\b/i },
  { name: 'shirts', pattern: /\b(?:shirts?|t-shirts?|tees?|blouses?|tops?|sweaters?|hoodies?|sweatshirts?)\b/i },
  { name: 'dresses', pattern: /\b(?:dresses?|gowns?)\b/i },
  { name: 'bags', pattern: /\b(?:bags?|purses?|handbags?|totes?|backpacks?)\b/i },
  { name: 'hats', pattern: /\b(?:hats?|caps?|beanies?)\b/i },
] as const

export type ProductFamily = (typeof PRODUCT_FAMILIES)[number]['name']

export function productFamilyFor(text: string): ProductFamily | null {
  return PRODUCT_FAMILIES.find((family) => family.pattern.test(text))?.name ?? null
}

export function matchesProductFamily(text: string, family: ProductFamily): boolean {
  return PRODUCT_FAMILIES.find((item) => item.name === family)!.pattern.test(text)
}

export function vibeTermsFromProfile(profile: Record<string, unknown> | null): string[] {
  const facets = profile?.facets
  if (!facets || typeof facets !== 'object' || Array.isArray(facets)) return []
  return ['color', 'style', 'material', 'quality', 'shape']
    .flatMap((key) => {
      const values = (facets as Record<string, unknown>)[key]
      return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
    })
    .map((value) => value.replaceAll('_', ' ').trim())
    .filter(Boolean)
}
