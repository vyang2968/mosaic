-- search_products/searchOrchestrator now filter products by ilike '%token%'
-- against name/description/category in SQL instead of scanning the whole
-- available-products table in JS. Trigram indexes let those ilike lookups
-- use an index instead of a sequential scan.
create extension if not exists pg_trgm;

-- One index per column searched via `ilike` (name/description/category are
-- OR'd together as separate per-column conditions, so a single combined
-- expression index wouldn't be usable by the planner).
create index if not exists products_name_trgm_idx on public.products
  using gin (name gin_trgm_ops) where available;
create index if not exists products_description_trgm_idx on public.products
  using gin (description gin_trgm_ops) where available;
create index if not exists products_category_trgm_idx on public.products
  using gin (category gin_trgm_ops) where available;
