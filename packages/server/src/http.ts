import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError, type ZodSchema } from 'zod'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Wrap an async handler so rejections reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next)
  }

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    throw new HttpError(400, msg)
  }
  return r.data
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => i.message).join('; ') })
    return
  }
  const e = err as { code?: string; message?: string }
  if (e?.code === 'P2025') {
    res.status(404).json({ error: 'not found' })
    return
  }
  console.error(err)
  res.status(500).json({ error: e?.message ?? 'internal error' })
}
