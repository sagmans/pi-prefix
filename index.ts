import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  canonicalProjectPath,
  commandName,
  hashOverlay,
  loadConfig,
  parseProjectOverlay,
  readOverlayFile,
  readUserBindings,
  visibleText,
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
const UNREGISTERED_COMMAND_NOTE = "not a registered extension command; will be refused";
const OVERLAY_NOTICE_LEVEL = "warning";
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
const DIRECTORY_OPEN_FLAG = "r";

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
function writeGlobalConfig(targetPath: string, text: string): void {
  let mode = NEW_CONFIG_MODE;
  try {
    mode = statSync(targetPath).mode & PERMISSION_BITS;
  } catch {
    // WHY: a missing file is the first approval; keep the private default.
  }
  const directory = dirname(targetPath);
  const tempPath = join(
    directory,
    `${basename(targetPath)}.${randomBytes(TEMP_RANDOM_BYTES).toString(TEMP_RANDOM_ENCODING)}${TEMP_SUFFIX}`,
  );
  let renamed = false;
  try {
    const fd = openSync(tempPath, EXCLUSIVE_CREATE_FLAG, mode);
    try {
      // WHY: one writeSync may write only part of the text; this loops until done.
      writeFileSync(fd, text);
      // WHY: the create mode is reduced by the umask; set it explicitly.
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, targetPath);
    renamed = true;
    // WHY: the rename is durable only once the directory entry is flushed.
    // Best-effort: the approval is already saved, and some filesystems
    // (Windows, FUSE, network mounts) cannot open or fsync a directory, so a
    // failure here must not report the approval as lost.
    try {
      const dirFd = openSync(directory, DIRECTORY_OPEN_FLAG);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // WHY: durability of the directory entry is a bonus, not a requirement.
    }
  } finally {
    if (!renamed) rmSync(tempPath, { force: true });
  }
}

// WHY: injected so the dialog can name each command's owning extension
// without this module depending on the host command registry.
type CommandLookup = (name: string) => { description?: string; path?: string } | undefined;

/**
 * One line per binding with the command's owning extension. WHY: users judge
 * what a key will do, not raw JSON; showing the resolved owner reveals keys
 * that point at an unexpected extension.
 */
