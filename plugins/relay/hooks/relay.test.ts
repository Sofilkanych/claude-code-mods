import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/u'
const ROOT = `${HOME}/Desktop/Проєкти/Склад (A)`
const DIR = `${HOME}/.claude/relay/Склад (A)`
const NOW = Date.UTC(2026, 9, 14, 9, 0)

// Світ: заповнення контексту, файли на диску, що виконав рушій
function world(on: On, opts: { percent?: number; git?: boolean; clearFails?: boolean } = {}) {
  const st = { percent: opts.percent ?? 85, files: {} as Record<string, number> }
  const sent: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const argvs: string[][] = []
  const clock = mock.clock(on, { now: NOW })
  ;(globalThis as any).__clock = clock
  mock.env(on, { HOME })
  on('session.start', async ($, e) => e as any)
  on('session.root', async () => ({ value: ROOT }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000, percent: st.percent }, rateLimits: [], cost: { usd: 0 } } }) as any)
  on('command.register', async () => ({ value: undefined as any }))
  on('command.run', async ($, e: any) => {
    commands.push(e.command)
    if (e.command === 'clear' && opts.clearFails) throw new Error('недоступно')
    return { text: '' } as any
  })
  on('prompt.submit', async ($, e) => { sent.push(e.text); return { text: e.text } as any })
  on('ui.toast', async ($, e) => { toasts.push(e.text); return { value: undefined } as any })
  on('turn.complete', async () => ({ text: '' }) as any)
  on('process.run', async ($, e: any) => {
    argvs.push(e.argv)
    if (e.argv[0] === 'git' && !opts.git) return { value: { stdout: '', stderr: 'not a git repository', exitCode: 128 } } as any
    if (e.argv.includes('status')) return { value: { stdout: '## main\n M звіт.md\n?? нове.xlsx', stderr: '', exitCode: 0 } } as any
    if (e.argv.includes('log')) return { value: { stdout: 'abc123 перший коміт', stderr: '', exitCode: 0 } } as any
    return { value: { stdout: '', stderr: '', exitCode: 0 } } as any
  })
  on('fs.stat', async ($, e: any) => {
    if (!(e.path in st.files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: st.files[e.path], mtimeMs: NOW } } as any
  })
  on('fs.list', async ($, e: any) => ({
    value: Object.keys(st.files).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: st.files[f], mtimeMs: NOW })),
  }) as any)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as any
  })
  return { st, sent, commands, toasts, argvs, clock }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as any
