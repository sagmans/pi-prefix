import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalProjectPath,
  commandName,
  hashOverlay,
  loadConfig,
  parseProjectOverlay,
} from "./src/config.ts";
import type { LoadConfigResult, ProjectOverlayApproval } from "./src/config.ts";
import { findPrefixConflicts } from "./src/conflicts.ts";
import type { PrefixConflict } from "./src/conflicts.ts";
import { PrefixEditor, PROJECT_STATUS_MARKER } from "./src/prefix-editor.ts";

const STATUS_KEY = "pi-prefix";
const STATUS_COMMAND = "pi-prefix";
const SHORTCUT_DESCRIPTION = "Activate the pi-prefix prefix key";
// WHY: third-party shortcut collisions cannot be inventoried publicly; Pi
// resolves them by load order and reports them under Extension issues.
const THIRD_PARTY_LIMIT_NOTE =
  "Third-party extension shortcut collisions are reported by Pi under [Extension issues] and resolved by load order.";
// WHY: only extension-owned commands can execute through sendUserMessage;
// built-in interactive commands and templates need the editor-submit path.
const EXTENSION_COMMAND_SOURCE = "extension";
const DELIVER_WHILE_BUSY = "steer";
// WHY: the only way to approve a project overlay; an explicit, reviewed user
// action replaces the old implicit trust of any project file.
const ALLOW_PROJECT_SUBCOMMAND = "allow-project";
// WHY: Pi's confirm lists Yes first, so a stray Enter or type-ahead would
// approve; a select with No first makes the safe answer the default.
const APPROVE_DECLINE_OPTION = "No";
const APPROVE_ACCEPT_OPTION = "Yes, approve";
// WHY: only a person at the terminal may consent; RPC clients could answer
// the dialog automatically, and print modes have no one to ask.
const INTERACTIVE_MODE = "tui";
// WHY: JSON escaping leaves format (bidi, zero-width), C1 and line-separator
// characters raw; those are escaped too so nothing in the dialog is hidden.
const HIDDEN_TEXT_PATTERN = /[\p{Cf}\u0080-\u009f\u2028\u2029]/gu;
const UNREGISTERED_COMMAND_NOTE = "not a registered extension command; will be refused";
const PROJECT_IDLE_STATUS = `prefix ${PROJECT_STATUS_MARKER}`;
const JSON_INDENT = 2;
const TEXT_ENCODING = "utf8";
// WHY: write-then-rename keeps the user's global config whole if Pi exits
// mid-write; a random name opened exclusively cannot be pre-created or
// symlinked by someone else.
const TEMP_SUFFIX = ".tmp";
const TEMP_RANDOM_BYTES = 8;
const TEMP_RANDOM_ENCODING = "hex";
const EXCLUSIVE_CREATE_FLAG = "wx";
// WHY: the global config is the trust anchor; a new file is private, and an
// existing file keeps the permissions its owner chose.
const NEW_CONFIG_MODE = 0o600;
const PERMISSION_BITS = 0o777;

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
      const origin = state.result.config?.projectKeys.has(key) ? ` ${PROJECT_STATUS_MARKER}` : "";
      return `${key} -> ${description}${origin}`;
    })
    .join(", ");
}

