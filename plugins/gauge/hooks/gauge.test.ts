import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, cacheLeft, config, fit, resetText, turnsLeft } from './register'

const NOW = new Date(2026, 9, 14, 9, 0).getTime()
const MIN = 60_000

// Світ: що повертає рядок стану рушія
function world(on: On, opts: { surfaces?: string[]; env?: Record<string, string>; compactAnswer?: object } = {}) {
  const st = {
    percent: 40 as number | undefined,
    tokens: 80_000,
    limits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(2026, 9, 14, 16, 40).toISOString() },
      { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(2026, 9, 18, 9, 0).toISOString() },
    ] as any[],
    breakdown: undefined as any,
  }
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/u', ...(opts.env ?? {}) })
  on('session.start', async ($, e) => e as any)
  on('session.end', async ($, e: any) => ({ sessionId: e.sessionId }) as any)
  on('session.surfaces', async () => ({ value: opts.surfaces ?? ['desktop'] }) as any)
  on('session.usage', async ($, e: any) => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000, tokens: st.tokens, percent: st.percent, ...(e?.breakdown ? { breakdown: st.breakdown } : {}) },
      rateLimits: st.limits,
      cost: { usd: 0 },
    },
  }) as any)
  on('command.register', async () => ({ value: undefined as any }))
  on('session.compact', async ($, e: any) => (opts.compactAnswer ?? { messages: e.messages }) as any)
  on('ui.toast', async ($, e) => { toasts.push(e.text); return { value: undefined } as any })
  on('turn.complete', async () => ({ text: '' }) as any)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as any
  })
  return { st, toasts, clock }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } as any
const start = ($: any) => $.session.start({ cwd: '/p', surface: null, isInteractive: false } as any)
const USAGE = { inputTokens: 1000, outputTokens: 100 }
const done = ($: any, extra: object = {}) =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', text: '', usage: USAGE, ...extra } as any)
// Увесь рядок смуги — тексти по порядку
const line = async ($: any, surface: 'terminal' | 'desktop' = 'desktop', props = BAND) => {
  const ui = await $.ui.mount({ plugin: 'gauge', surface, component: 'AbovePrompt', props })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  return { ui, text: texts.join(' ') }
}

