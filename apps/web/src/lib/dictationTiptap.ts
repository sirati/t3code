import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { flushSync } from "react-dom";
import { registerDictationEditor } from "./dictationTargets";

const pendingDraftTargets = new Map<string, Set<(editor: Editor) => void>>();

export function registerDictationTiptap(
  editor: Editor,
  captureDetached?: () =>
    | ((before: EditorState, after: EditorState, submit: boolean) => boolean)
    | undefined,
  draftKey?: string,
) {
  if (draftKey) {
    for (const attach of pendingDraftTargets.get(draftKey) ?? []) attach(editor);
  }
  return registerDictationEditor(editor.view.dom, () => {
    if (!editor.isEditable || editor.isDestroyed) return null;
    let bookmark = editor.state.selection.getBookmark();
    let state: EditorState | null = editor.state;
    let currentEditor: Editor | null = editor;
    let detached = captureDetached?.();
    let form = editor.view.dom.closest("form");
    let disposed = false;
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
      apply(text, submit) {
        const editor = currentEditor;
        if (disposed || !editor || !state) return false;
        if (editor.isDestroyed || !editor.view.dom.isConnected) {
          if (!detached) return false;
          const selection = bookmark.resolve(state.doc);
          return detached(
            state,
            state.apply(state.tr.insertText(text, selection.from, selection.to)),
            submit,
          );
        }
        if (!editor.isEditable) return false;
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
  });
}
