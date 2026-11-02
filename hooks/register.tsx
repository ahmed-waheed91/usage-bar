import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CacheState, Limit, LimitsState, Ttl } from '../types'
import {
  MINUTE,
  NO_EVIDENCE,
  addEvidence,
  cacheView,
  classify,
  dueToasts,
  evidenceKey,
  fmtCountdown,
  fmtPct,
  fmtSpan,
  labelFor,
  levelFor,
  normalizeLimits,
  parseDuration,
  parsePercents,
  promptTokens,
  readEvidence,
  readUsage,
  resolveTtl,
  reusePct,
} from './logic'
import type { Level } from './logic'

// Change a shape tag when that value's fields change: an older value is then
// read as the initial instead of being misread.
const limitsA = atom({ plugin: 'usage-bar', key: 'limits' } as const, null, { shape: 'limits-1' })
const cacheA = atom({ plugin: 'usage-bar', key: 'cache' } as const, null, { shape: 'cache-1' })
const ttlA = atom({ plugin: 'usage-bar', key: 'ttl' } as const, null, { shape: 'ttl-1' })
const nowA = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)
const firedA = atom({ plugin: 'usage-bar', key: 'fired' } as const, [])
const showWhyA = atom({ plugin: 'usage-bar', key: 'showWhy' } as const, false)

const COMMAND = 'usagebar'
const BAR_CELLS = 8
const SOURCE_LABEL: Record<Ttl['source'], string> = {
  override: 'set',
  reported: 'reported',
  detected: 'detected',
  default: 'default',
}
const THEME: Record<Level, 'success' | 'warning' | 'error'> = { ok: 'success', warn: 'warning', danger: 'error' }
const HEX: Record<Level, string> = { ok: '#1D9E75', warn: '#BA7517', danger: '#E24B4A' }

type Opts = {
  ttlOverride: string
  warnPercent: number
  dangerPercent: number
  toastPercents: number[]
  cacheToast: boolean
  staleMs: number
  showLimits: boolean
  showCache: boolean
}

function readOpts(o: PluginOptions): Opts {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    ttlOverride: typeof o.ttlOverride === 'string' ? o.ttlOverride : 'auto',
    warnPercent: num(o.warnPercent, 70),
    dangerPercent: num(o.dangerPercent, 90),
    toastPercents: parsePercents(typeof o.toastPercents === 'string' ? o.toastPercents : '80,95'),
    cacheToast: bool(o.cacheToast, true),
    staleMs: num(o.staleMinutes, 15) * MINUTE,
    showLimits: bool(o.showLimits, true),
    showCache: bool(o.showCache, true),
  }
}

// When the `now` atom was last written; a reload restarting it at 0 only
// means one early redraw.
let lastNowWrite = 0

async function currentModel($: EngineInterface): Promise<string> {
  const cache = await read($, cacheA)
  if (cache !== null) return cache.model
  const stored = await $.store.get('lastModel')
  return typeof stored === 'string' ? stored : 'unknown'
}

async function hasLimits($: EngineInterface): Promise<boolean> {
  const limits = await read($, limitsA)
  return limits !== null && limits.items.length > 0
}

async function refreshTtl($: EngineInterface, opts: Opts): Promise<Ttl> {
  const key = evidenceKey(await currentModel($), await hasLimits($))
  const ttl = resolveTtl(opts.ttlOverride, readEvidence(await $.store.get(key)))
  await update($, ttlA, () => ttl)
  return ttl
}

async function markCold($: EngineInterface, reason: string) {
  await update($, cacheA, c => (c === null ? c : { ...c, coldReason: reason }))
}

/** Toasts once per key: a threshold in one reset window, or one error. */
async function fire($: EngineInterface, keys: string[], text: string) {
  const fired = await read($, firedA)
  const fresh = keys.filter(k => !fired.includes(k))
  if (fresh.length === 0) return
  await update($, firedA, f => [...f, ...fresh].slice(-200))
  $.ui.toast(text, { timeoutMs: 8000 })
}