describe('шкала', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`один рядок: контекст, ліміти з часом скидання, кеш, ${surface}`, async ($, on) => {
      world(on)
      await start($)
      await done($)
      const { text } = await line($, surface)
      expect(text).toBe('▰▰▰▰▱▱▱▱▱▱ 40% · 5 год 42% (до 16:40) · тиждень 18% (до 18.10) · кеш 60 хв')
    })
  }

  test('колір рівня: зелений, жовтий, червоний', async ($, on) => {
    const { st } = world(on)
    await start($)
    for (const [p, color] of [[40, 'green'], [75, 'yellow'], [92, 'red']] as const) {
      st.percent = p
      await done($)
      const { ui } = await line($)
      expect((await ui.find({ type: 'Text', text: new RegExp(`${p}%$`) }))?.props?.color).toBe(color)
    }
  })

  test('прогноз «скільки ходів до межі» за середнім приростом', async ($, on) => {
    const { st } = world(on)
    await start($)
    for (const p of [50, 55, 60, 65]) {
      st.percent = p
      await done($)
    }
    expect((await line($)).text).toContain('≈5 ходів до 90%')
  })

  test('сповіщення про червону зону — один раз, знову лише після спаду', async ($, on) => {
    const { st, toasts } = world(on)
    await start($)
    for (const p of [91, 93, 95]) {
      st.percent = p
      await done($)
    }
    expect(toasts).toEqual(['Контекст заповнено на 91% — час завершувати або передавати роботу в чисте вікно.'])
    st.percent = 30
    await done($)
    st.percent = 92
    await done($)
    expect(toasts).toHaveLength(2)
  })

  test('таймер кешу йде сам і жовтіє наприкінці; вистиглий — так і каже', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await done($)
    await clock.advance(20 * MIN)
    expect((await line($)).text).toContain('кеш 40 хв')
    await clock.advance(32 * MIN)
    const { ui, text } = await line($)
    expect(text).toContain('кеш 8:00')
    expect((await ui.find({ type: 'Text', text: 'кеш 8:00' }))?.props?.color).toBe('yellow')
    await clock.advance(10 * MIN)
    expect((await line($)).text).toContain('кеш вистиг')
  })

  test('кеш на 5 хвилин із налаштувань', { options: { cacheTtl: '5m' } } as any, async ($: any, on: any) => {
    const { clock } = world(on)
    await start($)
    await done($)
    await clock.advance(MIN)
    expect((await line($)).text).toContain('кеш 4:00')
  })

  test('хід субагента не оновлює ні кеш, ні історію', async ($, on) => {
    const { st, clock } = world(on)
    await start($)
    await done($)
    await clock.advance(50 * MIN)
    st.percent = 99
    await done($, { agentId: 'sub1' })
    const { text } = await line($)
    expect(text).toContain('40%')
    expect(text).toContain('кеш 10 хв')
  })

  test('вузьке вікно — коротко', async ($, on) => {
    world(on)
    await start($)
    await done($)
    expect((await line($, 'desktop', { ...BAND, bodyColumns: 45 })).text).toBe('40% · 5 год 42% · тиждень 18% · кеш 60 хв')
  })

  test('до першої відповіді і без лімітів — смуги немає; опитування — теж', async ($, on) => {
    const { st } = world(on)
    st.percent = undefined
    st.limits = []
    await start($)
    expect((await line($)).text).toBe('')
    st.percent = 50
    await done($)
    expect((await line($, 'desktop', { ...BAND, hasSurvey: true })).text).toBe('')
  })

  test('/clear — історія й кеш нового вікна з нуля', async ($, on) => {
    const { st } = world(on)
    await start($)
    for (const p of [50, 60, 70]) {
      st.percent = p
      await done($)
    }
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    const { text } = await line($)
    expect(text).not.toContain('▰')
    expect(text).not.toContain('кеш')
    expect(text).toContain('5 год 42%')
  })

  test('/gauge — з чого складається контекст, ліміти, кеш, прогноз', async ($, on) => {
    const { st } = world(on)
    st.breakdown = {
      rawMaxTokens: 200_000,
      categories: [
        { name: 'Messages', tokens: 50_000, kind: 'used' },
        { name: 'System tools', tokens: 20_000, kind: 'used' },
        { name: 'Something new', tokens: 400, kind: 'used' },
        { name: 'Free space', tokens: 120_000, kind: 'free' },
        { name: 'Empty', tokens: 0, kind: 'used' },
      ],
    }
    await start($)
    await done($)
    const r: any = await $.command.run({ command: 'gauge', args: '' } as any)
    expect(r.text).toBe([
      'Контекст: 40% (80k з 200k)',
      'З чого складається (частка від усього вікна):',
      '- Повідомлення: 50k (25%)',
      '- Системні інструменти: 20k (10%)',
      '- Something new: <1k (0%)',
      'Ліміт «5 год»: 42% (скидається 16:40)',
      'Ліміт «тиждень»: 18% (скидається 18.10)',
      'Кеш підказок: ще 60 хв',
    ].join('\n'))
  })

  test('хід без відповіді (помилка API, переривання) не перезапускає кеш і не йде в прогноз', async ($, on) => {
    const { st, clock } = world(on)
    await start($)
    await done($)
    await clock.advance(50 * MIN)
    st.percent = 60
    await done($, { reason: 'error', usage: undefined })
    expect((await line($)).text).toContain('кеш 10 хв')
  })

  test('/resume — історія й кеш нового вікна з нуля', async ($, on) => {
    world(on)
    await start($)
    await done($)
    await $.session.end({ reason: 'resume', sessionId: 's1' } as any)
    expect((await line($)).text).not.toContain('кеш')
  })

  test('/compact — старий відсоток не показується до наступної відповіді', async ($, on) => {
    const { st } = world(on)
    st.percent = 88
    await start($)
    await done($)
    await $.session.compact({ messages: [{ role: 'user', text: 'підсумок', toolUses: [] }], trigger: 'manual' } as any).catch(() => {})
    expect((await line($)).text).not.toContain('88%')
  })

  for (const [name, args, answer] of [
    ['підготовка наперед', { trigger: 'precompute' }, undefined],
    ['стиснення субагента', { trigger: 'auto', agentId: 'sub1' }, undefined],
    ['пропущене стиснення', { trigger: 'auto' }, { skip: 'не треба' }],
  ] as const) {
    test(`${name} — шкала лишається`, async ($, on) => {
      const { st } = world(on, { compactAnswer: answer })
      st.percent = 85
      await start($)
      await done($)
      await $.session.compact({ messages: [{ role: 'user', text: 'підсумок', toolUses: [] }], ...args } as any).catch(() => {})
      expect((await line($)).text).toContain('85%')
    })
  }

  test('кеш вистиг, годинник став; нова відповідь — знову відлічує', async ($, on) => {
    const { st, clock } = world(on)
    st.limits = []
    await start($)
    await done($)
    await clock.advance(61 * MIN)
    expect((await line($)).text).toContain('кеш вистиг')
    await done($)
    await clock.advance(20 * MIN)
    expect((await line($)).text).toContain('кеш 40 хв')
  })

  test('ліміт тижня переходить з дати на час, коли до скидання менше доби', async ($, on) => {
    const { st, clock } = world(on)
    st.limits = [{ kind: 'seven_day', percentUsed: 18, resetsAt: new Date(NOW + 37 * 60 * MIN).toISOString() }]
    await start($)
    await done($)
    expect((await line($)).text).toContain('(до 15.10)')
    await clock.advance(14 * 60 * MIN)
    expect((await line($)).text).toContain('(до 22:00)')
  })

  test('ліміт, що вже скинувся, зникає зі смуги без нової відповіді', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await done($)
    await clock.set(new Date(2026, 9, 14, 17, 0).getTime())
    const { text } = await line($)
    expect(text).not.toContain('5 год')
    expect(text).toContain('тиждень 18%')
  })

  test('ліміти: колір, дробові відсотки з комою, невідомий вид', async ($, on) => {
    const { st } = world(on)
    st.limits = [
      { kind: 'five_hour', percentUsed: 95, resetsAt: new Date(2026, 9, 14, 12, 0).toISOString() },
      { kind: 'spend_limit', percentUsed: 104.5 },
      { kind: 'weird', percentUsed: 75 },
    ]
    await start($)
    await done($)
    const { ui, text } = await line($)
    expect(text).toContain('5 год 95% (до 12:00) · бюджет 104,5% · ліміт weird 75%')
    expect((await ui.find({ type: 'Text', text: /^5 год/ }))?.props?.color).toBe('red')
    expect((await ui.find({ type: 'Text', text: /^ліміт weird/ }))?.props?.color).toBe('yellow')
  })

  test('десктоп без поверхні — годинник іде; вкладений claude -p з десктопа — ні', async ($, on) => {
    const { clock } = world(on, { surfaces: [], env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
    await start($)
    await done($)
    await clock.advance(20 * MIN)
    expect((await line($)).text).toContain('кеш 40 хв')
  })

  test('вкладений claude -p з десктопа — годинник стоїть', async ($, on) => {
    const { clock } = world(on, { surfaces: [], env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_CHILD_SESSION: '1' } })
    await start($)
    await done($)
    await clock.advance(20 * MIN)
    expect((await line($)).text).toContain('кеш 60 хв')
  })

  test('/gauge — прогноз теж є', async ($, on) => {
    const { st } = world(on)
    await start($)
    for (const p of [50, 55, 60, 65]) {
      st.percent = p
      await done($)
    }
    const r: any = await $.command.run({ command: 'gauge', args: '' } as any)
    expect(r.text).toContain('Прогноз: приблизно 5 ходів до 90%.')
  })

  test('claude -p (жодної поверхні) — годинник не крутиться', async ($, on) => {
    const { clock } = world(on, { surfaces: [] })
    await start($)
    await done($)
    await clock.advance(20 * MIN)
    // Смугу в -p ніхто не малює; а якби й малював — час кешу стоїть на моменті відповіді
    expect((await line($)).text).toContain('кеш 60 хв')
  })
})

