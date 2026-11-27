/**
 * Agents run their commands in shells that skip the user's bashrc. Codex's are interactive, so
 * on exit bash appends their commands to ~/.bash_history and cuts it to its default 500 lines.
 * An empty HISTFILE, inherited by every shell an agent starts, turns saving off.
 */
export const AGENT_SHELL_HISTORY_ENVIRONMENT = { HISTFILE: "" } as const;
