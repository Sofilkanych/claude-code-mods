import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Reading } from '../types'

// Шкала: один рядок над полем вводу — заповнення контексту (з кольором і прогнозом), ліміти 5 год і тижня,
// скільки ще живе кеш підказок. Дані — ті самі, що в рядку стану рушія; мод нічого не надсилає.
const EMPTY: Reading = { percent: null, tokens: null, window: null, limits: [], answeredAt: 0 }
const reading = atom({ plugin: 'gauge', key: 'reading' } as const, EMPTY)
const history = atom({ plugin: 'gauge', key: 'history' } as const, [] as number[])
const isAlerted = atom({ plugin: 'gauge', key: 'isAlerted' } as const, false)
const now = atom({ plugin: 'gauge', key: 'now' } as const, 0)

const TICK_MS = 15_000
// Скільки останніх ходів пам'ятаємо для прогнозу (дають 6 приростів)
const HISTORY = 7
const BAR = 10
const DAY = 24 * 60 * 60_000

// Ліміт з 70% — жовтий, з 90% — червоний; нижче — приглушений, як прогноз
const LIMIT_WARN = 70
const LIMIT_ALERT = 90

// position: де рядок — під полем вводу (рядок підказок) чи над ним
type Config = { warnAt: number; alertAt: number; ttlMs: number; position: 'below' | 'above' }

export function config(options: any): Config {
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
  }
  const warnAt = num(options?.warnAt, 70, 30, 95)
  const alertAt = Math.max(warnAt + 1, num(options?.alertAt, 90, 50, 99))
  return { warnAt, alertAt, ttlMs: options?.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000, position: options?.position === 'above' ? 'above' : 'below' }
}

// ——— розрахунки ————————————————————————————————————————————————————————

// Скільки ходів до червоної зони за середнім додатним приростом останніх ходів; null — прогнозу немає
export function turnsLeft(hist: number[], percent: number, alertAt: number): number | null {
  if (percent >= alertAt || hist.length < 2) return null
  const steps: number[] = []
  for (let i = 1; i < hist.length; i++) {
    const d = hist[i]! - hist[i - 1]!
    // Спад — це /compact чи /clear, нуль — хід без нових даних: у середнє не беремо
    if (d > 0) steps.push(d)
  }
  if (!steps.length) return null
  const avg = steps.reduce((a, b) => a + b, 0) / steps.length
  if (avg < 0.5) return null
  return Math.max(1, Math.ceil((alertAt - percent) / avg))
}

export function bar(percent: number): string {
  const full = Math.max(0, Math.min(BAR, Math.round(percent / (100 / BAR))))
  return '▰'.repeat(full) + '▱'.repeat(BAR - full)
}

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10, b = n % 100
  if (a === 1 && b !== 11) return one
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few
  return many
}

const pct = (n: number) => `${String(n).replace('.', ',')}%`
const kTokens = (n: number) => (n < 1000 ? '<1k' : `${Math.round(n / 1000)}k`)

const LIMIT_NAMES: Record<string, string> = { five_hour: '5 год', seven_day: 'тиждень', spend_limit: 'бюджет' }
const limitName = (kind: string) => LIMIT_NAMES[kind] ?? `ліміт ${kind.slice(0, 20)}`

// Назви категорій /context рушій дає англійською — перекладаємо знайомі
const CATEGORY_NAMES: Record<string, string> = {
  'system prompt': 'Системна підказка',
  'system tools': 'Системні інструменти',
  'mcp tools': 'Інструменти MCP',
  'custom agents': 'Агенти',
  'memory files': 'Файли пам\'яті',
  skills: 'Навички',
  messages: 'Повідомлення',
  'free space': 'Вільно',
  'autocompact buffer': 'Запас на стиснення',
}
const categoryName = (name: string) => CATEGORY_NAMES[name.trim().toLowerCase()] ?? name.slice(0, 60)

// Коли скидається ліміт: протягом доби — годиною, далі — датою
export function resetText(resetsAt: number, nowMs: number): string {
  if (!resetsAt) return ''
  const d = new Date(resetsAt)
  const p = (n: number) => String(n).padStart(2, '0')
  return resetsAt - nowMs < DAY ? `до ${p(d.getHours())}:${p(d.getMinutes())}` : `до ${p(d.getDate())}.${p(d.getMonth() + 1)}`
}

