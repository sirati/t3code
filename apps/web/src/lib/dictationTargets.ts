import { flushSync } from "react-dom";
import {
  DictationSessionTargets,
  DICTATION_SESSION_TIMEOUT_ERROR,
} from "@t3tools/shared/dictationSessionTargets";
import { toastManager } from "../components/ui/toast";
import { dictationState, type DictationSessionView } from "./dictationState";

export interface DictationTarget {
  apply(text: string, submit: boolean): boolean;
  dispose(): void;
  failureReason?(): string | null;
}

const editors = new WeakMap<Element, { capture: () => DictationTarget | null; id: string }>();
const inputIds = new WeakMap<Element, string>();
let nextInputId = 0;

export function dictationTargetId(element: Element): string {
  const registered = editors.get(element);
  if (registered) return registered.id;
  let id = inputIds.get(element);
  if (!id) {
    id = `input-${++nextInputId}`;
    inputIds.set(element, id);
  }
  return id;
}

export function isDictationElement(element: Element): boolean {
  if (editors.has(element)) return element.getAttribute("contenteditable") !== "false";
  return (
    (element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ["text", "search", "url", "tel"].includes(element.type))) &&
    !element.disabled &&
    !element.readOnly
  );
}

export function registerDictationEditor(
  element: Element,
  capture: () => DictationTarget | null,
  id?: string,
) {
  editors.set(element, { capture, id: id ?? dictationTargetId(element) });
  return () => {
    editors.delete(element);
  };
}

export function captureDictationTarget(document: Document): DictationTarget | null {
  const focused = document.activeElement;
  if (!focused) return null;
  return captureDictationElement(focused);
}

function captureDictationElement(focused: Element): DictationTarget | null {
  const editor = editors.get(focused);
  if (editor) return editor.capture();
  if (!(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) return null;
  let element: HTMLInputElement | HTMLTextAreaElement | null = focused;
  if (
    element.disabled ||
    element.readOnly ||
    (element instanceof HTMLInputElement &&
      !["text", "search", "url", "tel"].includes(element.type))
  )
    return null;
  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (start === null || end === null) return null;
  const original = element.value;
  let disposed = false;
  let failure: string | null = null;
  return {
    apply(text, submit) {
      const input = element;
      failure =
        disposed || !input
          ? "The captured text input was disposed before delivery."
          : !input.isConnected
            ? "The original text input was removed from the page."
            : input.disabled || input.readOnly
              ? "The original text input is now disabled or read-only."
              : input.value !== original
                ? "The original text input changed after dictation started."
                : null;
      if (failure || !input) return false;
      const value = original.slice(0, start) + text + original.slice(end);
      const prototype =
        input instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.setSelectionRange(start + text.length, start + text.length);
      flushSync(() =>
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
        ),
      );
      if (submit && input.form) input.form.requestSubmit();
      return true;
    },
    failureReason: () => failure,
    dispose() {
      disposed = true;
      element = null;
    },
  };
}

type Session = DictationSessionView & {
  target: DictationTarget | null;
  previous: DictationTarget | null;
  previousId: string | null;
  owned: boolean;
  revision: number;
  moveRevision: number | null;
};

function releaseTargets(entry: Session) {
  const target = entry.target;
  const previous = entry.previous;
  entry.target = null;
  entry.previous = null;
  entry.targetId = null;
  entry.previousId = null;
  try {
    target?.dispose();
  } finally {
    if (previous !== target) previous?.dispose();
  }
}

