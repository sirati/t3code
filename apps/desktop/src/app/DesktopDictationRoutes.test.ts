import { expect, it } from "vite-plus/test";
import type { DesktopDictationEvent } from "@t3tools/contracts";
import { DesktopDictationRoutes } from "./DesktopDictationRoutes.ts";

it("moves an accepted dictation across windows only on request, and freezes ownership during delivery", () => {
  const events: Array<{ window: number; event: DesktopDictationEvent }> = [];
  const router = new DesktopDictationRoutes(
    (window, event) => events.push({ window, event }),
    () => {},
  );
  try {
    router.listen(1);
    router.listen(2);
    router.offer("session", 1, "Provider", { level: true, spectrum: true });
    expect(() => router.move("session", 2)).toThrow();
    router.accept("session", 1, true);
    router.listen(3);
    expect(events.at(-1)).toMatchObject({ window: 3, event: { kind: "active", owned: false } });
    router.audio("session", { level: 0.7, spectrum: [0.2, 0.8] });
    expect(events.at(-1)?.event).toMatchObject({ kind: "audio", level: 0.7 });
    router.move("session", 2);
    router.processing("session");
    expect(events.at(-1)?.event).toMatchObject({
      kind: "active",
      phase: "processing",
      canMove: false,
    });
    expect(() => router.move("session", 1)).toThrow();
    const count = events.length;
    router.processing("session");
    router.audio("session", { level: 1, spectrum: [1] });
    expect(events).toHaveLength(count);
    router.listen(4);
    expect(events.at(-1)?.event).toMatchObject({
      kind: "active",
      phase: "processing",
      canMove: false,
    });
    router.offer("next", 1, "Provider", { level: true, spectrum: false });
    router.accept("next", 1, true);
    router.move("next", 2);
    expect(router.deliver("session", "destination", true)).toBe(true);
    expect(events.at(-1)).toEqual({
      window: 2,
      event: { kind: "transcript", session: "session", text: "destination", submit: true },
    });
    expect(() => router.move("session", 1)).toThrow();
    expect(() => router.acknowledge("session", 1, true)).toThrow();
    router.acknowledge("session", 2, true);
    expect(events.at(-1)?.event.kind).toBe("cancelled");
    expect(() => router.move("session", 1)).toThrow();
  } finally {
    router.clear();
  }
});

it("drops a closed window's ownership and allows another window to explicitly recover the session", () => {
  const router = new DesktopDictationRoutes(
    () => {},
    () => {},
  );
  try {
    router.listen(1);
    router.listen(2);
    router.offer("session", 1, "Provider", { level: false, spectrum: false });
    router.accept("session", 1, true);
    router.unlisten(1);
    expect(router.deliver("session", "late", false)).toBe(false);
    router.move("session", 2);
    expect(router.deliver("session", "recovered", false)).toBe(true);
  } finally {
    router.clear();
  }
});