// Ліміт, час скидання якого вже минув, — застарілий: його не показуємо, доки не прийде свіжий
const isCurrent = (l: Limit, nowMs: number) => !l.resetsAt || l.resetsAt > nowMs

// Скільки ще живе кеш: «41 хв», «2:05»; null — вистиг або відповіді ще не було
export function cacheLeft(answeredAt: number, nowMs: number, ttlMs: number): { text: string; isLow: boolean } | null {
  if (!answeredAt) return null
  const left = answeredAt + ttlMs - nowMs
  if (left <= 0) return null
  const isLow = left < ttlMs * 0.2
  if (left >= 10 * 60_000) return { text: `${Math.floor(left / 60_000)} хв`, isLow }
  const s = Math.floor(left / 1000)
  return { text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, isLow }
}

function levelColor(percent: number, warnAt: number, alertAt: number): string | undefined {
  return percent >= alertAt ? 'red' : percent >= warnAt ? 'yellow' : undefined
}

// Частини рядка від найважливішої. detail: 3 — усе, 2 — без часу скидання тижня, 1 — без прогнозу й часів, 0 — без шкали
type Part = { key: string; text: string; color?: string; dim?: boolean }
export function parts(r: Reading, hist: number[], nowMs: number, c: Config, detail: number): Part[] {
  const out: Part[] = []
  if (r.percent !== null) {
    const color = levelColor(r.percent, c.warnAt, c.alertAt) ?? 'green'
    out.push({ key: 'ctx', text: detail >= 1 ? `${bar(r.percent)} ${pct(r.percent)}` : pct(r.percent), color })
    const left = turnsLeft(hist, r.percent, c.alertAt)
    if (left && detail >= 2) out.push({ key: 'fc', text: `≈${left} ${plural(left, 'хід', 'ходи', 'ходів')} до ${c.alertAt}%`, dim: true })
  }
  for (const l of r.limits.filter(x => isCurrent(x, nowMs))) {
    const showReset = detail >= 3 || (detail >= 2 && l.kind === 'five_hour')
    const reset = showReset ? resetText(l.resetsAt, nowMs) : ''
    out.push({ key: `l-${l.kind}`, text: `${limitName(l.kind)} ${pct(l.percent)}${reset ? ` (${reset})` : ''}`, ...(l.percent >= LIMIT_WARN ? { color: levelColor(l.percent, LIMIT_WARN, LIMIT_ALERT) } : { dim: true }) })
  }
  const cache = cacheLeft(r.answeredAt, nowMs, c.ttlMs)
  if (cache) out.push({ key: 'cache', text: `кеш ${cache.text}`, color: cache.isLow ? 'yellow' : undefined, dim: !cache.isLow })
  else if (r.answeredAt) out.push({ key: 'cache', text: 'кеш вистиг', dim: true })
  return out
}

const width = (ps: Part[]) => ps.reduce((n, p) => n + [...p.text].length, 0) + Math.max(0, ps.length - 1) * 3

// Найдокладніший варіант, що вміщується в один рядок
export function fit(r: Reading, hist: number[], nowMs: number, c: Config, columns: number): Part[] {
  for (let detail = 3; detail > 0; detail--) {
    const ps = parts(r, hist, nowMs, c, detail)
    if (width(ps) <= columns) return ps
  }
  // Зовсім вузько — відкидаємо хвіст (кеш лишаємо до останнього: він змінюється найчастіше)
  const ps = parts(r, hist, nowMs, c, 0)
  while (ps.length > 1 && width(ps) > columns) {
    const i = ps.length >= 3 && ps[ps.length - 1]!.key === 'cache' ? ps.length - 2 : ps.length - 1
    ps.splice(i, 1)
  }
  return ps
}

// ——— читання ————————————————————————————————————————————————————————————

function toLimits(raw: any[]): Limit[] {
  return (raw ?? [])
    .filter(l => l && typeof l.percentUsed === 'number')
    .map(l => ({ kind: String(l.kind), percent: l.percentUsed, resetsAt: l.resetsAt ? Date.parse(l.resetsAt) || 0 : 0 }))
}

