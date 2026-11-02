import { expect, test } from 'claude-code/testing'

import {
  HOUR,
  MINUTE,
  NO_EVIDENCE,
  addEvidence,
  cacheView,
  classify,
  dueToasts,
  fmtCountdown,
  fmtSpan,
  labelFor,
  normalizeLimits,
  parseDuration,
  readEvidence,
  readUsage,
  resolveTtl,
} from '../hooks/logic'
import type { StepUsage } from '../hooks/logic'

const usage = (read: number, creation: number, input = 10): StepUsage => ({
  input_tokens: input,
  output_tokens: 50,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: creation,
  model: 'claude-opus-5-5',
})

test('durations: today\'s values and future ones', () => {
  expect(parseDuration('5m')).toBe(5 * MINUTE)
  expect(parseDuration('1h')).toBe(HOUR)
  expect(parseDuration('30m')).toBe(30 * MINUTE)
  expect(parseDuration('1h30m')).toBe(90 * MINUTE)
  expect(parseDuration('24h')).toBe(24 * HOUR)
  expect(parseDuration('2d')).toBe(48 * HOUR)
  expect(parseDuration('PT1H')).toBe(HOUR)
  expect(parseDuration('300')).toBe(5 * MINUTE)
  expect(parseDuration(3600)).toBe(HOUR)
  expect(parseDuration('soon')).toBe(null)
  expect(parseDuration('')).toBe(null)
  expect(parseDuration(undefined)).toBe(null)
})

test('limits: known, new and broken entries', () => {
  const r = normalizeLimits([
    { kind: 'seven_day', percentUsed: 68, resetsAt: '2026-11-05T10:00:00Z' },
    { kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-11-02T18:00:00Z' },
    { kind: 'thirty_day_tokens', percentUsed: 3 },
    { kind: 'broken' },
    { percentUsed: 9 },
  ])
  expect(r.items.map(l => l.kind)).toEqual(['five_hour', 'seven_day', 'thirty_day_tokens'])
  expect(r.error).toBe('2 of 5 limit entries had an unexpected shape')
  expect(labelFor('thirty_day_tokens')).toBe('Thirty day tokens')
  expect(labelFor('five_hour')).toBe('5h')
})

test('limits: a shape that is not a list is reported, not guessed', () => {
  expect(normalizeLimits(undefined)).toEqual({ items: [], error: 'rateLimits is undefined, not a list' })
  expect(normalizeLimits({ five_hour: 4 }).error).toBe('rateLimits is object, not a list')
  expect(normalizeLimits([]).error).toBe(null)
})

test('a bad reset time is dropped, the reading kept', () => {
  const r = normalizeLimits([{ kind: 'five_hour', percentUsed: 10, resetsAt: 'tomorrow-ish' }])
  expect(r.items).toEqual([{ kind: 'five_hour', percentUsed: 10 }])
  expect(r.error).toBe(null)
})

test('usage with missing counts is ignored', () => {
  expect(readUsage(null)).toBe(null)
  expect(readUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1 })).toBe(null)
  expect(readUsage({ ...usage(1, 1), model: undefined })?.model).toBe('unknown')
})

test('hit and miss are judged against the previous prompt', () => {
  expect(classify(usage(6000, 200), 10000)).toBe('unclear')
  expect(classify(usage(8500, 200), 10000)).toBe('hit')
  // A shared system prompt alone is no hit for this conversation.
  expect(classify(usage(3000, 7000), 10000)).toBe('miss')
  expect(classify(usage(3000, 7000), 0)).toBe('unclear')
})

test('TTL: default until evidence, then detected', () => {
  expect(resolveTtl('auto', NO_EVIDENCE)).toMatchObject({ ms: HOUR, source: 'default' })

  // Warm after 12 minutes: longer than 5m, so keep 1h and call it detected.
  let ev = addEvidence(NO_EVIDENCE, 12 * MINUTE, 'hit')
  expect(resolveTtl('auto', ev)).toMatchObject({ ms: HOUR, source: 'detected' })

  // Warm after 12m, cold after 40m: the TTL is 15m or 30m; the smaller fits.
  ev = addEvidence(ev, 40 * MINUTE, 'miss')
  expect(resolveTtl('auto', ev)).toMatchObject({ ms: 15 * MINUTE, source: 'detected' })
})

