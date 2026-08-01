// Monotonic session timer. Uses process.hrtime.bigint() (a monotonic clock that
// is independent of the wall clock) so changing the Windows system time cannot
// add, freeze, or rewind session time.

export interface TimerCallbacks {
  // Called ~every second with the whole seconds elapsed since the last tick.
  onTick: (deltaSeconds: number, totalSeconds: number) => void
}

export class SessionTimer {
  private startNs = 0n
  private lastWholeSeconds = 0
  private handle: NodeJS.Timeout | null = null
  private cb: TimerCallbacks

  constructor(cb: TimerCallbacks) {
    this.cb = cb
  }

  start(): void {
    this.stop()
    this.startNs = process.hrtime.bigint()
    this.lastWholeSeconds = 0
    this.handle = setInterval(() => this.pump(), 1000)
  }

  private pump(): void {
    const elapsedNs = process.hrtime.bigint() - this.startNs
    const totalSeconds = Number(elapsedNs / 1_000_000_000n)
    const delta = totalSeconds - this.lastWholeSeconds
    if (delta > 0) {
      this.lastWholeSeconds = totalSeconds
      this.cb.onTick(delta, totalSeconds)
    }
  }

  get elapsedSeconds(): number {
    if (this.startNs === 0n) return 0
    const elapsedNs = process.hrtime.bigint() - this.startNs
    return Number(elapsedNs / 1_000_000_000n)
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle)
      this.handle = null
    }
    this.startNs = 0n
    this.lastWholeSeconds = 0
  }
}
