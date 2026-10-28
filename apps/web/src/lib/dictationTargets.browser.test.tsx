import { DictationIndicators } from "../components/DictationIndicators";
import { dictationState } from "./dictationState";
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

function pendingMove() {
  let resolve!: (revision: number) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<number>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
        move: async () => 1,
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

it("shows live bars in the saved field and moves the selection and submission only after a click", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  // router: false because this test drives dictation through isolated fields.
  await using screen = await render(
    <>
      <input aria-label="first" defaultValue="original" />
      <form onSubmit={submit}>
        <input aria-label="second" defaultValue="hello world" />
      </form>
      <DictationIndicators />
    </>,
    { router: false },
  );
  using bridge = installDictationBridge();
  const stop = startDictationTargets();
  using _cleanup = { [Symbol.dispose]: stop };
  const first = screen.getByRole("textbox", { name: "first" }).element() as HTMLInputElement;
  const second = screen.getByRole("textbox", { name: "second" }).element() as HTMLInputElement;
  const originalPadding = second.style.paddingInlineEnd;
  first.focus();
  await bridge.deliver({
    kind: "offer",
    session: "ui",
    provider: "Speech",
    audio: { level: true, spectrum: true },
  });
  await bridge.deliver({
    kind: "active",
    session: "ui",
    provider: "Speech",
    owned: true,
    canMove: true,
    revision: 0,
    audio: { level: true, spectrum: true },
  });
  const originalBars = page.getByRole("img", { name: "Receiving dictation: first", exact: true });
  await expect.element(originalBars).toBeVisible();
  await bridge.deliver({
    kind: "audio",
    session: "ui",
    level: 0.8,
    spectrum: [0.2, 0.4, 0.6, 0.8, 1],
  });
  await vi.waitFor(() =>
    expect(originalBars.element().querySelectorAll("rect")[4]?.getAttribute("height")).toBe("18"),
  );
  second.focus();
  second.setSelectionRange(6, 11);
  await expect.element(originalBars).toBeVisible();
  await page.getByRole("button", { name: "Move dictation here: second", exact: true }).click();
  await expect
    .element(page.getByRole("img", { name: "Receiving dictation: second", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Move dictation here: first", exact: true }))
    .toBeVisible();
  first.focus();
  await bridge.deliver({ kind: "transcript", session: "ui", text: "speech", submit: true });
  expect(first.value).toBe("original");
  expect(second.value).toBe("hello speech");
  expect(document.activeElement).toBe(first);
  expect(submit).toHaveBeenCalledOnce();
  expect(bridge.acknowledge).toHaveBeenCalledWith("ui", true, null);
  await expect
    .element(page.getByRole("button", { name: "Move dictation here: first", exact: true }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(second.style.paddingInlineEnd).toBe(originalPadding));
});

it.each(["rejected", "superseded", "cancelled", "finishing"] as const)(
  "releases pending move targets when %s",
  async (outcome) => {
    // router: false because this test drives IPC ownership races directly.
    await using screen = await render(
      <>
        <input aria-label="first" />
        <input aria-label="second" />
      </>,
      { router: false },
    );
    using bridge = installDictationBridge();
    using _errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = screen.getByRole("textbox", { name: "first" }).element() as HTMLInputElement;
    const second = screen.getByRole("textbox", { name: "second" }).element() as HTMLInputElement;
    const original = { apply: vi.fn(() => true), dispose: vi.fn() };
    const candidate = { apply: vi.fn(() => true), dispose: vi.fn() };
    const unregisterFirst = registerDictationEditor(first, () => original);
    const unregisterSecond = registerDictationEditor(second, () => candidate);
    const stop = startDictationTargets();
    using _cleanup = {
      [Symbol.dispose]() {
        stop();
        unregisterFirst();
        unregisterSecond();
      },
    };
    first.focus();
    await bridge.deliver({ kind: "offer", session: "race" });
    const active = {
      kind: "active" as const,
      session: "race",
      provider: "Speech",
      owned: true,
      canMove: true,
      revision: 0,
      audio: { level: true, spectrum: false },
    };
    await bridge.deliver(active);
    const pending = pendingMove();
    using _move = vi
      .spyOn(window.desktopBridge!.dictation!, "move")
      .mockReturnValue(pending.promise);
    const moved = dictationState.getState().move!("race", second);
    if (outcome === "rejected") pending.reject(new Error("Already finished"));
    else {
      if (outcome === "superseded") await bridge.deliver({ ...active, owned: false, revision: 2 });
      if (outcome === "cancelled") await bridge.deliver({ kind: "cancelled", session: "race" });
      if (outcome === "finishing") await bridge.deliver({ ...active, canMove: false });
      pending.resolve(1);
    }
    expect(await moved).toBe(false);
    if (outcome === "rejected" || outcome === "finishing") {
      expect(original.dispose).not.toHaveBeenCalled();
      await bridge.deliver({ kind: "transcript", session: "race", text: "speech", submit: false });
      expect(original.apply).toHaveBeenCalledOnce();
    }
    expect(candidate.apply).not.toHaveBeenCalled();
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  },
);

it("does not extend the session lifetime when voice updates arrive or the destination moves", async () => {
  // router: false because this test checks resource deadlines without navigation.
  await using screen = await render(
    <>
      <input aria-label="first" />
      <input aria-label="second" />
    </>,
    { router: false },
  );
  using _timers = fakeTimers();
  using errors = vi.spyOn(console, "error").mockImplementation(() => {});
  using bridge = installDictationBridge();
  const first = screen.getByRole("textbox", { name: "first" }).element() as HTMLInputElement;
  const second = screen.getByRole("textbox", { name: "second" }).element() as HTMLInputElement;
  const original = { apply: vi.fn(() => true), dispose: vi.fn() };
  const candidate = { apply: vi.fn(() => true), dispose: vi.fn() };
  const unregisterFirst = registerDictationEditor(first, () => original);
  const unregisterSecond = registerDictationEditor(second, () => candidate);
  const stop = startDictationTargets();
  using _cleanup = {
    [Symbol.dispose]() {
      stop();
      unregisterFirst();
      unregisterSecond();
    },
  };
  first.focus();
  await bridge.deliver({ kind: "offer", session: "deadline" });
  await bridge.deliver({
    kind: "active",
    session: "deadline",
    provider: "Speech",
    owned: true,
    canMove: true,
    revision: 0,
    audio: { level: true, spectrum: false },
  });
  await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
  await bridge.deliver({ kind: "audio", session: "deadline", level: 1, spectrum: null });
  expect(await dictationState.getState().move!("deadline", second)).toBe(true);
  expect(original.dispose).toHaveBeenCalledOnce();
  expect(candidate.dispose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(candidate.dispose).toHaveBeenCalledOnce();
  expect(dictationState.getState().sessions).toEqual([]);
  expect(errors).toHaveBeenCalledOnce();
  expect(bridge.acknowledge).toHaveBeenCalledWith(
    "deadline",
    false,
    expect.stringContaining("30 minutes"),
  );
});

it("inserts into a transferred destination even if delivery arrives before its move receipt", async () => {
  // router: false because this test checks ordered main-process events and late IPC receipts.
  await using screen = await render(
    <>
      <input aria-label="first" />
      <input aria-label="second" />
    </>,
    { router: false },
  );
  using bridge = installDictationBridge();
  const first = screen.getByRole("textbox", { name: "first" }).element() as HTMLInputElement;
  const second = screen.getByRole("textbox", { name: "second" }).element() as HTMLInputElement;
  const original = { apply: vi.fn(() => true), dispose: vi.fn() };
  const candidate = { apply: vi.fn(() => true), dispose: vi.fn() };
  const unregisterFirst = registerDictationEditor(first, () => original);
  const unregisterSecond = registerDictationEditor(second, () => candidate);
  const stop = startDictationTargets();
  using _cleanup = {
    [Symbol.dispose]() {
      stop();
      unregisterFirst();
      unregisterSecond();
    },
  };
  first.focus();
  await bridge.deliver({ kind: "offer", session: "fast-delivery" });
  const active = {
    kind: "active" as const,
    session: "fast-delivery",
    provider: "Speech",
    owned: true,
    canMove: true,
    revision: 0,
    audio: { level: false, spectrum: false },
  };
  await bridge.deliver(active);
  const pending = pendingMove();
  using _move = vi.spyOn(window.desktopBridge!.dictation!, "move").mockReturnValue(pending.promise);
  const moved = dictationState.getState().move!("fast-delivery", second);
  await bridge.deliver({ ...active, revision: 1 });
  await bridge.deliver({ ...active, revision: 1, canMove: false });
  await bridge.deliver({
    kind: "transcript",
    session: "fast-delivery",
    text: "speech",
    submit: true,
  });
  pending.resolve(1);
  await moved;
  expect(original.apply).not.toHaveBeenCalled();
  expect(candidate.apply).toHaveBeenCalledWith("speech", true);
  expect(original.dispose).toHaveBeenCalledOnce();
  expect(candidate.dispose).toHaveBeenCalledOnce();
  expect(dictationState.getState().sessions).toEqual([]);
});
