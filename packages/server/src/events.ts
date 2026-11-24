/**
 * In-process event bus for live run updates. The SSE route subscribes per run;
 * the runner publishes. (Single-process deployment — no broker needed.)
 */
import { EventEmitter } from 'node:events'
import type { RunEvent } from '@testpilot/shared'

class RunEventBus extends EventEmitter {
  publish(ev: RunEvent): void {
    // Suite events belong to a suite, not to any one run, so only the
    // everything-stream carries them.
    if ('runId' in ev) this.emit(`run:${ev.runId}`, ev)
    this.emit('any', ev)
  }
  subscribe(runId: string, cb: (ev: RunEvent) => void): () => void {
    const key = `run:${runId}`
    this.on(key, cb)
    return () => this.off(key, cb)
  }
  subscribeAll(cb: (ev: RunEvent) => void): () => void {
    this.on('any', cb)
    return () => this.off('any', cb)
  }
}

export const runEvents = new RunEventBus()
runEvents.setMaxListeners(200)