function statusMessage(
  state: SessionState | undefined,
  agentDir: string,
  inactiveResult: LoadConfigResult | undefined,
): string {
  if (state === undefined || state.result.config === undefined) {
    const lines = [
      "pi-prefix: inactive",
      `global config: ${agentDir}/pi-prefix.json`,
      "No effective prefix and bindings. See the package README for configuration.",
    ];
    // WHY: startup notices scroll away; the status command is where users
    // look later to learn why the extension is off.
    if (inactiveResult !== undefined) {
      for (const error of formatDiagnostics(inactiveResult, "error")) {
        lines.push(`error: ${error}`);
      }
      for (const warning of formatDiagnostics(inactiveResult, "warning")) {
        lines.push(`warning: ${warning}`);
      }
    }
    return lines.join(" | ");
  }
  const { config } = state.result;
  const lines = [
    state.conflicts.length > 0 ? "pi-prefix: disabled (conflicts)" : "pi-prefix: active",
    `prefix: ${config.prefix}`,
    `timeout: ${config.timeoutMs}ms`,
    `bindings: ${bindingSummary(state)}`,
    `project trusted: ${state.projectTrusted ? "yes" : "no"}`,
    `global: ${state.result.globalPath}`,
    `project: ${state.result.projectPath} (${state.result.projectState})`,
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

/**
 * Replace the global config atomically. WHY: approvals live in this file, so
 * a crash must not truncate it and a rewrite must not widen its permissions.
 */
function writeGlobalConfig(globalPath: string, text: string): void {
  let mode = NEW_CONFIG_MODE;
  try {
    mode = statSync(globalPath).mode & PERMISSION_BITS;
  } catch {
    // WHY: a missing file is the first approval; keep the private default.
  }
  const tempPath = `${globalPath}.${randomBytes(TEMP_RANDOM_BYTES).toString(TEMP_RANDOM_ENCODING)}${TEMP_SUFFIX}`;
  const fd = openSync(tempPath, EXCLUSIVE_CREATE_FLAG, mode);
  try {
    writeSync(fd, text);
    // WHY: the create mode is reduced by the umask; set it explicitly.
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tempPath);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tempPath, globalPath);
  } catch (error) {
    unlinkSync(tempPath);
    throw error;
  }
}

// WHY: injected so the dialog can name each command's owning extension
// without this module depending on the host command registry.
type CommandLookup = (name: string) => { description?: string; path?: string } | undefined;

/**
 * Render a value for the approval dialog. WHY: JSON string escaping turns
 * control, bidi and zero-width characters into visible escapes, so text from
 * a repository cannot disguise itself in the one place consent is given.
 */
function visible(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(HIDDEN_TEXT_PATTERN, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

/**
 * One line per binding with the command's owning extension. WHY: users judge
 * what a key will do, not raw JSON; showing the resolved owner reveals keys
 * that point at an unexpected extension.
 */
function describeOverlay(bindings: ReadonlyMap<string, unknown>, lookup: CommandLookup): string[] {
  const lines: string[] = [];
  for (const [key, target] of bindings) {
    if (target === null || typeof target !== "object" || !("command" in target)) continue;
    const command = String((target as { command: string }).command);
    const info = lookup(commandName(command));
    const parts = [info?.path, info?.description].filter((part): part is string => part !== undefined && part !== "");
    const detail = info === undefined ? UNREGISTERED_COMMAND_NOTE : parts.map(visible).join(" - ");
    lines.push(`${visible(key)} -> ${visible(command)}${detail.length > 0 ? `  (${detail})` : ""}`);
  }
  return lines;
}

/**
 * Record approval of the current project's overlay in the global config.
 * WHY: consent must be a deliberate user step that pins the exact bytes the
 * user reviewed; the overlay is re-read once so what is shown is what is pinned.
 */
async function allowProject(
  ctx: ExtensionContext,
  globalPath: string,
  projectPath: string,
  lookup: CommandLookup,
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== INTERACTIVE_MODE) {
    ctx.ui.notify("pi-prefix: project overlays can only be approved in the interactive terminal UI", "error");
    return;
  }
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("pi-prefix: trust this project in Pi before approving its overlay", "error");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(projectPath);
  } catch {
    ctx.ui.notify(`pi-prefix: no project overlay at ${projectPath}`, "error");
    return;
  }
  const raw = bytes.toString(TEXT_ENCODING);
  let globalConfig: Record<string, unknown> = {};
  try {
    globalConfig = JSON.parse(readFileSync(globalPath, TEXT_ENCODING)) as Record<string, unknown>;
  } catch (error) {
    // WHY: never overwrite a global config we could not parse.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.ui.notify(`pi-prefix: cannot update ${globalPath}: ${(error as Error).message}`, "error");
      return;
    }
  }
  const userResult = loadConfig({ agentDir: dirname(globalPath), cwd: ctx.cwd, projectTrusted: false });
  const parsed = parseProjectOverlay(raw, projectPath, userResult.config?.bindings);
  if (parsed.layer === undefined) {
    ctx.ui.notify(`pi-prefix: overlay not approvable: ${parsed.problems.join("; ")}`, "error");
    return;
  }
  const approval: ProjectOverlayApproval = { path: canonicalProjectPath(ctx.cwd), sha256: hashOverlay(bytes) };
  const choice = await ctx.ui.select(
    [
      "Approve pi-prefix project overlay?",
      `project: ${visible(approval.path)}`,
      `sha256: ${approval.sha256}`,
      "",
      ...describeOverlay(parsed.layer.bindings ?? new Map(), lookup),
    ].join("\n"),
    [APPROVE_DECLINE_OPTION, APPROVE_ACCEPT_OPTION],
  );
  if (choice !== APPROVE_ACCEPT_OPTION) {
    ctx.ui.notify("pi-prefix: project overlay not approved", "info");
    return;
  }
  const overlays = (globalConfig.projectOverlays as { allow?: ProjectOverlayApproval[] } | undefined) ?? {};
  const allow = (overlays.allow ?? []).filter((entry) => entry.path !== approval.path);
  globalConfig.projectOverlays = { ...overlays, allow: [...allow, approval] };
  try {
    writeGlobalConfig(globalPath, `${JSON.stringify(globalConfig, null, JSON_INDENT)}\n`);
  } catch (error) {
    ctx.ui.notify(`pi-prefix: cannot update ${globalPath}: ${(error as Error).message}`, "error");
    return;
  }
  ctx.ui.notify(`pi-prefix: project overlay approved for ${approval.path}; run /reload to apply`, "info");
}

