import type { SupabaseClient } from '@supabase/supabase-js'

export type FakeRow = Record<string, unknown>
type QueryResult = { data: unknown; error: { message: string } | null; count?: number }

function ilikeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

class FakeQueryBuilder implements PromiseLike<QueryResult> {
  private predicates: Array<(row: FakeRow) => boolean> = []
  private orderBy: { column: string; ascending: boolean } | undefined
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private payload: FakeRow | FakeRow[] | undefined
  private countOnly = false
  private upsertConflictColumn: string | undefined
  private rowRange: { from: number; to: number } | undefined
  private rowLimit: number | undefined

  constructor(private table: FakeRow[]) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head) this.countOnly = true
    return this
  }

  eq(column: string, value: unknown): this {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  ilike(column: string, pattern: string): this {
    const regExp = ilikeToRegExp(pattern)
    this.predicates.push((row) => regExp.test(String(row[column] ?? '')))
    return this
  }

  or(expression: string): this {
    const clauses = expression.split(',').map((part) => {
      const match = part.match(/^([a-z_]+)\.ilike\.(.+)$/i)
      if (!match) throw new Error(`Unsupported fake Supabase OR clause: ${part}`)
      return { column: match[1], pattern: ilikeToRegExp(match[2]) }
    })
    this.predicates.push((row) => clauses.some(({ column, pattern }) => pattern.test(String(row[column] ?? ''))))
    return this
  }

  lte(column: string, value: number): this {
    this.predicates.push((row) => (row[column] as number) <= value)
    return this
  }

  gte(column: string, value: number | string): this {
    this.predicates.push((row) => typeof value === 'number'
      ? Number(row[column]) >= value
      : String(row[column] ?? '') >= value)
    return this
  }

  contains(column: string, value: Record<string, unknown>): this {
    this.predicates.push((row) => {
      const current = row[column]
      return typeof current === 'object' && current !== null
        && Object.entries(value).every(([key, expected]) => (current as FakeRow)[key] === expected)
    })
    return this
  }

  range(from: number, to: number): this {
    this.rowRange = { from, to }
    return this
  }

  limit(count: number): this {
    this.rowLimit = count
    return this
  }

  in(column: string, values: unknown[]): this {
    const set = new Set(values)
    this.predicates.push((row) => set.has(row[column]))
    return this
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending ?? true }
    return this
  }

  insert(row: FakeRow | FakeRow[]): this {
    this.mode = 'insert'
    this.payload = row
    return this
  }

  upsert(row: FakeRow, options?: { onConflict?: string }): this {
    this.mode = 'upsert'
    this.payload = row
    this.upsertConflictColumn = options?.onConflict
    return this
  }

  update(patch: FakeRow): this {
    this.mode = 'update'
    this.payload = patch
    return this
  }

  delete(): this {
    this.mode = 'delete'
    return this
  }

  private matchedRows(): FakeRow[] {
    return this.table.filter((row) => this.predicates.every((predicate) => predicate(row)))
  }

  private resolve(): QueryResult {
    const now = new Date().toISOString()
    if (this.mode === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload as FakeRow]).map((item) =>
        ({ id: crypto.randomUUID(), created_at: now, updated_at: now, ...item }))
      this.table.push(...rows)
      return { data: Array.isArray(this.payload) ? rows : rows[0], error: null }
    }
    if (this.mode === 'upsert') {
      const payload = this.payload as FakeRow
      const conflictColumn = this.upsertConflictColumn
      const existing = conflictColumn
        ? this.table.find((row) => row[conflictColumn] === payload[conflictColumn])
        : undefined
      if (existing) {
        Object.assign(existing, payload)
        return { data: existing, error: null }
      }
      const row: FakeRow = { id: crypto.randomUUID(), created_at: now, ...payload }
      this.table.push(row)
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      const rows = this.matchedRows()
      for (const row of rows) Object.assign(row, this.payload)
      return { data: rows[0] ?? null, error: null }
    }
    if (this.mode === 'delete') {
      const rows = this.matchedRows()
      for (const row of rows) {
        const index = this.table.indexOf(row)
        if (index >= 0) this.table.splice(index, 1)
      }
      return { data: rows, error: null }
    }
    let rows = this.matchedRows()
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      rows = [...rows].sort((a, b) => {
        const left = a[column] as string | number
        const right = b[column] as string | number
        const direction = left > right ? 1 : left < right ? -1 : 0
        return ascending ? direction : -direction
      })
    }
    if (this.countOnly) return { data: null, error: null, count: rows.length }
    if (this.rowRange) rows = rows.slice(this.rowRange.from, this.rowRange.to + 1)
    if (this.rowLimit !== undefined) rows = rows.slice(0, this.rowLimit)
    return { data: rows, error: null }
  }

  async maybeSingle(): Promise<{ data: FakeRow | null; error: { message: string } | null }> {
    const { data, error } = this.resolve()
    const rows = Array.isArray(data) ? data : data ? [data as FakeRow] : []
    return { data: (rows[0] as FakeRow) ?? null, error }
  }

  async single(): Promise<{ data: FakeRow | null; error: { message: string } | null }> {
    const { data, error } = this.resolve()
    const rows = Array.isArray(data) ? data : data ? [data as FakeRow] : []
    if (!rows[0]) return { data: null, error: error ?? { message: 'No rows found' } }
    return { data: rows[0] as FakeRow, error: null }
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onFulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onFulfilled, onRejected)
  }
}

function createFakeStorage(objects: Map<string, Uint8Array>) {
  return {
    from(bucket: string) {
      return {
        async upload(path: string, bytes: Uint8Array) {
          if (objects.has(path)) return { data: null, error: { message: 'Duplicate' } }
          objects.set(path, bytes)
          return { data: { id: path, path, fullPath: `${bucket}/${path}` }, error: null }
        },
        async remove(paths: string[]) {
          for (const path of paths) objects.delete(path)
          return { data: paths.map((path) => ({ name: path })), error: null }
        },
        async download(path: string) {
          const bytes = objects.get(path)
          return bytes
            ? { data: new Blob([new Uint8Array(bytes)]), error: null }
            : { data: null, error: { message: 'Not found' } }
        },
        async createSignedUrls(paths: string[], expiresIn: number) {
          return {
            data: paths.map((path) => ({
              path,
              error: null,
              signedURL: `/object/sign/${bucket}/${path}?token=fake&expiresIn=${expiresIn}`,
              signedUrl: `https://fake.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=fake`,
            })),
            error: null,
          }
        },
      }
    },
  }
}

export function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const tables: Record<string, FakeRow[]> = {
    boards: seed.boards ?? [],
    board_images: seed.board_images ?? [],
    vibe_profiles: seed.vibe_profiles ?? [],
    merchants: seed.merchants ?? [],
    products: seed.products ?? [],
    carts: seed.carts ?? [],
    cart_items: seed.cart_items ?? [],
    checkout_sessions: seed.checkout_sessions ?? [],
    merchant_orders: seed.merchant_orders ?? [],
    order_items: seed.order_items ?? [],
  }
  const objects = new Map<string, Uint8Array>()

  const client = {
    from(table: string) {
      tables[table] ??= []
      return new FakeQueryBuilder(tables[table])
    },
    storage: createFakeStorage(objects),
  }

  return { client: client as unknown as SupabaseClient, tables, objects }
}
