import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { flushSync } from "react-dom";
import { registerDictationEditor } from "./dictationTargets";

type DetachedTarget = (before: EditorState, after: EditorState, submit: boolean) => boolean;

const pendingDraftTargets = new Map<string, Set<(editor: Editor) => void>>();

export function registerDictationTiptap(
  editor: Editor,
  captureDetached?: () => DetachedTarget | undefined,
  draftKey?: string,
) {
  if (draftKey) {
    for (const attach of pendingDraftTargets.get(draftKey) ?? []) attach(editor);
  }
  return registerDictationEditor(
    editor.view.dom,
    () => captureTiptapTarget(editor, captureDetached?.(), draftKey),
    draftKey ? `draft:${draftKey}` : undefined,
  );
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
  let failure: string | null = null;
  const map = ({ transaction }: { transaction: Transaction }) => {
    if (!currentEditor) return;
    bookmark = bookmark.map(transaction.mapping);
    state = currentEditor.state;
  };
  const attach = (next: Editor) => {
    if (disposed || !state) return;
    if (JSON.stringify(state.doc.toJSON()) !== JSON.stringify(next.state.doc.toJSON())) return;
    currentEditor?.off("transaction", map);
    currentEditor = next;
    form = next.view.dom.closest("form");
    state = next.state;
    next.on("transaction", map);
  };
  if (draftKey) {
    const targets = pendingDraftTargets.get(draftKey) ?? new Set();
    targets.add(attach);
    pendingDraftTargets.set(draftKey, targets);
  }
  editor.on("transaction", map);
  return {
    apply(text: string, submit: boolean) {
      failure = null;
      const editor = currentEditor;
      if (disposed || !editor || !state) {
        failure = "The captured editor state was released before delivery.";
        return false;
      }
      if (editor.isDestroyed || !editor.view.dom.isConnected) {
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
        currentEditor?.off("transaction", map);
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
