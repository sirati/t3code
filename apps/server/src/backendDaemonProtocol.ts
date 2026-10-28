export const BACKEND_DAEMON_PROTOCOL = 1;
export type BackendDaemonRole = "host" | "backend";
export interface BackendDaemonReadyMessage {
  readonly type: "t3-daemon-ready";
  readonly protocol: typeof BACKEND_DAEMON_PROTOCOL;
  readonly role: BackendDaemonRole;
}

export function isBackendDaemonReady(value: unknown, role: BackendDaemonRole): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "t3-daemon-ready" &&
    "protocol" in value &&
    value.protocol === BACKEND_DAEMON_PROTOCOL &&
    "role" in value &&
    value.role === role
  );
}
