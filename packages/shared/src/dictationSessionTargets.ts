// @effect-diagnostics globalTimers:off -- Renderer and Electron event handlers share native timers that are cleared when each session releases its target.
const DICTATION_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
export const DICTATION_SESSION_TIMEOUT_ERROR =
  "Dictation did not finish within 30 minutes. Its original input has been released. This is an unexpected session cleanup failure.";

export class DictationSessionTargets<T> {
  private readonly targets = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>();
  private readonly release: (value: T) => void;
  private readonly expired: (session: string, value: T) => void;

  constructor(release: (value: T) => void, expired: (session: string, value: T) => void) {
    this.release = release;
    this.expired = expired;
  }

  set(session: string, value: T) {
    this.delete(session);
    const timer = setTimeout(() => {
      const entry = this.targets.get(session);
      if (!entry) return;
      try {
        this.delete(session);
      } finally {
        this.expired(session, entry.value);
      }
    }, DICTATION_SESSION_MAX_AGE_MS);
    this.targets.set(session, { value, timer });
  }

  get(session: string) {
    return this.targets.get(session)?.value;
  }

  delete(session: string) {
    const entry = this.targets.get(session);
    if (!entry) return;
    this.targets.delete(session);
    clearTimeout(entry.timer);
    this.release(entry.value);
  }

  *[Symbol.iterator](): IterableIterator<[string, T]> {
    for (const [session, entry] of this.targets) yield [session, entry.value];
  }

  clear() {
    for (const session of this.targets.keys()) this.delete(session);
  }
}
