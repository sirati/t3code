import { flushSync } from "react-dom";
import {
  DictationSessionTargets,
  DICTATION_SESSION_TIMEOUT_ERROR,
} from "@t3tools/shared/dictationSessionTargets";
import { toastManager } from "../components/ui/toast";

export interface DictationTarget {
  apply(text: string, submit: boolean): boolean;
  dispose(): void;
}

const editors = new WeakMap<Element, () => DictationTarget | null>();

export function registerDictationEditor(element: Element, capture: () => DictationTarget | null) {
  editors.set(element, capture);
  return () => {
    editors.delete(element);
  };
}

export function captureDictationTarget(document: Document): DictationTarget | null {
  const focused = document.activeElement;
  if (!focused) return null;
  const editor = editors.get(focused);
  if (editor) return editor();
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
  return {
    apply(text, submit) {
      const input = element;
      if (
        disposed ||
        !input ||
        !input.isConnected ||
        input.disabled ||
        input.readOnly ||
        input.value !== original
      )
        return false;
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
    dispose() {
      disposed = true;
      element = null;
    },
  };
}

export function startDictationTargets() {
  const bridge = window.desktopBridge?.dictation;
  if (!bridge) return () => {};
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
  const sessions = new DictationSessionTargets<DictationTarget>(
    (target) => target.dispose(),
    (session) => reportTimeout(session),
  );
  const unsubscribe = bridge.onEvent(async (event) => {
    if (event.kind === "offer") {
      const target = captureDictationTarget(document);
      if (target) sessions.set(event.session, target);
      try {
        await bridge.respond(event.session, target !== null);
      } catch {
        sessions.delete(event.session);
      }
    } else if (event.kind === "transcript") {
      const target = sessions.get(event.session);
      let applied = false;
      try {
        applied = target?.apply(event.text, event.submit) ?? false;
      } finally {
        sessions.delete(event.session);
        try {
          await bridge.acknowledge(
            event.session,
            applied,
            applied ? null : "The original input is no longer available.",
          );
        } catch {
          /* The broker may have cancelled or disconnected during delivery. */
        }
      }
    } else {
      const target = sessions.get(event.session);
      sessions.delete(event.session);
      if (event.kind === "timeout" && target) reportTimeout(event.session, event.error);
    }
  });
  return () => {
    unsubscribe();
    sessions.clear();
  };
}
