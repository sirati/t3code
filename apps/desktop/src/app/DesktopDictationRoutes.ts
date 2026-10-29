import type { DesktopDictationEvent } from "@t3tools/contracts";
import {
  DictationSessionTargets,
  DICTATION_SESSION_TIMEOUT_ERROR,
} from "@t3tools/shared/dictationSessionTargets";

type Audio = { level: boolean; spectrum: boolean };
type Route = {
  owner: number | null;
  phase: "offered" | "recording" | "processing" | "delivering";
  provider: string;
  audio: Audio;
  revision: number;
};

export class DesktopDictationRoutes {
  private readonly listeners = new Set<number>();
  private readonly sessions: DictationSessionTargets<Route>;
  private readonly send: (window: number, event: DesktopDictationEvent) => void;
  private readonly reportError: (session: string, error: string) => void;

  constructor(
    send: (window: number, event: DesktopDictationEvent) => void,
    reportError: (session: string, error: string) => void,
  ) {
    this.send = send;
    this.reportError = reportError;
    this.sessions = new DictationSessionTargets(
      () => {},
      (session) => {
        this.reportError(session, DICTATION_SESSION_TIMEOUT_ERROR);
        this.broadcast({ kind: "timeout", session, error: DICTATION_SESSION_TIMEOUT_ERROR });
      },
    );
  }

  private broadcast(event: DesktopDictationEvent) {
    for (const id of this.listeners) this.send(id, event);
  }

  private publish(session: string, route: Route) {
    for (const id of this.listeners)
      this.send(id, {
        kind: "active",
        session,
        provider: route.provider,
        audio: route.audio,
        owned: route.owner === id,
        canMove: route.phase === "recording",
        phase: route.phase === "offered" ? "recording" : route.phase,
        revision: route.revision,
      });
  }

  listen(id: number) {
    this.listeners.add(id);
    for (const [session, route] of this.sessions) {
      if (route.phase !== "offered")
        this.send(id, {
          kind: "active",
          session,
          provider: route.provider,
          audio: route.audio,
          owned: route.owner === id,
          canMove: route.phase === "recording",
          phase: route.phase,
          revision: route.revision,
        });
    }
  }

  unlisten(id: number) {
    this.listeners.delete(id);
    for (const [session, route] of this.sessions) {
      if (route.owner !== id) continue;
      if (route.phase === "offered") this.end(session);
      else {
        route.owner = null;
        this.publish(session, route);
      }
    }
  }

  offer(session: string, owner: number, provider: string, audio: Audio) {
    this.sessions.set(session, { owner, provider, audio, phase: "offered", revision: 0 });
    this.send(owner, { kind: "offer", session, provider, audio });
  }

  offered(session: string, owner: number) {
    const route = this.sessions.get(session);
    if (!route || route.owner !== owner || route.phase !== "offered")
      throw new Error("Invalid dictation offer response");
    return route.audio;
  }

  accept(session: string, owner: number, accept: boolean) {
    const route = this.sessions.get(session);
    if (!route || route.owner !== owner) return;
    if (!accept) return this.end(session);
    route.phase = "recording";
    this.publish(session, route);
  }

  move(session: string, owner: number) {
    const route = this.sessions.get(session);
    if (!route || route.phase !== "recording" || !this.listeners.has(owner))
      throw new Error("This dictation has already finished or is being inserted.");
    route.owner = owner;
    route.revision += 1;
    this.publish(session, route);
    return route.revision;
  }

  audio(session: string, frame: { level: number | null; spectrum: number[] | null }) {
    const route = this.sessions.get(session);
    if (!route || route.phase !== "recording") return;
    const normalized = (value: number) =>
      Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    this.broadcast({
      kind: "audio",
      session,
      level: route.audio.level && frame.level !== null ? normalized(frame.level) : null,
      spectrum:
        route.audio.spectrum && frame.spectrum !== null
          ? frame.spectrum.slice(0, 64).map(normalized)
          : null,
    });
  }

  processing(session: string) {
    const route = this.sessions.get(session);
    if (!route || route.phase !== "recording") return;
    route.phase = "processing";
    this.publish(session, route);
  }

  deliver(session: string, text: string, submit: boolean) {
    const route = this.sessions.get(session);
    if (
      !route ||
      (route.phase !== "recording" && route.phase !== "processing") ||
      route.owner === null
    )
      return false;
    route.phase = "delivering";
    this.publish(session, route);
    this.send(route.owner, { kind: "transcript", session, text, submit });
    return true;
  }

  acknowledge(session: string, owner: number, applied: boolean) {
    const route = this.sessions.get(session);
    if (!route || route.owner !== owner || (applied && route.phase !== "delivering"))
      throw new Error("Invalid dictation acknowledgement");
    this.end(session);
  }

  end(session: string, error?: string) {
    if (!this.sessions.get(session)) return;
    this.sessions.delete(session);
    if (error) this.reportError(session, error);
    this.broadcast(error ? { kind: "timeout", session, error } : { kind: "cancelled", session });
  }

  clear() {
    for (const [session] of this.sessions) this.end(session);
  }
}
