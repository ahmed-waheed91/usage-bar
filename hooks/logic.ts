// Pure logic for the usage bar: no `$`, so tests can call it directly.

import type { CacheState, Limit, Ttl } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DEFAULT_TTL_MS = HOUR

// Durations a provider is likely to pick. Detection snaps to these, but any
// duration the app reports or the person sets is used as given.
const CANDIDATES_MS = [5, 10, 15, 30, 60, 120, 360, 720, 1440].map(m => m * MINUTE)

// A miss sooner than this says nothing about the TTL: something else
// (an edit to CLAUDE.md, a new tool) changed the prompt.
const MIN_MISS_EVIDENCE_MS = 2 * MINUTE

/** "5m", "1h", "1h30m", "90s", "2d", "300" (seconds), "PT1H". Null if unreadable. */
export function parseDuration(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text * 1000 : null
  if (typeof text !== 'string') return null
  let s = text.trim().toLowerCase()
  if (s === '') return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000
  s = s.replace(/^pt?/, '')
  const units: Record<string, number> = { ms: 1, s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR }
  let total = 0
  let rest = s
  const part = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/
  while (rest.length > 0) {
    const m = part.exec(rest)
    if (m === null) return null
    total += Number(m[1]) * (units[m[2] as string] ?? 0)
    rest = rest.slice(m[0].length).trim()
  }
  return total > 0 ? total : null
}

export type NormalizedLimits = { items: Limit[]; error: string | null }

/** Checks the app's rate-limit data; anything off becomes an error, never a guess. */
export function normalizeLimits(raw: unknown): NormalizedLimits {
  if (!Array.isArray(raw)) {
    return { items: [], error: `rateLimits is ${raw === null ? 'null' : typeof raw}, not a list` }
  }
  const items: Limit[] = []
  let bad = 0
  for (const r of raw) {
    const o = r as Record<string, unknown> | null
    if (o === null || typeof o !== 'object' || typeof o.kind !== 'string' || typeof o.percentUsed !== 'number' || !Number.isFinite(o.percentUsed)) {
      bad += 1
      continue
    }
    const limit: Limit = { kind: o.kind, percentUsed: o.percentUsed }
    if (typeof o.resetsAt === 'string' && Number.isFinite(Date.parse(o.resetsAt))) limit.resetsAt = o.resetsAt
    items.push(limit)
  }
  const error = bad > 0 ? `${bad} of ${raw.length} limit entries had an unexpected shape` : null
  return { items: sortLimits(items), error }
}

const KNOWN_ORDER = ['five_hour', 'seven_day']

function sortLimits(items: Limit[]): Limit[] {
  const rank = (k: string) => {
    const i = KNOWN_ORDER.indexOf(k)
    return i === -1 ? KNOWN_ORDER.length : i
  }
  return [...items].sort((a, b) => rank(a.kind) - rank(b.kind))
}

const KNOWN_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
  spend_limit: 'Spend',
}

/** A short label for any limit kind, known or not. */
export function labelFor(kind: string): string {
  const known = KNOWN_LABELS[kind]
  if (known !== undefined) return known
  const words = kind.replace(/[_-]+/g, ' ').trim()
  return words.length === 0 ? '?' : words[0]!.toUpperCase() + words.slice(1)
}

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

/** Checks one response's usage; null when any count is missing or not a number. */
export function readUsage(raw: unknown): StepUsage | null {
  const o = raw as Record<string, unknown> | null
  if (o === null || typeof o !== 'object') return null
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
  for (const k of keys) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return null
  }
  return {
    input_tokens: o.input_tokens as number,
    output_tokens: o.output_tokens as number,
    cache_read_input_tokens: o.cache_read_input_tokens as number,
    cache_creation_input_tokens: o.cache_creation_input_tokens as number,
    model: typeof o.model === 'string' ? o.model : 'unknown',
  }
}