function formatProjectBindings(bindings: ReadonlyMap<string, unknown>, lookup?: CommandLookup): string[] {
  const lines: string[] = [];
  for (const [key, target] of bindings) {
    if (target === null || typeof target !== "object" || !("command" in target)) continue;
    const command = String((target as { command: string }).command);
    // WHY: without a lookup (startup notice) only key and command are shown.
    const info = lookup?.(commandName(command));
    const parts = [info?.path, info?.description].filter((part): part is string => part !== undefined && part !== "");
    const detail = lookup === undefined ? "" : info === undefined ? UNREGISTERED_COMMAND_NOTE : parts.map(visibleText).join(" - ");
    lines.push(`${visibleText(key)} -> ${visibleText(command)}${detail.length > 0 ? `  (${detail})` : ""}`);
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
  const read = readOverlayFile(projectPath);
  if (read.kind !== "bytes") {
    ctx.ui.notify(
      read.kind === "absent"
        ? `pi-prefix: no project overlay at ${projectPath}`
        : `pi-prefix: project overlay not approvable: ${read.reason}`,
      "error",
    );
    return;
  }
  const bytes = read.bytes;
  // WHY realpath: a dotfiles-managed config is often a symlink; writing to
  // its target keeps the link instead of replacing it with a plain file.
  const targetPath = resolveGlobalTarget(globalPath);
  const before = readGlobalText(targetPath);
  if (before.error !== undefined) {
    ctx.ui.notify(`pi-prefix: cannot update ${globalPath}: ${before.error}`, "error");
    return;
  }
  const globalConfig = approvableGlobalConfig(before.text);
  if (typeof globalConfig === "string") {
    ctx.ui.notify(`pi-prefix: cannot update ${globalPath}: ${globalConfig}`, "error");
    return;
  }
  // WHY: the loader checks overlays against the user's raw global bindings,
  // including keys removed with null; approval must use the same set.
  const user = readUserBindings(dirname(globalPath));
  if (user.errors.length > 0) {
    ctx.ui.notify(`pi-prefix: fix ${globalPath} before approving: ${user.errors.join("; ")}`, "error");
    return;
  }
  const parsed = parseProjectOverlay(bytes.toString(TEXT_ENCODING), projectPath, user.bindings);
  if (parsed.layer === undefined) {
    ctx.ui.notify(`pi-prefix: overlay not approvable: ${parsed.problems.join("; ")}`, "error");
    return;
  }
  const approval: ProjectOverlayApproval = { path: canonicalProjectPath(ctx.cwd), sha256: hashOverlay(bytes) };
  const choice = await ctx.ui.select(
    [
      "Approve pi-prefix project overlay?",
      `project: ${visibleText(approval.path)}`,
      `sha256: ${approval.sha256}`,
      "",
      ...formatProjectBindings(parsed.layer.bindings ?? new Map(), lookup),
    ].join("\n"),
    [APPROVE_DECLINE_OPTION, APPROVE_ACCEPT_OPTION],
  );
  if (choice !== APPROVE_ACCEPT_OPTION) {
    ctx.ui.notify("pi-prefix: project overlay not approved", "info");
    return;
  }
  // WHY: the dialog can stay open indefinitely; if either file changed in
  // the meantime, what the user saw is no longer what would be written.
  const overlayNow = readOverlayFile(projectPath);
  if (overlayNow.kind !== "bytes" || hashOverlay(overlayNow.bytes) !== approval.sha256) {
    ctx.ui.notify("pi-prefix: project overlay changed during review; run /pi-prefix allow-project again", "error");
    return;
  }
  if (readGlobalText(targetPath).text !== before.text) {
    ctx.ui.notify(`pi-prefix: ${globalPath} changed during review; run /pi-prefix allow-project again`, "error");
    return;
  }
  const overlays = (globalConfig.projectOverlays as { allow?: ProjectOverlayApproval[] } | undefined) ?? {};
  const allow = (overlays.allow ?? []).filter((entry) => entry.path !== approval.path);
  globalConfig.projectOverlays = { ...overlays, allow: [...allow, approval] };
  try {
    writeGlobalConfig(targetPath, `${JSON.stringify(globalConfig, null, JSON_INDENT)}\n`);
  } catch (error) {
    ctx.ui.notify(`pi-prefix: cannot update ${globalPath}: ${(error as Error).message}`, "error");
    return;
  }
  ctx.ui.notify(`pi-prefix: project overlay approved for ${approval.path}; run /reload to apply`, "info");
}

/** Resolve the file a write must replace. WHY: see allowProject. */
function resolveGlobalTarget(globalPath: string): string {
  try {
    return realpathSync(globalPath);
  } catch {
    // WHY: a missing file is the first approval; write at the given path.
    return globalPath;
  }
}

/** Read the global config text; a missing file reads as empty. */
function readGlobalText(path: string): { text?: string; error?: string } {
  try {
    return { text: readFileSync(path, TEXT_ENCODING) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { text: undefined }
      : { error: (error as Error).message };
  }
}

/**
 * Parse the global config for an approval write, or explain why not.
 * WHY: rewriting a file whose shape we do not understand could drop the
 * user's settings or approvals, so only the expected shape is updated.
 */
function approvableGlobalConfig(text: string | undefined): Record<string, unknown> | string {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return (error as Error).message;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "configuration must be a JSON object";
  }
  const record = parsed as Record<string, unknown>;
  const overlays = record.projectOverlays;
  if (overlays !== undefined) {
    if (typeof overlays !== "object" || overlays === null || Array.isArray(overlays)) {
      return "projectOverlays must be an object";
    }
    const allow = (overlays as Record<string, unknown>).allow;
    if (allow !== undefined && !Array.isArray(allow)) return "projectOverlays.allow must be an array";
  }
  return record;
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
    // WHY: shown only once the prefix is known to be usable; a conflict
    // disables pi-prefix, and an "active" notice next to it would mislead.
    let overlayNotice: string | undefined;
    if (overlayActive) {
      // WHY: repository-defined keys must be visible when they go live, with
      // what each one runs, not just which keys exist.
      const projectBindings = formatProjectBindings(
        new Map([...result.config.projectKeys].map((key) => [key, result.config?.bindings.get(key)])),
      );
      overlayNotice = `pi-prefix: project overlay active (${visibleText(result.projectPath)}): ${projectBindings.join(", ")}`;
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
          if (overlayNotice !== undefined) {
            // WHY warning: Pi shows info notices in one status line that the
            // next status (such as /reload's "Reloaded ...") overwrites in
            // place, which hid this notice after a reload.
            ctx.ui.notify(overlayNotice, OVERLAY_NOTICE_LEVEL);
            ctx.ui.setStatus(STATUS_KEY, PROJECT_IDLE_STATUS);
          }
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