// Зняти показники; answered — Claude справді відповів (є usage): кеш щойно оновився, хід іде в історію
async function take($: any, c: Config, answered: boolean): Promise<void> {
  const u = await $.session.usage()
  const t: number = await $.clock.now()
  const percent = typeof u?.context?.percent === 'number' ? u.context.percent : null
  const prev = await read($, reading)
  const next: Reading = {
    percent,
    tokens: typeof u?.context?.tokens === 'number' ? u.context.tokens : null,
    window: typeof u?.context?.window === 'number' ? u.context.window : null,
    limits: toLimits(u?.rateLimits),
    answeredAt: answered ? t : prev.answeredAt,
  }
  await update($, reading, () => next)
  await update($, now, () => t)
  if (!answered || percent === null) return
  await update($, history, h => [...h, percent].slice(-HISTORY))
  // Червона зона — одне сповіщення; знову — лише після спаду нижче жовтої
  if (percent < c.warnAt) await update($, isAlerted, () => false)
  else if (percent >= c.alertAt && !(await read($, isAlerted))) {
    await update($, isAlerted, () => true)
    $.ui.toast(`Контекст заповнено на ${percent}% — час завершувати або передавати роботу в чисте вікно.`, { timeoutMs: 10000 })
  }
}

// Чи хтось бачить сесію: термінал або застосунок. Десктоп запускає сесію як SDK-хост — його впізнаємо за ознакою
// запуску (а вкладений claude -p, що її успадкував, має ще й позначку дочірньої сесії)
async function isLive($: any): Promise<boolean> {
  if ((await $.session.surfaces()).length > 0) return true
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' && !(await $.env.get('CLAUDE_CODE_CHILD_SESSION'))
}

let ticker: { cancel: () => void } | undefined
let isArming = false
// Що таймер кешу показав востаннє: перемальовуємо смугу лише коли текст змінився
let lastCacheText = ''

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

// Один такт: кеш вистиг — зупиняємось до наступної відповіді; текст змінився — оновлюємо смугу
async function tick($: any, c: Config): Promise<void> {
  const t: number = await $.clock.now()
  const r = await read($, reading)
  const cache = cacheLeft(r.answeredAt, t, c.ttlMs)
  // Що видно на смузі: якщо будь-яка частина (кеш, колір, час скидання) змінилась — перемальовуємо
  const text = parts(r, await read($, history), t, c, 3).map(p => `${p.text}~${p.color ?? ''}`).join('|')
  if (text !== lastCacheText) {
    lastCacheText = text
    await update($, now, () => t)
  }
  if (!cache && !r.limits.some(l => l.resetsAt > t)) stopTicker()
}

// Годинник для таймера кешу й лімітів: лише коли є кому дивитись і є що відлічувати
async function ensureTicker($: any, c: Config): Promise<void> {
  if (ticker || isArming) return
  isArming = true
  try {
    if (!(await isLive($))) return
    const r = await read($, reading)
    if (!r.answeredAt && !r.limits.length) return
    ticker = $.clock.every(TICK_MS, () => void tick($, c).catch(() => {}))
  } finally {
    isArming = false
  }
}

// /gauge — з чого складається контекст, ліміти, кеш
async function details($: any, c: Config): Promise<string> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const t: number = await $.clock.now()
  const r = await read($, reading)
  const lines: string[] = []
  const ctx = u?.context
  const win = ctx?.window || 0
  if (typeof ctx?.percent === 'number') lines.push(`Контекст: ${pct(ctx.percent)} (${kTokens(ctx.tokens ?? 0)} з ${kTokens(win)})`)
  else lines.push('Контекст: ще не було жодної відповіді.')
  const cats = (ctx?.breakdown?.categories ?? []).filter((x: any) => x.kind === 'used' && x.tokens > 0).sort((a: any, b: any) => b.tokens - a.tokens)
  if (cats.length) {
    lines.push('З чого складається (частка від усього вікна):')
    for (const x of cats) lines.push(`- ${categoryName(String(x.name))}: ${kTokens(x.tokens)}${win ? ` (${Math.round((x.tokens / win) * 100)}%)` : ''}`)
  }
  for (const l of toLimits(u?.rateLimits)) {
    if (!isCurrent(l, t)) continue
    lines.push(`Ліміт «${limitName(l.kind)}»: ${pct(l.percent)}${l.resetsAt ? ` (скидається ${resetText(l.resetsAt, t).replace(/^до /, '')})` : ''}`)
  }
  const cache = cacheLeft(r.answeredAt, t, c.ttlMs)
  lines.push(cache ? `Кеш підказок: ще ${cache.text}` : r.answeredAt ? 'Кеш підказок: вистиг — наступний запит буде дорожчим.' : 'Кеш підказок: ще не було відповіді.')
  const left = r.percent !== null ? turnsLeft(await read($, history), r.percent, c.alertAt) : null
  if (left) lines.push(`Прогноз: приблизно ${left} ${plural(left, 'хід', 'ходи', 'ходів')} до ${c.alertAt}%.`)
  return lines.join('\n')
}