export function setupPiPrefix(
  pi: ExtensionAPI,
  options: { agentDir: string },
): void {
  let state: SessionState | undefined;
  // WHY: an inactive session has no SessionState, but its load diagnostics
  // must stay reachable from the status command.
  let inactiveResult: LoadConfigResult | undefined;

  pi.registerCommand(STATUS_COMMAND, {
    description: `Show pi-prefix status; "${ALLOW_PROJECT_SUBCOMMAND}" approves this project's overlay`,
    handler: async (args: string, ctx: ExtensionContext) => {
      if (args.trim() === ALLOW_PROJECT_SUBCOMMAND) {
        const paths = loadConfig({ agentDir: options.agentDir, cwd: ctx.cwd, projectTrusted: false });
        await allowProject(ctx, paths.globalPath, paths.projectPath, (name) => {
          const command = pi.getCommands().find(
            (available) => available.name === name && available.source === EXTENSION_COMMAND_SOURCE,
          );
          return command === undefined
            ? undefined
            : { description: command.description, path: command.sourceInfo?.path };
        });
        return;
      }
      ctx.ui.notify(statusMessage(state, options.agentDir, inactiveResult), "info");
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
      inactiveResult = result;
      return;
    }
    inactiveResult = undefined;
    const overlayActive = result.config.projectKeys.size > 0;
    if (overlayActive) {
      // WHY: repository-defined keys must be visible when they go live.
      const keys = [...result.config.projectKeys].join(", ");
      ctx.ui.notify(`pi-prefix: project overlay active (${result.projectPath}): ${keys}`, "info");
      ctx.ui.setStatus(STATUS_KEY, PROJECT_IDLE_STATUS);
    }
    state = {
      result,
      projectTrusted: ctx.isProjectTrusted(),
      wrapper: undefined,
      conflicts: [],
      shortcutRegistered: false,
    };
    const sessionState: SessionState = state;
    const isExtensionCommand = (command: string): boolean => {
      const name = commandName(command);
      return pi.getCommands().some(
        (available) => available.name === name && available.source === EXTENSION_COMMAND_SOURCE,
      );
    };
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
          isExtensionCommand,
          idleStatus: overlayActive ? PROJECT_IDLE_STATUS : undefined,
          dispatchExtensionCommand: (command) => {
            if (!isExtensionCommand(command)) return false;
            // WHY: newer Pi hosts treat a starting run as busy and reject
            // sendUserMessage without deliverAs; steer matches what Enter does
            // for typed input while the agent is working.
            pi.sendUserMessage(command, { expandPromptTemplates: true, deliverAs: DELIVER_WHILE_BUSY });
            return true;
          },
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
    inactiveResult = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export default function (pi: ExtensionAPI): void {
  setupPiPrefix(pi, { agentDir: getAgentDir() });
}
