export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type LimitsState = {
  items: Limit[]
  measuredAt: number
  /** Why the app's usage data could not be read; null when it was fine. */
  error: string | null
}

export type CacheState = {
  /** When the last main-thread request that refreshed the cache was sent. */
  refreshedAt: number
  model: string
  /** Share of the last request's prompt read from the cache, 0-100. */
  reusePct: number | null
  /** The last request's whole prompt, in tokens. */
  promptTokens: number
  /** Set when something emptied the cache before its TTL ran out. */
  coldReason: string | null
  /** The under-a-minute toast already went out for this refresh. */
  lowWarned: boolean
}

export type TtlSource = 'override' | 'reported' | 'detected' | 'default'

export type Ttl = { ms: number; source: TtlSource; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      limits: Shaped<LimitsState | null>
      cache: Shaped<CacheState | null>
      ttl: Shaped<Ttl | null>
      now: number
      fired: string[]
      showWhy: boolean
    }
  }
}
