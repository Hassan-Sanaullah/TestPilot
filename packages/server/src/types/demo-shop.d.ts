declare module '@testpilot/demo-shop' {
  import type { Express } from 'express'
  export const SEED_USERS: { id: string; name: string; email: string; password: string; role: string }[]
  /**
   * `bugs` selects which seeded defects are live (ids 1-5). Omit it and all
   * five are on. An evaluation needs a correct shop as well as a broken one:
   * detecting bugs means nothing without measuring false alarms.
   */
  export function createShopApp(options?: { bugs?: number[] | Set<number> }): Express
}
