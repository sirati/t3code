import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { flushSync } from "react-dom";
import { registerDictationEditor } from "./dictationTargets";

export function registerDictationTiptap(editor: Editor) {
  return registerDictationEditor(editor.view.dom, () => {
    if (!editor.isEditable || editor.isDestroyed) return null;
    let bookmark = editor.state.selection.getBookmark();
    const form = editor.view.dom.closest("form");
    let disposed = false;
    const map = ({ transaction }: { transaction: Transaction }) => {
      bookmark = bookmark.map(transaction.mapping);
    };
    editor.on("transaction", map);
    return {
      apply(text, submit) {
        if (disposed || editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected)
          return false;
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
        disposed = true;
        editor.off("transaction", map);
      },
    };
  });
}
