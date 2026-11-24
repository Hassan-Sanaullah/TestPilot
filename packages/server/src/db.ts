import { PrismaClient } from '@prisma/client'
import './config' // ensures DATABASE_URL is set before the client is created

export const prisma = new PrismaClient()

/** Parse a JSON text column, tolerating bad data. */
export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
