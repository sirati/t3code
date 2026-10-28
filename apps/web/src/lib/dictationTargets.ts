import { flushSync } from "react-dom";

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
  const element = document.activeElement;
  if (!element) return null;
  const editor = editors.get(element);
  if (editor) return editor();
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
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
      if (
        disposed ||
        !element.isConnected ||
        element.disabled ||
        element.readOnly ||
        element.value !== original
      )
        return false;
      const value = original.slice(0, start) + text + original.slice(end);
      const prototype =
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.setSelectionRange(start + text.length, start + text.length);
      flushSync(() =>
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
        ),
      );
      if (submit && element.form) element.form.requestSubmit();
      return true;
    },
    dispose() {
      disposed = true;
    },
  };
}

export function startDictationTargets() {
  const bridge = window.desktopBridge?.dictation;
  if (!bridge) return () => {};
  const sessions = new Map<string, DictationTarget>();
  const unsubscribe = bridge.onEvent(async (event) => {
    if (event.kind === "offer") {
      const target = captureDictationTarget(document);
      if (target) sessions.set(event.session, target);
      try {
        await bridge.respond(event.session, target !== null);
      } catch {
        target?.dispose();
        sessions.delete(event.session);
      }
    } else if (event.kind === "transcript") {
      const target = sessions.get(event.session);
      let applied = false;
      try {
        applied = target?.apply(event.text, event.submit) ?? false;
      } finally {
        target?.dispose();
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
      sessions.get(event.session)?.dispose();
      sessions.delete(event.session);
    }
  });
  return () => {
    unsubscribe();
    for (const target of sessions.values()) target.dispose();
    sessions.clear();
  };
}