export function startDictationTargets() {
  const bridge = window.desktopBridge?.dictation;
  if (!bridge) return () => {};
  const publish = () =>
    dictationState.setState({
      sessions: [...sessions].map(([session, entry]) => ({
        session,
        provider: entry.provider,
        targetId: entry.targetId,
        canMove: entry.canMove && !entry.moving,
        moving: entry.moving,
        phase: entry.phase,
        levelSupported: entry.levelSupported,
        level: entry.level,
        spectrum: entry.spectrum,
      })),
    });
  const reportTimeout = (session: string, error = DICTATION_SESSION_TIMEOUT_ERROR) => {
    console.error(error, { session });
    toastManager.add({
      type: "error",
      title: "Dictation timed out",
      description: error,
      timeout: 0,
    });
    void bridge.acknowledge(session, false, error).catch(() => {});
  };
  const sessions = new DictationSessionTargets<Session>(
    (entry) => {
      releaseTargets(entry);
      publish();
    },
    (session, entry) => {
      if (entry.owned) reportTimeout(session);
    },
  );
  const createEntry = (
    session: string,
    provider = "Dictation",
    levelSupported = false,
  ): Session => ({
    session,
    provider,
    target: null,
    targetId: null,
    previous: null,
    previousId: null,
    owned: false,
    revision: 0,
    moveRevision: null,
    canMove: false,
    moving: false,
    phase: "recording",
    levelSupported,
    level: null,
    spectrum: null,
  });
  const commitMove = async (session: string, entry: Session) => {
    try {
      const revision = await bridge.move(session);
      if (sessions.get(session) !== entry || !entry.moving) return false;
      if (entry.revision <= revision) {
        entry.revision = revision;
        entry.owned = true;
      }
      if (!entry.owned) releaseTargets(entry);
      const previous = entry.previous;
      entry.previous = null;
      entry.previousId = null;
      previous?.dispose();
      entry.moving = false;
      entry.moveRevision = null;
      publish();
      return entry.owned;
    } catch (error) {
      if (sessions.get(session) !== entry || !entry.moving) return false;
      const candidate = entry.target;
      if (!entry.owned) entry.previous?.dispose();
      entry.target = entry.owned ? entry.previous : null;
      entry.targetId = entry.owned ? entry.previousId : null;
      entry.previous = null;
      entry.previousId = null;
      candidate?.dispose();
      entry.moving = false;
      entry.moveRevision = null;
      publish();
      console.error("Could not move dictation", { session, error });
      toastManager.add({
        type: "error",
        title: "Could not move dictation",
        description: "The session may already be finishing. Try again while dictation is active.",
      });
      return false;
    }
  };
  const move = (session: string, element: Element): Promise<boolean> => {
    const entry = sessions.get(session);
    if (!entry || !entry.canMove || entry.moving) return Promise.resolve(false);
    const target = captureDictationElement(element);
    if (!target) return Promise.resolve(false);
    entry.previous = entry.target;
    entry.previousId = entry.targetId;
    entry.target = target;
    entry.targetId = dictationTargetId(element);
    entry.moving = true;
    entry.moveRevision = entry.revision;
    publish();
    return commitMove(session, entry);
  };
  dictationState.setState({ move });
  const unsubscribe = bridge.onEvent(async (event) => {
    if (event.kind === "offer") {
      const focused = document.activeElement;
      const target = captureDictationTarget(document);
      if (target && focused) {
        const entry = createEntry(
          event.session,
          event.provider,
          Boolean(event.audio?.level || event.audio?.spectrum),
        );
        entry.target = target;
        entry.targetId = dictationTargetId(focused);
        entry.owned = true;
        sessions.set(event.session, entry);
        publish();
      }
      try {
        await bridge.respond(event.session, target !== null);
      } catch {
        sessions.delete(event.session);
      }
    } else if (event.kind === "active") {
      let entry = sessions.get(event.session);
      if (!entry) {
        entry = createEntry(event.session, event.provider);
        sessions.set(event.session, entry);
      }
      if (event.revision < entry.revision) return;
      entry.revision = event.revision;
      entry.owned = event.owned;
      entry.provider = event.provider;
      entry.canMove = event.canMove;
      entry.phase = event.phase;
      if (event.phase !== "recording") {
        entry.level = null;
        entry.spectrum = null;
      }
      entry.levelSupported = event.audio.level || event.audio.spectrum;
      if (!event.owned && !entry.moving) releaseTargets(entry);
      if (
        entry.moving &&
        !event.canMove &&
        (!event.owned || event.revision === entry.moveRevision)
      ) {
        const candidate = entry.target;
        if (!event.owned) entry.previous?.dispose();
        entry.target = event.owned ? entry.previous : null;
        entry.targetId = event.owned ? entry.previousId : null;
        entry.previous = null;
        entry.previousId = null;
        candidate?.dispose();
        entry.moving = false;
        entry.moveRevision = null;
      }
      publish();
    } else if (event.kind === "audio") {
      const entry = sessions.get(event.session);
      if (!entry || entry.phase !== "recording") return;
      entry.level = event.level;
      entry.spectrum = event.spectrum;
      publish();
    } else if (event.kind === "transcript") {
      const entry = sessions.get(event.session);
      let applied = false;
      let error: string | null = null;
      try {
        applied = entry?.target?.apply(event.text, event.submit) ?? false;
        if (!applied)
          error = !entry
            ? "The renderer no longer has this dictation session."
            : !entry.target
              ? "No captured input exists for this dictation session."
              : (entry.target.failureReason?.() ?? "The captured input rejected the transcript.");
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Transcript insertion failed.";
      } finally {
        if (!applied && entry)
          console.error("Dictation delivery failed", { session: event.session, error });
        sessions.delete(event.session);
        try {
          await bridge.acknowledge(event.session, applied, error);
        } catch {
          /* The broker may have cancelled or disconnected during delivery. */
        }
      }
    } else {
      const entry = sessions.get(event.session);
      sessions.delete(event.session);
      if (event.kind === "timeout" && entry?.owned) reportTimeout(event.session, event.error);
    }
  });
  return () => {
    unsubscribe();
    sessions.clear();
    if (dictationState.getState().move === move)
      dictationState.setState({ sessions: [], move: null });
  };
}