test('TTL: a 5-minute cache is detected from one cold pause', () => {
  const ev = addEvidence(NO_EVIDENCE, 20 * MINUTE, 'miss')
  expect(resolveTtl('auto', ev)).toMatchObject({ ms: 5 * MINUTE, source: 'detected' })
})

test('TTL: contradicting evidence is dropped', () => {
  let ev = addEvidence(NO_EVIDENCE, 20 * MINUTE, 'miss')
  // Later warm after 45m: the earlier miss was an early eviction.
  ev = addEvidence(ev, 45 * MINUTE, 'hit')
  expect(ev.minMissMs).toBe(null)
  expect(ev.maxHitMs).toBe(45 * MINUTE)
  // A miss shorter than a proven warm gap is not the TTL.
  const same = addEvidence(ev, 30 * MINUTE, 'miss')
  expect(same).toBe(ev)
  // So is a miss within two minutes.
  expect(addEvidence(NO_EVIDENCE, MINUTE, 'miss')).toBe(NO_EVIDENCE)
})

test('TTL: a changed provider TTL is followed', () => {
  // Learned 1h, then the cache starts going cold after 10 minutes.
  let ev = addEvidence(NO_EVIDENCE, 50 * MINUTE, 'hit')
  ev = addEvidence(ev, 10 * MINUTE, 'miss')
  // Ignored at first: 10m is shorter than a proven warm gap.
  expect(resolveTtl('auto', ev).ms).toBe(HOUR)
  // /usagebar reset clears it, and new evidence takes over.
  ev = addEvidence(NO_EVIDENCE, 10 * MINUTE, 'miss')
  expect(resolveTtl('auto', ev).ms).toBe(5 * MINUTE)
})

test('TTL: reported values win, any duration accepted', () => {
  const ev = { ...NO_EVIDENCE, reportedMs: 30 * MINUTE, reportedAt: 1 }
  expect(resolveTtl('auto', ev)).toMatchObject({ ms: 30 * MINUTE, source: 'reported' })
})

test('TTL: the setting overrides; a bad one is ignored and said', () => {
  expect(resolveTtl('5m', NO_EVIDENCE)).toMatchObject({ ms: 5 * MINUTE, source: 'override' })
  const bad = resolveTtl('forever', NO_EVIDENCE)
  expect(bad.source).toBe('default')
  expect(bad.reason).toContain('"forever"')
})

test('stored evidence of an unknown shape reads as none', () => {
  expect(readEvidence('junk')).toEqual(NO_EVIDENCE)
  expect(readEvidence({ maxHitMs: 'x', minMissMs: -4 })).toEqual(NO_EVIDENCE)
})

test('cache view: warm, expired, and emptied early', () => {
  const ttl = { ms: HOUR, source: 'default' as const, reason: '' }
  const cache = { refreshedAt: 0, model: 'm', reusePct: 40, promptTokens: 100, coldReason: null, lowWarned: false }
  expect(cacheView(null, ttl, 0)).toEqual({ status: 'none' })
  expect(cacheView(cache, ttl, 10 * MINUTE)).toEqual({ status: 'warm', remainingMs: 50 * MINUTE, reusePct: 40 })
  expect(cacheView(cache, ttl, HOUR).status).toBe('cold')
  expect(cacheView({ ...cache, coldReason: 'Model switched' }, ttl, 1)).toEqual({ status: 'cold', reason: 'Model switched' })
})

test('toasts fire once per threshold per reset window', () => {
  const l = { kind: 'five_hour', percentUsed: 96, resetsAt: 'A' }
  expect(dueToasts(l, [80, 95], [])).toEqual(['five_hour@A:80', 'five_hour@A:95'])
  expect(dueToasts(l, [80, 95], ['five_hour@A:80', 'five_hour@A:95'])).toEqual([])
  expect(dueToasts({ ...l, resetsAt: 'B' }, [80, 95], ['five_hour@A:80'])).toHaveLength(2)
})

test('formatting', () => {
  expect(fmtCountdown(272_000)).toBe('4:32')
  expect(fmtCountdown(47 * MINUTE)).toBe('47m')
  expect(fmtCountdown(65 * MINUTE)).toBe('1h 05m')
  expect(fmtSpan(134 * MINUTE)).toBe('2h 14m')
  expect(fmtSpan(76 * HOUR)).toBe('3d 4h')
})
