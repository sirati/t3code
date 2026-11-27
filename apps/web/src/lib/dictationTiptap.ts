import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { flushSync } from "react-dom";
import { dictationTargetIdForDraft } from "./dictationState";
import { registerDictationEditor } from "./dictationTargets";

type DetachedTarget = (before: EditorState, after: EditorState, submit: boolean) => boolean;

const pendingDraftTargets = new Map<string, Set<(editor: Editor) => void>>();
// Targets bound to an editor. A composer keeps its editor when it switches drafts, so ending the
// editor's registration for a draft lets go of them, as an unmount does.
const boundTargets = new WeakMap<Editor, Set<() => void>>();

export function registerDictationTiptap(
  editor: Editor,
  captureDetached?: () => DetachedTarget | undefined,
  draftKey?: string,
) {
  // A remounted editor shows the draft already; a reused one only after its content swap.
  const attachPending = () => {
    if (draftKey) for (const attach of pendingDraftTargets.get(draftKey) ?? []) attach(editor);
  };
  attachPending();
  editor.on("transaction", attachPending);
  const unregister = registerDictationEditor(
    editor.view.dom,
    () => captureTiptapTarget(editor, captureDetached?.(), draftKey),
    draftKey ? dictationTargetIdForDraft(draftKey) : undefined,
  );
  return () => {
    editor.off("transaction", attachPending);
    for (const release of boundTargets.get(editor) ?? []) release();
    unregister();
  };
}

// Session closures must not inherit the registration callback's mounted component scope.
function captureTiptapTarget(
  editor: Editor,
  detached: DetachedTarget | undefined,
  draftKey?: string,
) {
  if (!editor.isEditable || editor.isDestroyed) return null;
  let bookmark = editor.state.selection.getBookmark();
  let state: EditorState | null = editor.state;
  let currentEditor: Editor | null = editor;
  let form = editor.view.dom.closest("form");
  let disposed = false;
  let bound = false;
  let failure: string | null = null;
  const map = ({ transaction }: { transaction: Transaction }) => {
    if (!currentEditor) return;
    bookmark = bookmark.map(transaction.mapping);
    state = currentEditor.state;
  };
  // Keeps the draft's last state and selection; delivery then goes to the saved draft.
  const release = () => {
    if (!bound || !currentEditor) return;
    bound = false;
    currentEditor.off("transaction", map);
    boundTargets.get(currentEditor)?.delete(release);
  };
  const bind = (next: Editor) => {
    currentEditor = next;
    bound = true;
    next.on("transaction", map);
    const targets = boundTargets.get(next) ?? new Set();
    targets.add(release);
    boundTargets.set(next, targets);
  };
  const attach = (next: Editor) => {
    if (disposed || !state || (bound && currentEditor === next)) return;
    if (JSON.stringify(state.doc.toJSON()) !== JSON.stringify(next.state.doc.toJSON())) return;
    release();
    form = next.view.dom.closest("form");
    state = next.state;
    bind(next);
  };
  if (draftKey) {
    const targets = pendingDraftTargets.get(draftKey) ?? new Set();
    targets.add(attach);
    pendingDraftTargets.set(draftKey, targets);
  }
  bind(editor);
  return {
    apply(text: string, submit: boolean) {
      failure = null;
      const editor = currentEditor;
      if (disposed || !editor || !state) {
        failure = "The captured editor state was released before delivery.";
        return false;
      }
      if (!bound || editor.isDestroyed || !editor.view.dom.isConnected) {
        if (!detached) {
          failure = "The original editor unmounted without a saved draft destination.";
          return false;
        }
        const selection = bookmark.resolve(state.doc);
        const applied = detached(
          state,
          state.apply(state.tr.insertText(text, selection.from, selection.to)),
          submit,
        );
        if (!applied) failure = "The saved draft changed after its editor unmounted.";
        return applied;
      }
      if (!editor.isEditable) {
        failure = "The original editor is now read-only.";
        return false;
      }
      const selection = bookmark.resolve(editor.state.doc);
      flushSync(() =>
        editor.view.dispatch(editor.state.tr.insertText(text, selection.from, selection.to)),
      );
      if (submit) {
        if (form?.isConnected) form.requestSubmit();
        else
          editor.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
      }
      return true;
    },
    failureReason: () => failure,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        release();
      } finally {
        currentEditor = null;
        state = null;
        form = null;
        detached = undefined;
        if (draftKey) {
          const targets = pendingDraftTargets.get(draftKey);
          targets?.delete(attach);
          if (targets?.size === 0) pendingDraftTargets.delete(draftKey);
        }
      }
    },
  };
}
