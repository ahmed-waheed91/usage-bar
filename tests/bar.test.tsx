import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-11-02T12:00:00Z')
const MIN = 60_000

let nextUsage: unknown = null

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const LIMITS = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(T0 + 134 * MIN).toISOString() },
  { kind: 'seven_day', percentUsed: 68, resetsAt: new Date(T0 + 3 * 24 * 60 * MIN).toISOString() },
]

// Stands for the engine beneath the mod.
function engine(on: On, now = T0) {
  const toasts: string[] = []
  const clock = mock.clock(on, { now })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'usagebar' } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: nextUsage } as never
  })
  return { clock, toasts }
}

async function measure($: Engine, rateLimits: unknown) {
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits,
    changed: ['rateLimits'],
  } as never)
}

// One main-thread model request whose response reports this usage.
async function step($: Engine, read: number, creation: number) {
  nextUsage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: creation,
    model: 'claude-opus-5-5',
  }
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
}

test('the bar shows both limits and a warm cache, on terminal and desktop', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await measure($, LIMITS)
  await step($, 0, 20_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^5h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /42%/ }))?.text).toBe('42%')
    expect(await ui.find({ type: 'Text', text: /resets 2h 14m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^warm$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cold in 1h 00m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1h · default/ })).toBeDefined()
    await ui.unmount()
  }

  // Under ten minutes left, the countdown shows seconds.
  await clock.advance(55 * MIN + 28_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /cold in 4:32/ })).toBeDefined()
  await ui.unmount()
})

test('the TTL tag explains itself when pressed', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'ttl-tag' })
  expect(await ui.find({ type: 'Text', text: /Default: no model switch/ })).toBeDefined()
  await ui.unmount()
})

test('a cache is cold once its TTL passes, and after a compaction', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await step($, 0, 20_000)
  await clock.advance(61 * MIN)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^cold$/ })).toBeDefined()
  await ui.unmount()

  await step($, 0, 20_000)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Conversation compacted/ })).toBeDefined()
  await ui.unmount()
})

test('a model switch reports the TTL and empties the cache', async ($, on) => {
  engine(on)
  await start($)
  await step($, 0, 20_000)
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-opus-5-5',
    requested_model: 'opus',
    source: 'command',
    context_tokens: 20_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0.1,
    pricing: 'catalog',
  } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Model switched/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1h · reported/ })).toBeDefined()
  await ui.unmount()
})

test('a pause that stays warm teaches the TTL', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await step($, 0, 20_000)
  await clock.advance(20 * MIN)
  await step($, 20_000, 300)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1h · detected/ })).toBeDefined()
  await ui.unmount()
})

test('a partial cache shows how much was reused', async ($, on) => {
  engine(on)
  await start($)
  await step($, 0, 20_000)
  await step($, 8_000, 12_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /40% reused/ })).toBeDefined()
  await ui.unmount()
})

test('new limit kinds are drawn; old readings say how old', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await measure($, [...LIMITS, { kind: 'thirty_day_tokens', percentUsed: 12 }])
  await clock.advance(20 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Thirty day tokens$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /as of (19|20)m ago/ })).toBeDefined()
  await ui.unmount()
})

test('a passed reset time is not shown as current usage', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await measure($, LIMITS)
  await clock.advance(135 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /reset · awaiting update/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeUndefined()
  await ui.unmount()
})

test('unexpected data says no data and toasts once', async ($, on) => {
  const { toasts } = engine(on)
  await start($)
  await measure($, { five_hour: 'lots' })
  await measure($, { five_hour: 'lots' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no data \(run \/usagebar\)/ })).toBeDefined()
  await ui.unmount()
  expect(toasts.filter(t => t.includes('unexpected usage data'))).toHaveLength(1)
})

test('usage toasts fire at 80 and 95 once per window', async ($, on) => {
  const { toasts } = engine(on)
  await start($)
  await measure($, [{ ...LIMITS[0], percentUsed: 81 }])
  await measure($, [{ ...LIMITS[0], percentUsed: 82 }])
  await measure($, [{ ...LIMITS[0], percentUsed: 96 }])
  expect(toasts).toEqual([
    expect.stringContaining('5h usage at 81%'),
    expect.stringContaining('5h usage at 96%'),
  ])
})

test('the cache toast fires once in its last minute', async ($, on) => {
  const { clock, toasts } = engine(on)
  await start($)
  await step($, 0, 20_000)
  await clock.advance(59 * MIN + 5_000)
  await clock.advance(10_000)
  expect(toasts.filter(t => t.startsWith('Cache goes cold'))).toHaveLength(1)
})

test('/usagebar reports what the mod reads', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS)
  await step($, 0, 20_000)
  const out = await $.command.run({ command: 'usagebar', args: '' } as never)
  expect(out.text).toContain('five_hour (5h): 42%')
  expect(out.text).toContain('1h (default)')
  const reset = await $.command.run({ command: 'usagebar', args: 'reset' } as never)
  expect(reset.text).toContain('forgot the learned cache TTL')
})

test('settings: a fixed TTL, and hiding the limits', { options: { ttlOverride: '5m', showLimits: false } }, async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS)
  await step($, 0, 20_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /5m · set/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h$/ })).toBeUndefined()
  await ui.unmount()
})
