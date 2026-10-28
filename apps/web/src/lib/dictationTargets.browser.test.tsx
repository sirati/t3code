import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { captureDictationTarget } from "./dictationTargets";
import { registerDictationTiptap } from "./dictationTiptap";

it("replaces the captured input selection after focus moves and submits its original form", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  // router: false because these targets have no application navigation.
  await using screen = await render(
    <>
      <form onSubmit={submit}>
        <input aria-label="original" defaultValue="hello world" />
      </form>
      <input aria-label="other" />
    </>,
    { router: false },
  );
  const original = screen.getByRole("textbox", { name: "original" }).element() as HTMLInputElement;
  const other = screen.getByRole("textbox", { name: "other" }).element() as HTMLInputElement;
  original.focus();
  original.setSelectionRange(6, 11);
  const target = captureDictationTarget(document)!;
  other.focus();
  expect(target.apply("dictation", true)).toBe(true);
  expect(original.value).toBe("hello dictation");
  expect(other.value).toBe("");
  expect(document.activeElement).toBe(other);
  expect(submit).toHaveBeenCalledOnce();
  target.dispose();
});

it("fails if an ordinary input changed instead of replacing unrelated text", async () => {
  // router: false because this test only exercises DOM insertion ownership.
  await using screen = await render(<input aria-label="original" defaultValue="old draft" />, {
    router: false,
  });
  const input = screen.getByRole("textbox").element() as HTMLInputElement;
  input.focus();
  const target = captureDictationTarget(document)!;
  input.value = "new draft";
  expect(target.apply("speech", false)).toBe(false);
  expect(input.value).toBe("new draft");
  target.dispose();
});

it("maps the remembered rich-text selection through edits and inserts transcript as literal text", async () => {
  // router: false because the test creates an isolated ProseMirror editor.
  await using screen = await render(
    <>
      <div data-testid="editor" />
      <input aria-label="other" />
    </>,
    { router: false },
  );
  const editor = new Editor({
    element: screen.getByTestId("editor").element() as HTMLElement,
    extensions: [StarterKit],
    content: "<p>hello world</p>",
  });
  const unregister = registerDictationTiptap(editor);
  try {
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.view.dom.focus();
    const target = captureDictationTarget(document)!;
    editor.view.dispatch(editor.state.tr.insertText("prefix ", 1));
    editor.commands.setTextSelection(1);
    (screen.getByRole("textbox", { name: "other" }).element() as HTMLInputElement).focus();
    expect(target.apply("<b>speech</b>", false)).toBe(true);
    expect(editor.getText()).toBe("prefix hello <b>speech</b>");
    expect(editor.getHTML()).not.toContain("<b>");
    target.dispose();
    editor.view.dom.focus();
    const destroyed = captureDictationTarget(document)!;
    editor.destroy();
    expect(destroyed.apply("wrong conversation", true)).toBe(false);
    destroyed.dispose();
  } finally {
    unregister();
    if (!editor.isDestroyed) editor.destroy();
  }
});
