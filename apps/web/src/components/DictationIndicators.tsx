import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { AudioLines, ArrowDownToLine } from "lucide-react";
import { dictationState, type DictationSessionView } from "../lib/dictationState";
import { dictationTargetId, isDictationElement } from "../lib/dictationTargets";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { observeResize } from "../lib/observeResize";

interface Field {
  element: HTMLElement;
  id: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function VoiceBars({ session, label }: { session: DictationSessionView; label: string }) {
  const bands = session.spectrum;
  const magnitudes = ["low", "low-mid", "mid", "high-mid", "high"].map((id, index) => {
    if (!bands?.length) return { id, magnitude: session.level ?? 0 };
    const start = Math.floor((index * bands.length) / 5);
    const end = Math.max(start + 1, Math.floor(((index + 1) * bands.length) / 5));
    const selected = bands.slice(start, end);
    return {
      id,
      magnitude: selected.reduce((sum, band) => sum + band, 0) / Math.max(1, selected.length),
    };
  });
  const title = session.moving
    ? "Moving dictation here"
    : !session.canMove
      ? "Inserting dictation"
      : !session.levelSupported
        ? "Receiving dictation. This provider does not supply voice levels."
        : "Receiving dictation";
  return (
    <span className="pointer-events-none flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
      <svg role="img" aria-label={`${title}: ${label}`} width="24" height="22" viewBox="0 0 24 22">
        {magnitudes.map(({ id, magnitude }, index) => {
          const height = 3 + Math.max(0, Math.min(1, magnitude)) * 15;
          return (
            <rect
              key={id}
              x={2 + index * 4.2}
              y={(22 - height) / 2}
              width="2.6"
              height={height}
              rx="1.3"
              fill="currentColor"
              className="transition-[height,y] duration-100 motion-reduce:transition-none"
            />
          );
        })}
      </svg>
    </span>
  );
}

export function DictationIndicators() {
  const sessions = useStore(dictationState, (state) => state.sessions);
  return sessions.length ? <ActiveDictationIndicators sessions={sessions} /> : null;
}

function ActiveDictationIndicators({ sessions }: { sessions: readonly DictationSessionView[] }) {
  const [fields, setFields] = useState<readonly Field[]>([]);
  const count = sessions.length;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe native and registered editor bounds while dictation is active, releasing observers and field references when it ends.
  useLayoutEffect(() => {
    let stopped = false;
    let queued = false;
    let elements: HTMLElement[] = [];
    const padding = new Map<HTMLElement, { value: string; priority: string; applied: string }>();
    const width = count * 28 + 4;
    const restore = (element: HTMLElement) => {
      const original = padding.get(element);
      if (!original) return;
      if (element.style.paddingInlineEnd === original.applied) {
        if (original.value)
          element.style.setProperty("padding-inline-end", original.value, original.priority);
        else element.style.removeProperty("padding-inline-end");
      }
      padding.delete(element);
    };
    const measure = () => {
      if (stopped) return;
      const next: Field[] = [];
      for (const element of elements) {
        if (!element.isConnected || !isDictationElement(element) || !element.checkVisibility())
          continue;
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left),
          top = Math.max(0, rect.top);
        let right = Math.min(window.innerWidth, rect.right),
          bottom = Math.min(window.innerHeight, rect.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
        }
        if (right - left < 28 || bottom - top < 20) continue;
        const hit = document.elementFromPoint(left + 3, top + Math.min(8, (bottom - top) / 2));
        if (!hit || !element.contains(hit)) continue;
        const labels =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.labels
            : null;
        next.push({
          element,
          id: dictationTargetId(element),
          label:
            element.getAttribute("aria-label") ??
            labels?.[0]?.textContent?.trim() ??
            element.getAttribute("placeholder") ??
            "text field",
          left,
          top,
          width: right - left,
          height: bottom - top,
        });
      }
      setFields((previous) =>
        previous.length === next.length &&
        previous.every((field, i) => {
          const other = next[i];
          return (
            other &&
            field.element === other.element &&
            field.id === other.id &&
            field.label === other.label &&
            field.left === other.left &&
            field.top === other.top &&
            field.width === other.width &&
            field.height === other.height
          );
        })
          ? previous
          : next,
      );
    };
    const resized = new Map<HTMLElement, () => void>();
    const refresh = () => {
      queued = false;
      if (stopped) return;
      const next = [
        ...document.querySelectorAll<HTMLElement>("input, textarea, [contenteditable=true]"),
      ].filter(isDictationElement);
      for (const element of elements)
        if (!next.includes(element)) {
          resized.get(element)?.();
          resized.delete(element);
          restore(element);
        }
      for (const element of next)
        if (!elements.includes(element)) {
          const applied = `${Math.max(width + 8, parseFloat(getComputedStyle(element).paddingInlineEnd) || 0)}px`;
          padding.set(element, {
            value: element.style.getPropertyValue("padding-inline-end"),
            priority: element.style.getPropertyPriority("padding-inline-end"),
            applied,
          });
          element.style.paddingInlineEnd = applied;
          resized.set(element, observeResize(element, measure));
        }
      elements = next;
      measure();
    };
    const changed = new MutationObserver((records) => {
      if (
        queued ||
        records.every(
          (record) =>
            record.target instanceof Element &&
            record.target.closest("[data-dictation-indicators]"),
        )
      )
        return;
      queued = true;
      queueMicrotask(refresh);
    });
    refresh();
    changed.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "disabled",
        "readonly",
        "hidden",
        "contenteditable",
        "aria-label",
        "style",
        "class",
      ],
    });
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      stopped = true;
      changed.disconnect();
      for (const unobserve of resized.values()) unobserve();
      resized.clear();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      for (const element of padding.keys()) restore(element);
      elements = [];
    };
  }, [count]);
  return createPortal(
    <div data-dictation-indicators="" className="pointer-events-none fixed inset-0 z-[60]">
      {fields.map((field) => (
        <div
          key={field.id}
          className="absolute flex items-center gap-1 rounded-md bg-background/95"
          style={{
            left: field.left + field.width - (count * 28 + 4),
            top: field.top + Math.max(0, (Math.min(field.height, 32) - 24) / 2),
          }}
        >
          {sessions.map((session) =>
            session.targetId === field.id ? (
              <VoiceBars key={session.session} session={session} label={field.label} />
            ) : session.canMove ? (
              <Tooltip key={session.session}>
                <TooltipTrigger render={<span className="pointer-events-auto" />}>
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={`Move dictation here: ${field.label}${count > 1 ? ` (${session.provider})` : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      void dictationState.getState().move?.(session.session, field.element);
                    }}
                  >
                    <span className="relative flex size-5 items-center">
                      <AudioLines size={14} />
                      <ArrowDownToLine size={10} className="absolute -right-0.5 bottom-0" />
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipPopup>Move ongoing dictation here</TooltipPopup>
              </Tooltip>
            ) : null,
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
