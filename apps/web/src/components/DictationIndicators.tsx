import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { AudioLines, ArrowDownToLine, XIcon } from "lucide-react";
import { dictationState, type DictationSessionView } from "../lib/dictationState";
import { dictationTargetId, isDictationElement } from "../lib/dictationTargets";
import { VoiceInputPill, VoiceWaveform } from "./chat/VoiceInputPill";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { observeResize } from "../lib/observeResize";
import { Spinner } from "./ui/spinner";

interface Field {
  element: HTMLElement;
  id: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  dock: HTMLElement | null;
}

function dictationStatus(session: DictationSessionView) {
  if (session.moving) return "Moving dictation here";
  if (session.phase === "processing") return "Transcribing…";
  if (session.phase === "delivering") return "Inserting…";
  return session.levelSupported
    ? "Recording"
    : "Recording. This provider does not supply voice levels.";
}

const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

// The composer gets the capsule in-app voice input uses, with the broker's provider in place of a timer.
function DockedDictation({ session, label }: { session: DictationSessionView; label: string }) {
  const status = dictationStatus(session);
  const recording = session.phase === "recording" && !session.moving;
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label="Cancel dictation"
              onPointerDown={keepFocus}
              onClick={() => dictationState.getState().cancel?.(session.session)}
              className="pointer-events-auto shrink-0"
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Cancel dictation</TooltipPopup>
      </Tooltip>
      <div
        role="status"
        aria-live={recording ? "off" : "polite"}
        aria-label={`${status}: ${label}`}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pe-2.5"
      >
        {recording ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {session.provider}
            </span>
            {session.levelSupported ? (
              <div className="flex w-16 min-w-0 shrink grow">
                <VoiceWaveform level={session.level ?? 0} />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Spinner aria-hidden size="sm" tone="muted" className="shrink-0" />
            <span className="min-w-0 truncate text-sm text-muted-foreground">{status}</span>
          </>
        )}
      </div>
    </VoiceInputPill>
  );
}

// A plain field only has room for the level, drawn like the in-app waveform.
function InlineDictation({ session, label }: { session: DictationSessionView; label: string }) {
  const status = dictationStatus(session);
  return (
    <span
      role="status"
      aria-label={`${status}: ${label}`}
      className="flex h-6 w-10 items-center justify-center overflow-hidden rounded-md bg-muted/48 px-1 ring-1 ring-border ring-inset"
    >
      {session.phase === "recording" && !session.moving ? (
        <VoiceWaveform level={session.levelSupported ? (session.level ?? 0) : 0} />
      ) : (
        <Spinner aria-hidden size="sm" tone="muted" />
      )}
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
  // Loudness updates must not rebuild observers or temporarily change input padding.
  const layoutKey = JSON.stringify(sessions.map(({ targetId, canMove }) => [targetId, canMove]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe native and registered editor bounds while dictation is active, releasing observers and field references when it ends.
  useLayoutEffect(() => {
    const destinations = JSON.parse(layoutKey) as readonly (readonly [string | null, boolean])[];
    let stopped = false;
    let queued = false;
    let elements: HTMLElement[] = [];
    const padding = new Map<HTMLElement, { value: string; priority: string; applied: string }>();
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
        const id = dictationTargetId(element);
        const visibleCount = destinations.filter(
          ([targetId, canMove]) => targetId === id || canMove,
        ).length;
        const composer = element
          .closest("[data-dictation-composer-editor]")
          ?.closest("[data-chat-composer-surface]");
        const dock = composer
          ? ([...composer.querySelectorAll<HTMLElement>("[data-dictation-composer-controls]")].find(
              (slot) => slot.parentElement?.checkVisibility(),
            ) ?? null)
          : null;
        if (
          !element.isConnected ||
          !isDictationElement(element) ||
          (!dock && !element.checkVisibility()) ||
          visibleCount === 0 ||
          (composer && !dock)
        ) {
          restore(element);
          continue;
        }
        const rect = (dock?.parentElement ?? element).getBoundingClientRect();
        let left = Math.max(0, rect.left),
          top = Math.max(0, rect.top);
        let right = Math.min(window.innerWidth, rect.right),
          bottom = Math.min(window.innerHeight, rect.bottom);
        for (let parent = (dock ?? element).parentElement; parent; parent = parent.parentElement) {
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
        if (right - left < 28 || bottom - top < 20 || (!dock && right < rect.right - 1)) {
          restore(element);
          continue;
        }
        const hit = document.elementFromPoint(left + 3, top + Math.min(8, (bottom - top) / 2));
        if (!dock && (!hit || !element.contains(hit))) {
          restore(element);
          continue;
        }
        if (dock) restore(element);
        else if (!padding.has(element)) {
          const width = visibleCount * 44 - 4;
          const applied = `${Math.max(width + 8, parseFloat(getComputedStyle(element).paddingInlineEnd) || 0)}px`;
          padding.set(element, {
            value: element.style.getPropertyValue("padding-inline-end"),
            priority: element.style.getPropertyPriority("padding-inline-end"),
            applied,
          });
          element.style.paddingInlineEnd = applied;
        }
        const labels =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.labels
            : null;
        next.push({
          element,
          id,
          dock,
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
            field.dock === other.dock &&
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
  }, [layoutKey]);
  return fields.map((field) => {
    const visibleSessions = sessions.filter(
      (session) => session.targetId === field.id || session.canMove,
    );
    if (!visibleSessions.length) return null;
    return createPortal(
      <span
        data-dictation-indicators=""
        className={
          field.dock
            ? "pointer-events-none flex shrink-0 items-center gap-1"
            : "pointer-events-none fixed z-[60] flex items-center gap-1 rounded-md bg-background/95"
        }
        style={
          field.dock
            ? undefined
            : {
                left: field.left + field.width - (visibleSessions.length * 44 - 4) - 4,
                top: field.top + Math.max(0, (Math.min(field.height, 32) - 24) / 2),
              }
        }
      >
        {visibleSessions.map((session) =>
          session.targetId === field.id ? (
            field.dock ? (
              <DockedDictation key={session.session} session={session} label={field.label} />
            ) : (
              <InlineDictation key={session.session} session={session} label={field.label} />
            )
          ) : session.canMove ? (
            <Tooltip key={session.session}>
              <TooltipTrigger
                render={
                  <span className="pointer-events-auto flex w-10 items-center justify-center" />
                }
              >
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
      </span>,
      field.dock ?? document.body,
      field.id,
    );
  });
}