// Ширина рядка: рядок під полем вводу її не знає — беремо з останнього малювання смуги над полем
let columns = 120

// Сам рядок шкали; null — показати нічого
async function drawRow($: any, e: any, c: Config, cols: number): Promise<any> {
  const r = await read($, reading)
  const t = Math.max(await read($, now), r.answeredAt)
  const ps = fit(r, await read($, history), t, c, Math.max(20, cols - 2))
  if (!ps.length) return null
  const { Box, Text } = $.ui.resolve(e)
  const row: any[] = []
  ps.forEach((p, i) => {
    if (i) row.push(<Text key={`s${i}`} dimColor>·</Text>)
    row.push(<Text key={p.key} color={p.color} dimColor={p.dim}>{p.text}</Text>)
  })
  return <Box key="gauge" gap={1}>{row}</Box>
}

// Нове вікно (/clear, /resume) — стара історія, кеш і сповіщення до нього не стосуються
async function resetWindow($: any): Promise<void> {
  await update($, reading, r => ({ ...r, percent: null, tokens: null, answeredAt: 0 }))
  await update($, history, () => [])
  await update($, isAlerted, () => false)
  lastCacheText = ''
}

export const register: Register = (on, options) => {
  const c = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gauge', description: 'Шкала: з чого складається контекст, ліміти, кеш підказок', immediate: true })
    void take($, c, false).then(() => ensureTicker($, c)).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const reason = (e as any).reason
    if (reason === 'clear' || reason === 'resume') {
      try {
        await resetWindow($)
      } catch {}
    }
    return next(e)
  })

  // Після стиснення старий відсоток неправдивий — до наступної відповіді шкалу не показуємо
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // Підготовка наперед, стиснення субагента чи пропущене стиснення основну розмову не змінили
    if ((e as any).trigger === 'precompute' || (e as any).agentId || (r as any)?.skip !== undefined) return r
    try {
      await update($, reading, x => ({ ...x, percent: null, tokens: null }))
    } catch {}
    return r
  })

  // Новий хід — годинник міг зупинитись (кеш вистиг) або зникнути з перезавантаженням мода
  on('turn.start', async ($, e, next) => {
    void ensureTicker($, c).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // Хід субагента не оновлює ні контекст основної розмови, ні її кеш
    if ((e as any).agentId) return r
    try {
      // Без usage — перерваний хід чи помилка API: запиту до моделі не було, кеш не оновлювався
      await take($, c, Boolean((e as any).usage))
      await ensureTicker($, c)
    } catch {}
    return r
  })

  on('command.run', { command: 'gauge' }, async $ => {
    void ensureTicker($, c).catch(() => {})
    try {
      return { text: await details($, c) }
    } catch (err: any) {
      return { text: `Не вдалося прочитати показники: ${String(err?.message ?? err).slice(0, 80)}` }
    }
  })

  // Над полем вводу — лише коли так налаштовано; заодно запам'ятовуємо ширину для рядка під полем
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (typeof e.props.bodyColumns === 'number') columns = e.props.bodyColumns
    if (c.position !== 'above' || e.props.hasSurvey) return below
    const row = await drawRow($, e, c, columns)
    if (!row) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })

  // Під полем вводу: рядок підказок рушія лишається, шкала — під ним
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (c.position !== 'below') return engine
    const row = await drawRow($, e, c, columns)
    if (!row) return engine
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {engine}
        {row}
      </Box>
    )
  })
}
