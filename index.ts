import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { loadConfig } from "./src/config.ts";
import type { LoadConfigResult } from "./src/config.ts";
import { findPrefixConflicts } from "./src/conflicts.ts";
import type { PrefixConflict } from "./src/conflicts.ts";
import { PrefixEditor } from "./src/prefix-editor.ts";

const STATUS_KEY = "pi-prefix";
const STATUS_COMMAND = "pi-prefix";
const SHORTCUT_DESCRIPTION = "Activate the pi-prefix prefix key";
// WHY: third-party shortcut collisions cannot be inventoried publicly; Pi
// resolves them by load order and reports them under Extension issues.
const THIRD_PARTY_LIMIT_NOTE =
  "Third-party extension shortcut collisions are reported by Pi under [Extension issues] and resolved by load order.";

type SessionState = {
  result: LoadConfigResult;
  projectTrusted: boolean;
  wrapper: PrefixEditor | undefined;
  conflicts: PrefixConflict[];
  shortcutRegistered: boolean;
};

function formatDiagnostics(result: LoadConfigResult, level: "error" | "warning"): string[] {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.level === level)
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
}

function bindingSummary(state: SessionState): string {
  const bindings = state.result.config?.bindings;
  if (bindings === undefined) return "none";
  return [...bindings.entries()]
    .map(([key, target]) => {
      const description =
        "action" in target
          ? `action ${target.action}`
          : "command" in target
            ? `command ${target.command}${target.submit ? " (submit)" : ""}`
            : `event ${target.event}`;
      return `${key} -> ${description}`;
    })
    .join(", ");
}

function statusMessage(state: SessionState | undefined, agentDir: string): string {
  if (state === undefined || state.result.config === undefined) {
    return [
      "pi-prefix: inactive",
      `global config: ${agentDir}/pi-prefix.json`,
      "No effective prefix and bindings. See the package README for configuration.",
    ].join(" | ");
  }
  const { config } = state.result;
  const lines = [
    "pi-prefix: active",
    `prefix: ${config.prefix}`,
    `timeout: ${config.timeoutMs}ms`,
    `bindings: ${bindingSummary(state)}`,
    `project trusted: ${state.projectTrusted ? "yes" : "no"}`,
    `global: ${state.result.globalPath}`,
    `project: ${state.result.projectPath}${state.result.projectLoaded ? " (loaded)" : ""}`,
  ];
  for (const error of formatDiagnostics(state.result, "error")) {
    lines.push(`error: ${error}`);
  }
  for (const warning of formatDiagnostics(state.result, "warning")) {
    lines.push(`warning: ${warning}`);
  }
  for (const conflict of state.conflicts) {
    lines.push(`conflict: ${conflict.key} is bound to ${conflict.keybinding}`);
  }
  lines.push(THIRD_PARTY_LIMIT_NOTE);
  return lines.join(" | ");
}

export function setupPiPrefix(
  pi: ExtensionAPI,
  options: { agentDir: string },
): void {
  let state: SessionState | undefined;

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show pi-prefix status, loaded config layers, and conflicts",
    handler: async (_args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(statusMessage(state, options.agentDir), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const result = loadConfig({
      agentDir: options.agentDir,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    for (const error of formatDiagnostics(result, "error")) {
      ctx.ui.notify(`pi-prefix: ${error}`, "error");
    }
    for (const warning of formatDiagnostics(result, "warning")) {
      ctx.ui.notify(`pi-prefix: ${warning}`, "warning");
    }
    if (result.config === undefined) {
      // WHY: absence of a full map is ordinary; the extension stays inert
      // without touching the editor chain.
      return;
    }
    state = {
      result,
      projectTrusted: ctx.isProjectTrusted(),
      wrapper: undefined,
      conflicts: [],
      shortcutRegistered: false,
    };
    const sessionState: SessionState = state;
    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
        const inner: EditorComponent = previousFactory
          ? previousFactory(tui, theme, keybindings)
          : new CustomEditor(tui, theme, keybindings);
        const config = sessionState.result.config;
        if (config === undefined) {
          return inner;
        }
        const wrapper = new PrefixEditor(tui, theme, keybindings, inner, {
          config,
          emitEvent: (event, payload) => pi.events.emit(event, payload),
          setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
          notify: (message, type) => ctx.ui.notify(message, type),
        });
        if (!sessionState.shortcutRegistered) {
          // WHY: the editor factory is the only place Pi hands extensions the
          // authoritative keybinding manager, so conflict scanning and native
          // registration both happen here, once per session.
          const conflicts = findPrefixConflicts(config.prefix, keybindings);
          if (conflicts.length > 0) {
            sessionState.conflicts = conflicts;
            const ids = conflicts.map((conflict) => conflict.keybinding).join(", ");
            ctx.ui.notify(
              `pi-prefix disabled: prefix ${config.prefix} conflicts with ${ids}`,
              "error",
            );
            wrapper.dispose();
            sessionState.wrapper = wrapper;
            return wrapper;
          }
          pi.registerShortcut(config.prefix as KeyId, {
            description: SHORTCUT_DESCRIPTION,
            handler: () => {
              sessionState.wrapper?.activate();
            },
          });
          sessionState.shortcutRegistered = true;
        }
        sessionState.wrapper = wrapper;
        return wrapper;
      },
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state?.wrapper?.dispose();
    state = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export default function (pi: ExtensionAPI): void {
  setupPiPrefix(pi, { agentDir: getAgentDir() });
}