async function tick($: EngineInterface, opts: Opts) {
  const now = await $.clock.now()
  const [cache, ttl] = await Promise.all([read($, cacheA), read($, ttlA)])
  const view = ttl === null ? null : cacheView(cache, ttl, now)
  // Every second while the countdown shows seconds; otherwise every 15s
  // keeps "as of" ages, reset times and expiry current.
  const isFast = view !== null && view.status === 'warm' && view.remainingMs < 10 * MINUTE + 1000
  if (isFast || now - lastNowWrite >= 15_000) {
    lastNowWrite = now
    await update($, nowA, () => now)
  }
  if (
    opts.cacheToast &&
    cache !== null &&
    ttl !== null &&
    view?.status === 'warm' &&
    view.remainingMs <= MINUTE &&
    ttl.ms >= 2 * MINUTE &&
    !cache.lowWarned
  ) {
    await update($, cacheA, c => (c === null ? c : { ...c, lowWarned: true }))
    $.ui.toast(`Cache goes cold in under a minute (${fmtCountdown(view.remainingMs)})`, { timeoutMs: 8000 })
  }
}

async function takeLimits($: EngineInterface, opts: Opts, raw: unknown) {
  const now = await $.clock.now()
  const { items, error } = normalizeLimits(raw)
  const next: LimitsState = { items, measuredAt: now, error }
  await update($, limitsA, () => next)
  if (error !== null) {
    await fire($, [`error:${error}`], `Usage bar: unexpected usage data from the app. Run /${COMMAND} for details.`)
  }
  for (const l of items) {
    const due = dueToasts(l, opts.toastPercents, [])
    if (due.length === 0) continue
    const reset = l.resetsAt === undefined ? '' : ` · resets in ${fmtSpan(Date.parse(l.resetsAt) - now)}`
    await fire($, due, `${labelFor(l.kind)} usage at ${fmtPct(l.percentUsed)}${reset}`)
  }
}

async function forgetTtl($: EngineInterface, opts: Opts): Promise<string> {
  for (const k of await $.store.keys()) {
    if (k.startsWith('ttl:')) await $.store.set(k, NO_EVIDENCE)
  }
  await refreshTtl($, opts)
  return 'Usage bar: forgot the learned cache TTL on this computer.'
}

async function onStep($: EngineInterface, opts: Opts, sentAt: number, rawUsage: unknown) {
  const usage = readUsage(rawUsage)
  if (usage === null) return
  const prev = await read($, cacheA)
  const key = evidenceKey(usage.model, await hasLimits($))
  if (prev !== null && prev.coldReason === null && prev.model === usage.model) {
    const outcome = classify(usage, prev.promptTokens)
    const before = readEvidence(await $.store.get(key))
    const after = addEvidence(before, sentAt - prev.refreshedAt, outcome)
    if (after !== before) await $.store.set(key, after)
  }
  const cache: CacheState = {
    refreshedAt: sentAt,
    model: usage.model,
    reusePct: reusePct(usage),
    promptTokens: promptTokens(usage),
    coldReason: null,
    lowWarned: false,
  }
  await update($, cacheA, () => cache)
  await $.store.set('lastModel', usage.model)
  await refreshTtl($, opts)
}

async function onModelSwitch($: EngineInterface, opts: Opts, toModel: string, cacheTtl: unknown) {
  const ms = parseDuration(cacheTtl)
  const key = evidenceKey(toModel, await hasLimits($))
  if (ms !== null) {
    const ev = readEvidence(await $.store.get(key))
    await $.store.set(key, { ...ev, reportedMs: ms, reportedAt: await $.clock.now() })
  }
  await $.store.set('lastModel', toModel)
  await update($, cacheA, c => (c === null ? c : { ...c, model: toModel, coldReason: 'Model switched' }))
  await refreshTtl($, opts)
}