export function promptTokens(u: StepUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

export function reusePct(u: StepUsage): number | null {
  const total = promptTokens(u)
  return total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null
}

export type Outcome = 'hit' | 'miss' | 'unclear'

/**
 * Whether the previous request's prompt was still cached. Compared against
 * the previous prompt, not this one, so a shared system prompt cached by
 * another session can't pass for this conversation's cache.
 */
export function classify(u: StepUsage, previousPromptTokens: number): Outcome {
  if (previousPromptTokens <= 0) return 'unclear'
  const read = u.cache_read_input_tokens
  if (read >= 0.8 * previousPromptTokens) return 'hit'
  if (read < 0.5 * previousPromptTokens && u.cache_creation_input_tokens > 0) return 'miss'
  return 'unclear'
}

export type Evidence = {
  /** Longest gap after which the cache was still warm. */
  maxHitMs: number
  /** Shortest gap after which it had gone cold; null while none seen. */
  minMissMs: number | null
  /** TTL the app reported at a model switch, and when. */
  reportedMs: number | null
  reportedAt: number | null
}

export const NO_EVIDENCE: Evidence = { maxHitMs: 0, minMissMs: null, reportedMs: null, reportedAt: null }

export function readEvidence(raw: unknown): Evidence {
  const o = raw as Record<string, unknown> | null
  if (o === null || typeof o !== 'object') return NO_EVIDENCE
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  return {
    maxHitMs: num(o.maxHitMs) ?? 0,
    minMissMs: num(o.minMissMs),
    reportedMs: num(o.reportedMs),
    reportedAt: num(o.reportedAt),
  }
}

/** Folds one observation in; contradicting evidence is dropped, not averaged. */
export function addEvidence(ev: Evidence, gapMs: number, outcome: Outcome): Evidence {
  if (outcome === 'hit') {
    const maxHitMs = Math.max(ev.maxHitMs, gapMs)
    // Warm after a gap we thought was too long: the old miss was an early eviction.
    const minMissMs = ev.minMissMs !== null && gapMs >= ev.minMissMs ? null : ev.minMissMs
    return { ...ev, maxHitMs, minMissMs }
  }
  if (outcome === 'miss') {
    // Cold sooner than a proven warm gap, or very soon: not the TTL's doing.
    if (gapMs <= ev.maxHitMs || gapMs < MIN_MISS_EVIDENCE_MS) return ev
    return { ...ev, minMissMs: ev.minMissMs === null ? gapMs : Math.min(ev.minMissMs, gapMs) }
  }
  return ev
}

export function resolveTtl(override: string, ev: Evidence): Ttl {
  let overrideNote = ''
  if (override.trim().toLowerCase() !== 'auto' && override.trim() !== '') {
    const ms = parseDuration(override)
    if (ms !== null) return { ms, source: 'override', reason: `Set in the mod's settings (${override.trim()})` }
    overrideNote = ` The TTL setting "${override}" isn't a duration, so it was ignored.`
  }

  if (ev.reportedMs !== null && ev.reportedMs >= ev.maxHitMs) {
    return { ms: ev.reportedMs, source: 'reported', reason: `Reported by the app at the last model switch.${overrideNote}` }
  }

  const proved = ev.maxHitMs > 5 * MINUTE
  if (proved || ev.minMissMs !== null) {
    const lo = ev.maxHitMs
    const hi = ev.minMissMs
    const fits = CANDIDATES_MS.filter(c => c >= lo && (hi === null || c < hi))
    let ms: number
    if (hi === null) {
      // Only a lower bound: keep the default unless the cache outlived it.
      ms = Math.max(DEFAULT_TTL_MS, fits[0] ?? lo)
    } else {
      ms = fits[0] ?? Math.max(lo, hi - MINUTE)
    }
    const parts: string[] = []
    if (lo > 0) parts.push(`still warm after ${fmtSpan(lo)}`)
    if (hi !== null) parts.push(`cold after ${fmtSpan(hi)}`)
    return { ms, source: 'detected', reason: `Learned from this computer: cache was ${parts.join(' and ')}.${overrideNote}` }
  }

  return {
    ms: DEFAULT_TTL_MS,
    source: 'default',
    reason: `Default: no model switch has reported a TTL and no pause long enough to tell has been seen yet.${overrideNote}`,
  }
}

export type CacheView =
  | { status: 'none' }
  | { status: 'cold'; reason: string }
  | { status: 'warm'; remainingMs: number; reusePct: number | null }

export function cacheView(cache: CacheState | null, ttl: Ttl, now: number): CacheView {
  if (cache === null) return { status: 'none' }
  if (cache.coldReason !== null) return { status: 'cold', reason: cache.coldReason }
  const remainingMs = cache.refreshedAt + ttl.ms - now
  if (remainingMs <= 0) return { status: 'cold', reason: `No request for ${fmtSpan(ttl.ms)}` }
  return { status: 'warm', remainingMs, reusePct: cache.reusePct }
}

export type Level = 'ok' | 'warn' | 'danger'

export function levelFor(pct: number, warnAt: number, dangerAt: number): Level {
  if (pct >= dangerAt) return 'danger'
  if (pct >= warnAt) return 'warn'
  return 'ok'
}

export function parsePercents(text: unknown): number[] {
  if (typeof text !== 'string') return []
  return text
    .split(/[,\s]+/)
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0 && n <= 1000)
    .sort((a, b) => a - b)
}

/** The toast thresholds this reading has crossed that haven't fired for this window yet. */
export function dueToasts(limit: Limit, thresholds: number[], fired: readonly string[]): string[] {
  const window = limit.resetsAt ?? 'none'
  return thresholds
    .filter(t => limit.percentUsed >= t)
    .map(t => `${limit.kind}@${window}:${t}`)
    .filter(key => !fired.includes(key))
}

/** m:ss under 10 minutes, then 47m, then 1h 05m. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const m = Math.ceil(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** 45s, 12m, 2h 14m, 3d 4h. */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

export function fmtPct(p: number): string {
  return `${Math.round(p)}%`
}

export function evidenceKey(model: string, hasLimits: boolean): string {
  return `ttl:${model}|${hasLimits ? 'subscription' : 'api'}`
}
