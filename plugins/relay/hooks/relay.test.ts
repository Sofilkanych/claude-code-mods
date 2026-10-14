import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clampThreshold, folderName } from './register'

const HOME = '/Users/u'
const ROOT = `${HOME}/Desktop/Проєкти/Склад (A)`
const DIR = `${HOME}/.claude/relay/${folderName(ROOT)}`
const NOW = Date.UTC(2026, 9, 14, 9, 0)
const HOUR = 60 * 60_000

// Світ: заповнення контексту, файли на диску, що виконав рушій
function world(on: On, opts: { percent?: number; git?: boolean; clearFails?: boolean; submitFails?: boolean } = {}) {
  const st = { percent: opts.percent ?? 85, files: {} as Record<string, number>, submitFails: opts.submitFails ?? false }
  const sent: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const argvs: string[][] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  on('session.start', async ($, e) => e as any)
  on('session.end', async ($, e: any) => ({ sessionId: e.sessionId }) as any)
  on('session.root', async () => ({ value: ROOT }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000, percent: st.percent }, rateLimits: [], cost: { usd: 0 } } }) as any)
  on('command.register', async () => ({ value: undefined as any }))
  on('command.run', async ($, e: any) => {
    commands.push(e.command)
    if (e.command === 'clear' && opts.clearFails) throw new Error('недоступно')
    return { text: '' } as any
  })
  on('prompt.submit', async ($, e) => {
    if (st.submitFails) throw new Error('відхилено')
    sent.push(e.text)
    return { text: e.text } as any
  })
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
const done = ($: any, reason = 'answer', extra: object = {}) =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1000, isAborted: reason === 'aborted', reason, text: '', ...extra } as any)
const band = async ($: any, surface: 'terminal' | 'desktop' = 'desktop', props = BAND) => {
  const ui = await $.ui.mount({ plugin: 'relay', surface, component: 'AbovePrompt', props })
  return { ui, text: (await ui.find({ type: 'Text', text: /^(🔁|✍️)/ }))?.text ?? '' }
}
const cmd = ($: any, args = '') => $.command.run({ command: 'relay', args } as any) as Promise<any>
// Команда /relay і запуск передачі одразу після її відповіді
const relay = async ($: any, clock: any) => {
  const r = await cmd($)
  await clock.advance(1)
  return r
}
const relayFile = (sent: string) => /`([^`]+relay-\d{8}-\d{6}\.md)`/.exec(sent)![1]!

describe('естафета', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`повний цикл: пропозиція → документ → очищення → продовження, ${surface}`, async ($, on) => {
      const { st, sent, commands, argvs } = world(on, { percent: 85, git: true })
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
      // Кирилиця в назвах файлів від git — без \320\267
      expect(argvs.find(a => a.includes('status'))).toContain('core.quotePath=false')
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

  test('нижче порога — нічого не пропонує', async ($, on) => {
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

  test('поріг обмежено 50–95', () => {
    expect(clampThreshold(30)).toBe(50)
    expect(clampThreshold(99)).toBe(95)
    expect(clampThreshold('abc')).toBe(80)
    expect(clampThreshold(72.4)).toBe(72)
  })

  test('поки Claude працює або відкрите опитування — пропозиції немає', async ($, on) => {
    world(on, { percent: 90 })
    await start($)
    await done($)
    expect((await band($, 'desktop', { ...BAND, isWorking: true })).text).toBe('')
    expect((await band($, 'desktop', { ...BAND, hasSurvey: true })).text).toBe('')
  })

  test('«Пізніше» ховає до наступних +5% і скидається, коли заповнення впало', async ($, on) => {
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
    await (await band($)).ui.press({ key: 'later' })
    st.percent = 20
    await done($)
    st.percent = 83
    await done($)
    expect((await band($)).text).toContain('83%')
  })

  test('ручний /clear — старий відсоток не висить у чистому вікні', async ($, on) => {
    world(on, { percent: 90 })
    await start($)
    await done($)
    expect((await band($)).text).toContain('90%')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect((await band($)).text).toBe('')
  })

  test('ручний /clear під час передачі — смуга «пише документ» не лишається', async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect((await band($)).text).toBe('')
    expect(toasts).toEqual([])
  })

  test('гаряче перезавантаження: таймер «за годину» ставиться знову на залишок', async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await clock.advance(HOUR / 2)
    await start($)
    await clock.advance(HOUR / 2 + 1000)
    expect(toasts).toEqual(['Передачу скасовано: за годину документ так і не з\'явився.'])
  })

  test('хід субагента не запускає ні очищення, ні скасування', async ($, on) => {
    const { st, sent, commands, toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    st.files[relayFile(sent[0]!)] = 3000
    await done($, 'answer', { agentId: 'sub1' })
    await done($, 'aborted', { agentId: 'sub2' })
    expect(commands).toEqual([])
    expect(toasts).toEqual([])
    expect((await band($)).text).toBe('✍️ Естафета: Claude пише документ передачі…')
  })

  test('документ не записано — сесію не очищено, чекаємо далі', async ($, on) => {
    const { sent, commands, clock } = world(on)
    await start($)
    await relay($, clock)
    await done($)
    expect(commands).toEqual([])
    expect(sent).toHaveLength(1)
    expect((await band($)).text).toBe('✍️ Естафета: Claude пише документ передачі…')
  })

  test('документ закороткий — сесію не очищено, попередження', async ($, on) => {
    const { st, sent, commands, toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    st.files[relayFile(sent[0]!)] = 40
    await done($)
    expect(commands).toEqual([])
    expect(toasts[0]).toContain('Документ передачі закороткий (40 Б) — сесію не очищено')
  })

  test('хід перервано без документа — передачу скасовано, сесію не очищено', async ($, on) => {
    const { commands, toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await done($, 'aborted')
    expect(commands).toEqual([])
    expect(toasts).toEqual(['Передачу скасовано: хід перервано. Сесію не очищено.'])
    expect((await band($)).text).toContain('🔁')
  })

  test('хід закінчився помилкою, але документ записано — передаємо', async ($, on) => {
    const { st, sent, commands, clock } = world(on)
    await start($)
    await relay($, clock)
    st.files[relayFile(sent[0]!)] = 3000
    await done($, 'error')
    expect(commands).toEqual(['clear'])
    expect(sent).toHaveLength(2)
  })

  test('помилка без документа — скасовано з власним текстом', async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await done($, 'error')
    expect(toasts).toEqual(['Передачу скасовано: хід закінчився помилкою, документа немає. Сесію не очищено.'])
  })

  test('за годину без документа — передача забувається сама', async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await clock.advance(HOUR + 1000)
    expect(toasts).toEqual(['Передачу скасовано: за годину документ так і не з\'явився.'])
    expect((await band($)).text).toContain('🔁')
  })

  test('прохання до Claude не дійшло — смуга не висить, повідомлення', async ($, on) => {
    const { toasts, clock } = world(on, { submitFails: true })
    await start($)
    await relay($, clock)
    expect(toasts[0]).toContain('Не вдалося попросити Claude написати документ')
    expect((await band($)).text).toContain('🔁')
  })

  test('«Скасувати» на смузі й /relay скасувати', async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await relay($, clock)
    await (await band($)).ui.press({ key: 'cancel' })
    expect(toasts).toEqual(['Передачу скасовано. Сесію не очищено.'])
    expect((await cmd($, 'скасувати')).text).toBe('Передачі, що йде, немає.')
    await relay($, clock)
    expect((await cmd($, 'cancel')).text).toBe('Передачу скасовано.')
  })

  test('очищення не вдалося — повідомляє, де документ', async ($, on) => {
    const { st, sent, toasts, clock } = world(on, { clearFails: true })
    await start($)
    await relay($, clock)
    const file = relayFile(sent[0]!)
    st.files[file] = 2000
    await done($)
    expect(toasts[0]).toContain('Не вдалося перейти в чисте вікно')
    expect(toasts[0]).toContain(file)
  })

  test('два одночасні натискання — одна передача', async ($, on) => {
    const { sent } = world(on)
    await start($)
    await done($)
    const { ui } = await band($)
    await Promise.all([ui.press({ key: 'relay' }), ui.press({ key: 'relay' })])
    expect(sent).toHaveLength(1)
  })

  test('дві /relay поспіль — друга чесно каже, що передача вже йде', async ($, on) => {
    const { sent, clock } = world(on)
    await start($)
    expect((await cmd($)).text).toBe('Естафета: прошу Claude написати документ передачі…')
    expect((await cmd($)).text).toBe('Передача вже йде: чекаю на документ від Claude.')
    await clock.advance(1)
    expect(sent).toHaveLength(1)
  })

  test('невідомий аргумент — підказка, а не передача', async ($, on) => {
    const { sent, clock } = world(on)
    await start($)
    const r = await cmd($, 'спсок')
    await clock.advance(1)
    expect(r.text).toContain('Не знаю «спсок»')
    expect(sent).toEqual([])
  })

  test('не git — без розділу з фактами; тека документів створюється', async ($, on) => {
    const { sent, argvs, clock } = world(on, { git: false })
    await start($)
    await relay($, clock)
    expect(sent[0]).not.toContain('Факти для розділу')
    expect(argvs[0]).toEqual(['mkdir', '-p', DIR])
  })

  test('/relay список і list — документи проєкту, найновіші вгорі; порожньо — так і каже', async ($, on) => {
    const { st } = world(on)
    await start($)
    expect((await cmd($, 'список')).text).toBe('Для цього проєкту документів передачі ще немає.')
    st.files[`${DIR}/relay-20261010-090000.md`] = 1000
    st.files[`${DIR}/relay-20261012-090000.md`] = 1000
    st.files[`${DIR}/нотатка.md`] = 10
    const expected = `Документи передачі (2), найновіші вгорі:\n- ${DIR}/relay-20261012-090000.md\n- ${DIR}/relay-20261010-090000.md`
    expect((await cmd($, 'список')).text).toBe(expected)
    expect((await cmd($, 'list')).text).toBe(expected)
  })

  test('тека документів: однакові назви різних проєктів не змішуються, шлях очищено', () => {
    expect(folderName('/a/app')).not.toBe(folderName('/b/app'))
    expect(folderName('/a/app/')).toBe(folderName('/a/app'))
    expect(folderName('/x/weird`na:me')).toMatch(/^weird_na_me-[0-9a-f]{6}$/)
  })
})