async function diagnose($: EngineInterface, opts: Opts): Promise<string> {
  const now = await $.clock.now()
  const [limits, cache, ttl] = await Promise.all([read($, limitsA), read($, cacheA), read($, ttlA)])
  const model = await currentModel($)
  const key = evidenceKey(model, await hasLimits($))
  const ev = readEvidence(await $.store.get(key))
  const lines: string[] = ['Usage bar diagnostics', '']

  lines.push('Usage limits')
  if (limits === null) lines.push('  No reading yet (the app reports usage after the first response).')
  else {
    lines.push(`  Read ${fmtSpan(now - limits.measuredAt)} ago.`)
    if (limits.error !== null) lines.push(`  Problem: ${limits.error}`)
    if (limits.items.length === 0) lines.push('  The app reported no limits (normal when not signed in with a subscription).')
    for (const l of limits.items) {
      const reset = l.resetsAt === undefined ? 'no reset time' : `resets ${l.resetsAt} (in ${fmtSpan(Date.parse(l.resetsAt) - now)})`
      lines.push(`  ${l.kind} (${labelFor(l.kind)}): ${l.percentUsed}% · ${reset}`)
    }
  }

  lines.push('', 'Cache')
  if (cache === null) lines.push('  No request yet in this conversation.')
  else {
    lines.push(`  Model: ${cache.model}`)
    lines.push(`  Last refreshed ${fmtSpan(now - cache.refreshedAt)} ago; last request reused ${cache.reusePct ?? '?'}% of ${cache.promptTokens} prompt tokens.`)
    if (cache.coldReason !== null) lines.push(`  Marked cold: ${cache.coldReason}`)
    if (ttl !== null) {
      const v = cacheView(cache, ttl, now)
      lines.push(`  Now: ${v.status}${v.status === 'warm' ? `, ${fmtCountdown(v.remainingMs)} left` : ''}`)
    }
  }

  lines.push('', 'TTL')
  if (ttl !== null) lines.push(`  ${fmtSpan(ttl.ms)} (${ttl.source}): ${ttl.reason}`)
  lines.push(`  Setting: ${opts.ttlOverride}`)
  lines.push(`  Evidence for ${key.slice(4)}: warm after up to ${fmtSpan(ev.maxHitMs)}; ${ev.minMissMs === null ? 'no cold miss seen' : `cold after ${fmtSpan(ev.minMissMs)}`}; ${ev.reportedMs === null ? 'never reported' : `reported ${fmtSpan(ev.reportedMs)}`}.`)

  const version = await $.session.version().catch(() => null)
  lines.push('', `App: Claude Code ${version?.version ?? 'unknown'} · mod usage-bar 0.1.0`)

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const opts = readOpts(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Usage bar: show what it reads from the app (add "reset" to forget the learned cache TTL)',
    })
    try {
      const usage = await $.session.usage()
      if (usage.rateLimits.length > 0) await takeLimits($, opts, usage.rateLimits)
    } catch {
      // No reading yet; session.measure fills it after the first response.
    }
    await refreshTtl($, opts)
    $.clock.every(1000, () => void tick($, opts).catch(() => undefined))

    return next(e)
  })

  // After each main-thread turn, and when a limit moves a whole point.
  on('session.measure', async ($, e, next) => {
    await takeLimits($, opts, (e as { rateLimits?: unknown }).rateLimits)
    await refreshTtl($, opts)

    return next(e)
  })

  // Every model request of the main conversation refreshes its cache, tool
  // loops included; a subagent's requests use a cache of their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const response = yield* next(e)
    // The bar is best effort; never disturb the turn.
    await onStep($, opts, sentAt, response.usage).catch(() => undefined)

    return response
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await onModelSwitch($, opts, e.to_model, e.cache_ttl).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !('skip' in result && result.skip !== undefined)) {
      await markCold($, 'Conversation compacted').catch(() => undefined)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await markCold($, 'Conversation cleared').catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') return { text: await forgetTtl($, opts) }

    return { text: await diagnose($, opts) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (!opts.showLimits && !opts.showCache)) return next(e)

    const [limits, cache, ttlRead, nowRead, showWhy] = await Promise.all([
      read($, limitsA),
      read($, cacheA),
      read($, ttlA),
      read($, nowA),
      read($, showWhyA),
    ])
    const now = nowRead > 0 ? nowRead : await $.clock.now()
    const ttl: Ttl = ttlRead ?? resolveTtl(opts.ttlOverride, NO_EVIDENCE)
    const isCompact = e.props.bodyColumns < 90

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined

    const bar = (pct: number, level: Level, key: string) => {
      const share = Math.max(0, Math.min(1, pct / 100))
      if (Svg !== undefined) {
        const w = 64
        const fill = Math.round(share * w)
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6">` +
          `<rect width="${w}" height="6" rx="3" fill="#88888840"/>` +
          (fill > 0 ? `<rect width="${fill}" height="6" rx="3" fill="${HEX[level]}"/>` : '') +
          '</svg>'
        return <Svg key={key} source={source} alt={`${Math.round(pct)}% used`} width={w} height={6} />
      }
      const cells = Math.round(share * BAR_CELLS)
      return (
        <Box key={key} flexDirection="row">
          <Text color={THEME[level]}>{'━'.repeat(cells)}</Text>
          <Text dimColor>{'─'.repeat(BAR_CELLS - cells)}</Text>
        </Box>
      )
    }

    const segments = []

    if (opts.showLimits) {
      if (limits === null) {
        segments.push(<Text key="nolimits" dimColor>Usage · waiting for first response</Text>)
      } else if (limits.items.length === 0) {
        segments.push(
          <Text key="nolimits" dimColor>
            Usage · {limits.error === null ? 'no data' : `no data (run /${COMMAND})`}
          </Text>,
        )
      } else {
        const age = now - limits.measuredAt
        const isStale = age > opts.staleMs
        limits.items.forEach((l: Limit) => {
          const resetAt = l.resetsAt === undefined ? null : Date.parse(l.resetsAt)
          const hasReset = resetAt !== null && resetAt <= now
          const pct = hasReset ? 0 : l.percentUsed
          const level = levelFor(pct, opts.warnPercent, opts.dangerPercent)
          segments.push(
            <Box key={`limit-${l.kind}`} flexDirection="row" gap="sm" alignItems="center">
              <Text dimColor={isStale}>{labelFor(l.kind)}</Text>
              {isCompact ? null : bar(pct, level, `bar-${l.kind}`)}
              {hasReset ? (
                <Text dimColor>reset · awaiting update</Text>
              ) : (
                <Text bold tabular color={isStale ? 'subtle' : THEME[level]}>
                  {fmtPct(l.percentUsed)}
                </Text>
              )}
              {isCompact || hasReset || resetAt === null ? null : (
                <Text dimColor>resets {fmtSpan(resetAt - now)}</Text>
              )}
            </Box>,
          )
        })
        if (age >= 2 * MINUTE) {
          segments.push(
            <Text key="age" dimColor>
              as of {fmtSpan(age)} ago
            </Text>,
          )
        }
        if (limits.error !== null) {
          segments.push(
            <Text key="err" color="warning">
              ! /{COMMAND}
            </Text>,
          )
        }
      }
    }

    let cacheSegment = null
    if (opts.showCache) {
      const view = cacheView(cache, ttl, now)
      const tag = `${fmtSpan(ttl.ms)} · ${SOURCE_LABEL[ttl.source]}`
      const tagButton = (
        <Button key="ttl-tag" plain onPress={() => update($, showWhyA, v => !v)}>
          <Text dimColor>[{tag}]</Text>
        </Button>
      )
      if (view.status === 'none') {
        cacheSegment = (
          <Box key="cache" flexDirection="row" gap="sm" alignItems="center">
            <Text dimColor>○ Cache · no requests yet</Text>
            {tagButton}
          </Box>
        )
      } else if (view.status === 'cold') {
        cacheSegment = (
          <Box key="cache" flexDirection="row" gap="sm" alignItems="center">
            <Text color="suggestion">○</Text>
            <Text>Cache</Text>
            <Text bold color="suggestion">cold</Text>
            {isCompact ? null : <Text dimColor>· {view.reason}; next message re-caches</Text>}
            {tagButton}
          </Box>
        )
      } else {
        const isSoon = view.remainingMs <= MINUTE
        const isPartial = view.reusePct !== null && view.reusePct < 80
        cacheSegment = (
          <Box key="cache" flexDirection="row" gap="sm" alignItems="center">
            <Text color={isSoon ? 'warning' : 'claude'}>●</Text>
            <Text>Cache</Text>
            <Text bold color={isSoon ? 'warning' : undefined}>warm</Text>
            <Text tabular dimColor>· cold in {fmtCountdown(view.remainingMs)}</Text>
            {isPartial && !isCompact ? <Text dimColor>· {view.reusePct}% reused</Text> : null}
            {tagButton}
          </Box>
        )
      }
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap="lg" alignItems="center" flexWrap="wrap">
          {segments}
          <Box flexGrow={1} />
          {cacheSegment}
        </Box>
        {showWhy && opts.showCache ? (
          <Text dimColor wrap="wrap">
            Cache TTL {fmtSpan(ttl.ms)} ({SOURCE_LABEL[ttl.source]}): {ttl.reason}
          </Text>
        ) : null}
      </Box>
    )
  })
}