const start = ($: any) => $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as any)
const done = ($: any, reason = 'answer') =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1000, isAborted: reason === 'aborted', reason, text: '' } as any)
const band = async ($: any, surface: 'terminal' | 'desktop' = 'desktop', props = BAND) => {
  const ui = await $.ui.mount({ plugin: 'relay', surface, component: 'AbovePrompt', props })
  return { ui, text: (await ui.find({ type: 'Text', text: /^(🔁|✍️)/ }))?.text ?? '' }
}
// Команда /relay і запуск передачі одразу після її відповіді
const relay = async ($: any) => {
  await $.command.run({ command: 'relay', args: '' } as any)
  await (globalThis as any).__clock.advance(1)
}
const relayFile = (sent: string) => /`([^`]+relay-\d{8}-\d{6}\.md)`/.exec(sent)![1]!

describe('естафета', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`повний цикл: пропозиція → документ → очищення → продовження, ${surface}`, async ($, on) => {
      const { st, sent, commands } = world(on, { percent: 85, git: true })
      await start($)
      await done($)
      const b = await band($, surface)
      expect(b.text).toBe('🔁 Контекст заповнено на 85% — передати роботу в чисте вікно?')

      await b.ui.press({ key: 'relay' })
      expect(sent).toHaveLength(1)
      const file = relayFile(sent[0]!)
      expect(file.startsWith(`${DIR}/relay-`)).toBe(true)
      for (const part of ['**Мета**', '**Зроблено**', '**Рішення**', '**Пастки**', '**Далі**', '**Стан**', 'не бачить цієї розмови', 'Не вписуй паролі']) {
        expect(sent[0]).toContain(part)
      }
      expect(sent[0]).toContain('?? нове.xlsx')
      expect(sent[0]).toContain('abc123 перший коміт')
      expect((await band($, surface)).text).toBe('✍️ Естафета: Claude пише документ передачі…')

      st.files[file] = 2400
      await done($)
      expect(commands).toEqual(['clear'])
      expect(sent).toHaveLength(2)
      expect(sent[1]).toContain(`Прочитай документ передачі \`${file}\``)
      expect(sent[1]).toContain('Спершу в 3–5 рядках скажи, що ти зрозумів')
      expect((await band($, surface)).text).toBe('')
    })
  }

  test('нижче порога — нічого не пропонує; поріг налаштовується', async ($, on) => {
    world(on, { percent: 75 })
    await start($)
    await done($)
    expect((await band($)).text).toBe('')
  })

  test('поріг 70% із налаштувань', { options: { threshold: 70 } } as any, async ($: any, on: any) => {
    world(on, { percent: 75 })
    await start($)
    await done($)
    expect((await band($)).text).toBe('🔁 Контекст заповнено на 75% — передати роботу в чисте вікно?')
  })

  test('поки Claude працює — пропозиції немає', async ($, on) => {
    world(on, { percent: 90 })
    await start($)
    await done($)
    expect((await band($, 'desktop', { ...BAND, isWorking: true })).text).toBe('')
  })

  test('«Пізніше» ховає до наступних +5%', async ($, on) => {
    const { st } = world(on, { percent: 82 })
    await start($)
    await done($)
    await (await band($)).ui.press({ key: 'later' })
    expect((await band($)).text).toBe('')
    st.percent = 86
    await done($)
    expect((await band($)).text).toBe('')
    st.percent = 87
    await done($)
    expect((await band($)).text).toContain('87%')
  })

  test('документ не записано — сесію не очищено, чекаємо далі', async ($, on) => {
    const { sent, commands } = world(on)
    await start($)
    await relay($)
    await done($)
    expect(commands).toEqual([])
    expect(sent).toHaveLength(1)
    expect((await band($)).text).toBe('✍️ Естафета: Claude пише документ передачі…')
  })

  test('документ закороткий — сесію не очищено, попередження', async ($, on) => {
    const { st, sent, commands, toasts } = world(on)
    await start($)
    await relay($)
    st.files[relayFile(sent[0]!)] = 40
    await done($)
    expect(commands).toEqual([])
    expect(toasts[0]).toContain('Документ передачі закороткий (40 Б) — сесію не очищено')
  })

  test('хід перервано — передачу скасовано, сесію не очищено', async ($, on) => {
    const { commands, toasts } = world(on)
    await start($)
    await relay($)
    await done($, 'aborted')
    expect(commands).toEqual([])
    expect(toasts).toEqual(['Передачу скасовано: хід перервано. Сесію не очищено.'])
    expect((await band($)).text).toContain('🔁')
  })

  test('очищення не вдалося — повідомляє, де документ', async ($, on) => {
    const { st, sent, toasts } = world(on, { clearFails: true })
    await start($)
    await relay($)
    const file = relayFile(sent[0]!)
    st.files[file] = 2000
    await done($)
    expect(toasts[0]).toContain('Не вдалося перейти в чисте вікно')
    expect(toasts[0]).toContain(file)
  })

  test('подвійне натискання не запускає дві передачі', async ($, on) => {
    const { sent } = world(on)
    await start($)
    await relay($)
    const r: any = await $.command.run({ command: 'relay', args: '' } as any)
    await (globalThis as any).__clock.advance(1)
    expect(sent).toHaveLength(1)
    expect(r.text).toBe('Передача вже йде: чекаю на документ від Claude.')
  })

  test('не git — без розділу з фактами; тека документів створюється', async ($, on) => {
    const { sent, argvs } = world(on, { git: false })
    await start($)
    await relay($)
    expect(sent[0]).not.toContain('Факти для розділу')
    expect(argvs[0]).toEqual(['mkdir', '-p', DIR])
  })

  test('/relay список — документи проєкту, найновіші вгорі', async ($, on) => {
    const { st } = world(on)
    st.files[`${DIR}/relay-20261010-090000.md`] = 1000
    st.files[`${DIR}/relay-20261012-090000.md`] = 1000
    st.files[`${DIR}/нотатка.md`] = 10
    await start($)
    const r: any = await $.command.run({ command: 'relay', args: 'список' } as any)
    expect(r.text).toBe(`Документи передачі (2), найновіші вгорі:\n- ${DIR}/relay-20261012-090000.md\n- ${DIR}/relay-20261010-090000.md`)
  })
})
