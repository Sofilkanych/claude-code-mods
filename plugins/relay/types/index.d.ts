// Передача в роботі: куди Claude пише документ і коли її почали
export type Job = { file: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    relay: {
      // Заповнення контексту, %, за останньою відповіддю; null — ще невідомо
      percent: number | null
      // На якому заповненні натиснули «Пізніше»: знову запропонуємо на 5% вище
      snoozedAt: number | null
      // Передача, що чекає на документ від Claude
      job: Job | null
    }
  }
}
