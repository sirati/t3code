import { createStore } from "zustand/vanilla";

export interface DictationSessionView {
  session: string;
  provider: string;
  targetId: string | null;
  canMove: boolean;
  moving: boolean;
  levelSupported: boolean;
  level: number | null;
  spectrum: readonly number[] | null;
}

export const dictationState = createStore<{
  sessions: readonly DictationSessionView[];
  move: ((session: string, element: Element) => Promise<boolean>) | null;
}>(() => ({ sessions: [], move: null }));