describe('розрахунки', () => {
  test('шкала з 10 поділок', () => {
    expect(bar(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(bar(55)).toBe('▰▰▰▰▰▰▱▱▱▱')
    expect(bar(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(bar(130)).toBe('▰▰▰▰▰▰▰▰▰▰')
  })

  test('прогноз: спад і нулі не рахуються, повільний приріст — без прогнозу', () => {
    expect(turnsLeft([50, 60, 20, 30], 30, 90)).toBe(6)
    expect(turnsLeft([50, 60, 60, 70], 70, 90)).toBe(2)
    expect(turnsLeft([50, 50.2, 50.4], 50.4, 90)).toBeNull()
    expect(turnsLeft([95], 95, 90)).toBeNull()
  })

  test('кеш: хвилини, хвилини:секунди, вистиг', () => {
    expect(cacheLeft(0, NOW, 60 * MIN)).toBeNull()
    expect(cacheLeft(NOW, NOW + 15 * MIN, 60 * MIN)).toEqual({ text: '45 хв', isLow: false })
    expect(cacheLeft(NOW, NOW + 55 * MIN + 5000, 60 * MIN)).toEqual({ text: '4:55', isLow: true })
    expect(cacheLeft(NOW, NOW + 61 * MIN, 60 * MIN)).toBeNull()
  })

  test('скидання ліміту: протягом доби — годиною (і після півночі), далі — датою', () => {
    expect(resetText(new Date(2026, 9, 14, 16, 5).getTime(), NOW)).toBe('до 16:05')
    expect(resetText(new Date(2026, 9, 15, 1, 30).getTime(), new Date(2026, 9, 14, 21, 0).getTime())).toBe('до 01:30')
    expect(resetText(new Date(2026, 9, 20, 9, 0).getTime(), NOW)).toBe('до 20.10')
    expect(resetText(0, NOW)).toBe('')
  })

  test('налаштування: межі й червоний вище за жовтий', () => {
    expect(config({})).toEqual({ warnAt: 70, alertAt: 90, ttlMs: 60 * MIN })
    expect(config({ warnAt: 80, alertAt: 60, cacheTtl: '5m' })).toEqual({ warnAt: 80, alertAt: 81, ttlMs: 5 * MIN })
    expect(config({ warnAt: 5, alertAt: 200 })).toEqual({ warnAt: 30, alertAt: 99, ttlMs: 60 * MIN })
  })

  test('рядок вміщується в ширину: спершу зникає час скидання тижня, потім прогноз і шкала', () => {
    const r = { percent: 65, tokens: 1, window: 1, answeredAt: NOW, limits: [
      { kind: 'five_hour', percent: 42, resetsAt: NOW + 3 * 60 * MIN },
      { kind: 'seven_day', percent: 18, resetsAt: NOW + 4 * 24 * 60 * MIN },
    ] }
    const c = config({})
    const h = [50, 55, 60, 65]
    const txt = (cols: number) => fit(r, h, NOW, c, cols).map(p => p.text).join(' · ')
    expect(txt(200)).toBe('▰▰▰▰▰▰▰▱▱▱ 65% · ≈5 ходів до 90% · 5 год 42% (до 12:00) · тиждень 18% (до 18.10) · кеш 60 хв')
    expect(txt(90)).toBe('▰▰▰▰▰▰▰▱▱▱ 65% · ≈5 ходів до 90% · 5 год 42% (до 12:00) · тиждень 18% · кеш 60 хв')
    expect(txt(60)).toBe('▰▰▰▰▰▰▰▱▱▱ 65% · 5 год 42% · тиждень 18% · кеш 60 хв')
    expect(txt(41)).toBe('65% · 5 год 42% · тиждень 18% · кеш 60 хв')
    // Зовсім вузько: відкидається хвіст, кеш лишається
    expect(txt(27)).toBe('65% · 5 год 42% · кеш 60 хв')
    expect(txt(10)).toBe('65%')
  })
})
