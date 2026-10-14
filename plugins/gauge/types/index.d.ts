// Ліміт використання: яке вікно, скільки використано, коли скидається (мс; 0 — невідомо)
export type Limit = { kind: string; percent: number; resetsAt: number }

// Останній відомий стан після відповіді Claude
export type Reading = {
  // Заповнення контексту, %; null — ще не було відповіді
  percent: number | null
  tokens: number | null
  window: number | null
  limits: Limit[]
  // Коли прийшла остання відповідь основного Claude (мс); 0 — ще не було
  answeredAt: number
}

declare module 'claude-code' {
  interface PluginState {
    gauge: {
      reading: Reading
      // Заповнення після кількох останніх ходів — для прогнозу
      history: number[]
      // Сповіщення про червону зону вже показано (знову — після спаду нижче жовтої)
      isAlerted: boolean
      // Поточний час для таймера кешу: оновлюється раз на 15 с, щоб смуга перемальовувалась
      now: number
    }
  }
}
