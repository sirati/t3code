import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it, vi } from "vite-plus/test";
import { fakeTimers, render } from "../../test/render";
import { page } from "vite-plus/test/browser";
import type { DesktopBridge } from "@t3tools/contracts";
import { ToastProvider } from "../components/ui/toast";
import {
  captureDictationTarget,
  registerDictationEditor,
  startDictationTargets,
} from "./dictationTargets";
import { registerDictationTiptap } from "./dictationTiptap";

function installDictationBridge(rejectOffer = false) {
  type Listener = Parameters<NonNullable<DesktopBridge["dictation"]>["onEvent"]>[0];
  let deliver: Listener = () => {};
  const acknowledge = vi.fn(async () => {});
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      dictation: {
        onEvent: (listener: Listener) => {
          deliver = listener;
          return () => {
            deliver = () => {};
          };
        },
        respond: async () => {
          if (rejectOffer) throw new Error("Disconnected");
        },
        acknowledge,
      },
    },
  });
  return {
    deliver: (event: Parameters<Listener>[0]) => deliver(event),
    acknowledge,
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
}

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

it("reattaches a pending selection to its own remounted draft and maps subsequent edits", async () => {
  // router: false because this test exercises editor lifetime rather than application navigation.
  await using screen = await render(<div data-testid="editor" />, { router: false });
  const element = screen.getByTestId("editor").element() as HTMLElement;
  const original = new Editor({ element, extensions: [StarterKit], content: "<p>hello world</p>" });
  const unregister = registerDictationTiptap(original, undefined, "remounted-draft");
  original.commands.setTextSelection({ from: 7, to: 12 });
  original.view.dom.focus();
  const target = captureDictationTarget(document)!;
  original.destroy();
  unregister();
  const restored = new Editor({ element, extensions: [StarterKit], content: "<p>hello world</p>" });
  const unregisterRestored = registerDictationTiptap(restored, undefined, "remounted-draft");
  try {
    restored.view.dispatch(restored.state.tr.insertText("prefix ", 1));
    restored.commands.setTextSelection(1);
    expect(target.apply("speech", false)).toBe(true);
    expect(restored.getText()).toBe("prefix hello speech");
  } finally {
    target.dispose();
    unregisterRestored();
    restored.destroy();
  }
});

it.each(["renderer", "main", "broker"] as const)(
  "releases an abandoned dictation on the %s lifetime limit, logs an error and shows it in the UI",
  async (source) => {
    await using screen = await render(
      <ToastProvider>
        <input aria-label="dictation" />
      </ToastProvider>,
    );
    using _timers = fakeTimers();
    using errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = { apply: vi.fn(() => true), dispose: vi.fn() };
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    const unregister = registerDictationEditor(input, () => target);
    using bridge = installDictationBridge();
    const stop = startDictationTargets();
    using _cleanup = {
      [Symbol.dispose]() {
        stop();
        unregister();
      },
    };
    input.focus();
    await bridge.deliver({ kind: "offer", session: "abandoned" });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(target.dispose).not.toHaveBeenCalled();
    const errorText = source === "broker" ? "Broker session timed out" : "30 minutes";
    if (source !== "renderer")
      await bridge.deliver({
        kind: "timeout",
        session: "abandoned",
        ...(source === "broker" ? { error: errorText } : {}),
      });
    await vi.advanceTimersByTimeAsync(1);
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(errorText), expect.anything());
    await expect.element(page.getByText("Dictation timed out")).toBeVisible();
    expect(bridge.acknowledge).toHaveBeenCalledWith(
      "abandoned",
      false,
      expect.stringContaining(errorText),
    );
    await bridge.deliver({
      kind: "transcript",
      session: "abandoned",
      text: "too late",
      submit: true,
    });
    expect(target.apply).not.toHaveBeenCalled();
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
  },
);

it.each(["completion", "cancellation", "rejection", "teardown"] as const)(
  "releases dictation on %s without reaching the lifetime limit",
  async (ending) => {
    // router: false because this test drives session resource cleanup through the desktop bridge.
    await using screen = await render(<input aria-label="dictation" />, { router: false });
    using _timers = fakeTimers();
    using errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    const target = { apply: vi.fn(() => true), dispose: vi.fn() };
    const unregister = registerDictationEditor(input, () => target);
    using bridge = installDictationBridge(ending === "rejection");
    const stop = startDictationTargets();
    using _cleanup = {
      [Symbol.dispose]() {
        stop();
        unregister();
      },
    };
    input.focus();
    const timers = vi.getTimerCount();
    await bridge.deliver({ kind: "offer", session: "normal" });
    if (ending === "completion")
      await bridge.deliver({
        kind: "transcript",
        session: "normal",
        text: "finished",
        submit: false,
      });
    else if (ending === "cancellation")
      await bridge.deliver({ kind: "cancelled", session: "normal" });
    else if (ending === "teardown") stop();
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(errors).not.toHaveBeenCalled();
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(target.apply).toHaveBeenCalledTimes(ending === "completion" ? 1 : 0);
  },
);
