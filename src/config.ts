import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
// WHY: rebranded Pi distributions may rename the project config directory;
// the exported constant is the only rebrand-safe source.
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type PrefixTarget =
  | { action: string }
  | { command: string; submit: boolean }
  | { event: string; payload?: unknown };

export type ProjectOverlayApproval = {
  path: string;
  sha256: string;
};

export type PrefixConfigLayer = {
  $schema?: string;
  prefix?: string;
  timeoutMs?: number;
  bindings?: Record<string, PrefixTarget | null>;
  // WHY: consent for project overlays must live in a file the project cannot
  // write, so this key is accepted only in the global layer.
  projectOverlays?: { allow: ProjectOverlayApproval[] };
};

export type EffectivePrefixConfig = {
  prefix: KeyId;
  timeoutMs: number;
  bindings: ReadonlyMap<KeyId, PrefixTarget>;
  // WHY: dispatch applies stricter rules to keys that came from a project
  // overlay, so their origin must survive the merge.
  projectKeys: ReadonlySet<KeyId>;
};

export type ConfigDiagnostic = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type LoadConfigOptions = {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
};

/**
 * Why the project overlay was or was not applied; drives the load-time notice
 * and the status command so users can see which opt-in step is missing.
 */
export type ProjectOverlayState =
  | "absent"
  | "untrusted"
  | "not-allowed"
  | "changed"
  | "rejected"
  | "loaded";

export type LoadConfigResult = {
  config?: EffectivePrefixConfig;
  diagnostics: ConfigDiagnostic[];
  globalPath: string;
  projectPath: string;
  projectLoaded: boolean;
  projectState: ProjectOverlayState;
};

// WHY: pi-tui defines modifier order as ctrl, shift, alt, super; canonical
// ordering keeps equivalent spellings from becoming distinct map entries.
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;

const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);

// WHY: pi-tui accepts legacy aliases; canonicalizing them makes conflict
// comparison and binding lookup unambiguous.
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
};

const SPECIAL_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const SYMBOL_KEYS = new Set(
  "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
);

const LAYER_TOP_LEVEL_KEYS = new Set(["$schema", "prefix", "timeoutMs", "bindings", "projectOverlays"]);
const PROJECT_OVERLAYS_KEY = "projectOverlays";
const PROJECT_OVERLAY_ALLOW_KEY = "allow";
const APPROVAL_KEYS = new Set(["path", "sha256"]);
// WHY: the approval pins exact overlay bytes; a lowercase hex digest is the
// one canonical spelling so comparison is a plain string match.
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HASH_ALGORITHM = "sha256";
const HASH_ENCODING = "hex";
// WHY: these built-ins upload, export, re-authenticate, change trust, or end
// the session; a repository must never reach them through a single keypress.
export const PROJECT_BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  "share",
  "export",
  "login",
  "trust",
  "quit",
]);
// WHY: a repository chooses project binding text, so it must be exactly one
// plain command name: no arguments (their meaning depends on each extension),
// no case or slash variants, and nothing that only the keypress check refuses.
const PROJECT_COMMAND_PATTERN = /^\/[a-z0-9][a-z0-9:_-]*$/;
// WHY: control, format (bidi, zero-width) and line-separator characters can
// make a command look different in the approval dialog than what runs.
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// WHY: an approved overlay must never reach pi-prefix's own command, which
// can approve overlays.
const SELF_COMMAND_NAME = "pi-prefix";
// WHY: a project overlay may only add keys and only bind slash commands; the
// host later checks that the command is a registered extension command.
const PROJECT_FORBIDDEN_SCALARS = ["prefix", "timeoutMs"] as const;
const COMMAND_PREFIX = "/";
const COMMAND_NAME_SEPARATOR = " ";
const TARGET_KEYS = ["action", "command", "event"] as const;
// WHY: submit belongs to command targets and payload to event targets; both
// must pass the unknown-property guard before kind-specific validation.
const TARGET_PROPERTIES = [...TARGET_KEYS, "submit", "payload"] as const;
const ESCAPE_KEY = "escape";
const DEFAULT_TIMEOUT_MS = 2000;
const CONFIG_FILE_NAME = "pi-prefix.json";

const DEFAULTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "defaults.json",
);

function isLetter(value: string): boolean {
  return value.length === 1 && value >= "a" && value <= "z";
}

function isDigit(value: string): boolean {
  return value.length === 1 && value >= "0" && value <= "9";
}

function isUpperLetter(value: string): boolean {
  return value.length === 1 && value >= "A" && value <= "Z";
}

export function normalizeKeyId(value: string): KeyId | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value === "+") {
    // WHY: "+" is a valid symbol key whose spelling collides with the
    // modifier separator; handle it before splitting.
    return "+" as KeyId;
  }
  const parts = value.split("+");
  // WHY: empty segments mean malformed ids like "ctrl++x".
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const rawKey = parts[parts.length - 1];
  const rawModifiers = parts.slice(0, -1);
  if (rawModifiers.some((modifier) => !MODIFIER_SET.has(modifier))) {
    return undefined;
  }
  const modifierSet = new Set(rawModifiers);
  // WHY: duplicate modifiers like "ctrl+ctrl+x" must not silently collapse.
  if (modifierSet.size !== rawModifiers.length) {
    return undefined;
  }
  let key: string | undefined;
  if (isUpperLetter(rawKey)) {
    key = rawKey.toLowerCase();
    modifierSet.add("shift");
  } else if (isLetter(rawKey) || isDigit(rawKey)) {
    key = rawKey;
  } else if (Object.hasOwn(KEY_ALIASES, rawKey)) {
    // WHY: an own-property check keeps inherited names such as "__proto__"
    // or "constructor" from resolving to Object internals, which would reach
    // pi-tui's key matcher as a non-string and break editor input.
    key = KEY_ALIASES[rawKey];
  } else if (SPECIAL_KEYS.has(rawKey)) {
    key = rawKey;
  } else if (SYMBOL_KEYS.has(rawKey)) {
    key = rawKey;
  }
  if (key === undefined) {
    return undefined;
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
  return (ordered.length > 0 ? `${ordered.join("+")}+${key}` : key) as KeyId;
}

type ParsedTarget = PrefixTarget | null;

function validateTarget(
  value: unknown,
  keyLabel: string,
  path: string,
  diagnostics: ConfigDiagnostic[],
): ParsedTarget | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" must be an object or null` });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const property of Object.keys(record)) {
    if (!(TARGET_PROPERTIES as readonly string[]).includes(property)) {
      diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" has unknown property "${property}"` });
      return undefined;
    }
  }
  const present = TARGET_KEYS.filter((kind) => record[kind] !== undefined);
  if (present.length !== 1) {
    diagnostics.push({
      level: "error",
      path,
      message: `binding "${keyLabel}" must contain exactly one of action, command, or event`,
    });
    return undefined;
  }
  const kind = present[0];
  if (record.payload !== undefined && kind !== "event") {
    // WHY: payload is only meaningful for event targets; elsewhere it hides
    // configuration mistakes.
    diagnostics.push({
      level: "error",
      path,
      message: `binding "${keyLabel}" payload is only allowed with event targets`,
    });
    return undefined;
  }
  if (kind === "action") {
    if (typeof record.action !== "string" || record.action.length === 0) {
      diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" action must be a non-empty string` });
      return undefined;
    }
    return { action: record.action };
  }
  if (kind === "command") {
    if (typeof record.command !== "string" || !record.command.startsWith("/")) {
      diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" command must start with "/"` });
      return undefined;
    }
    if (typeof record.submit !== "boolean") {
      diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" submit must be a boolean` });
      return undefined;
    }
    return { command: record.command, submit: record.submit };
  }
  if (typeof record.event !== "string" || record.event.length === 0) {
    diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" event must be a non-empty string` });
    return undefined;
  }
  if (record.payload !== undefined && typeof record.payload !== "object") {
    diagnostics.push({ level: "error", path, message: `binding "${keyLabel}" payload must be an object` });
    return undefined;
  }
  return record.payload !== undefined
    ? { event: record.event, payload: record.payload }
    : { event: record.event };
}

type ParsedLayer = {
  prefix?: KeyId;
  timeoutMs?: number;
  bindings?: Map<KeyId, PrefixTarget | null>;
  approvals?: ProjectOverlayApproval[];
};

/** Extract the command name so policy checks ignore any arguments. */
export function commandName(command: string): string {
  const withoutPrefix = command.startsWith(COMMAND_PREFIX) ? command.slice(COMMAND_PREFIX.length) : command;
  const separatorIndex = withoutPrefix.indexOf(COMMAND_NAME_SEPARATOR);
  return separatorIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, separatorIndex);
}

/**
 * Why a project binding's command text is not allowed, or undefined when it
 * is. WHY: load-time approval and keypress dispatch share this one rule so an
 * overlay the user approves never contains content refused later.
 */
export function projectCommandProblem(command: string): string | undefined {
  if (UNSAFE_TEXT_PATTERN.test(command)) {
    return "contains control, bidi, or zero-width characters";
  }
  if (!PROJECT_COMMAND_PATTERN.test(command)) {
    return `must be exactly "/name" (lowercase letters, digits, ":", "_", "-"; no arguments)`;
  }
  const name = commandName(command).toLowerCase();
  if (name === SELF_COMMAND_NAME || PROJECT_BLOCKED_COMMANDS.has(name)) {
    return "is a blocked command";
  }
  return undefined;
}

/** Hash overlay bytes exactly as read, so any edit invalidates an approval. */
export function hashOverlay(raw: string): string {
  return createHash(HASH_ALGORITHM).update(raw).digest(HASH_ENCODING);
}

function parseApprovals(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
): ProjectOverlayApproval[] | undefined {
  const record = value as Record<string, unknown> | null;
  if (
    typeof value !== "object" || record === null || Array.isArray(value) ||
    Object.keys(record).some((key) => key !== PROJECT_OVERLAY_ALLOW_KEY) ||
    !Array.isArray(record[PROJECT_OVERLAY_ALLOW_KEY])
  ) {
    diagnostics.push({ level: "error", path, message: `${PROJECT_OVERLAYS_KEY} must be { "allow": [...] }` });
    return undefined;
  }
  const approvals: ProjectOverlayApproval[] = [];
  for (const entry of record[PROJECT_OVERLAY_ALLOW_KEY] as unknown[]) {
    const item = entry as Record<string, unknown> | null;
    // WHY: relative paths or globs would let one approval cover directories
    // the user never inspected.
    if (
      typeof entry !== "object" || item === null || Array.isArray(entry) ||
      Object.keys(item).some((key) => !APPROVAL_KEYS.has(key)) ||
      typeof item.path !== "string" || !isAbsolute(item.path) ||
      typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)
    ) {
      diagnostics.push({
        level: "error",
        path,
        message: `${PROJECT_OVERLAYS_KEY}.allow entries need an absolute "path" and a lowercase hex "sha256"`,
      });
      return undefined;
    }
    approvals.push({ path: item.path, sha256: item.sha256 });
  }
  return approvals;
}

function parseLayer(
  raw: string,
  path: string,
  isDefaults: boolean,
  diagnostics: ConfigDiagnostic[],
): ParsedLayer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    diagnostics.push({ level: "error", path, message: `invalid JSON: ${(error as Error).message}` });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.push({ level: "error", path, message: "configuration must be a JSON object" });
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const property of Object.keys(record)) {
    if (!LAYER_TOP_LEVEL_KEYS.has(property)) {
      diagnostics.push({ level: "error", path, message: `unknown property "${property}"` });
      return undefined;
    }
  }
  const layer: ParsedLayer = {};
  if (record[PROJECT_OVERLAYS_KEY] !== undefined) {
    if (isDefaults) {
      diagnostics.push({ level: "error", path, message: `defaults must not ship ${PROJECT_OVERLAYS_KEY}` });
      return undefined;
    }
    const approvals = parseApprovals(record[PROJECT_OVERLAYS_KEY], path, diagnostics);
    if (approvals === undefined) return undefined;
    layer.approvals = approvals;
  }
  if (record.prefix !== undefined) {
    const normalized = normalizeKeyId(record.prefix as string);
    if (normalized === undefined) {
      diagnostics.push({ level: "error", path, message: `prefix "${String(record.prefix)}" is not a valid key id` });
      return undefined;
    }
    layer.prefix = normalized;
  }
  if (record.timeoutMs !== undefined) {
    const timeout = record.timeoutMs;
    // WHY: any positive integer is accepted by design; the guard only rejects
    // values a timer cannot schedule meaningfully.
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      diagnostics.push({ level: "error", path, message: `timeoutMs must be a positive integer, got ${String(timeout)}` });
      return undefined;
    }
    layer.timeoutMs = timeout;
  }
  if (record.bindings !== undefined) {
    if (typeof record.bindings !== "object" || record.bindings === null || Array.isArray(record.bindings)) {
      diagnostics.push({ level: "error", path, message: "bindings must be an object" });
      return undefined;
    }
    const bindings = new Map<KeyId, PrefixTarget | null>();
    for (const [rawKey, rawTarget] of Object.entries(record.bindings)) {
      const normalizedKey = normalizeKeyId(rawKey);
      if (normalizedKey === undefined) {
        diagnostics.push({ level: "error", path, message: `binding key "${rawKey}" is not a valid key id` });
        return undefined;
      }
      if (normalizedKey === ESCAPE_KEY) {
        // WHY: escape is reserved for canceling prefix mode; warn instead of
        // failing so a single bad binding never disables the whole map.
        diagnostics.push({
          level: "warning",
          path,
          message: 'binding "escape" can never dispatch; escape cancels prefix mode',
        });
      }
      const target = validateTarget(rawTarget, rawKey, path, diagnostics);
      if (target === undefined) {
        return undefined;
      }
      bindings.set(normalizedKey, target);
    }
    layer.bindings = bindings;
  }
  if (isDefaults && (layer.prefix !== undefined || layer.bindings !== undefined)) {
    // WHY: shipped defaults must stay neutral; a packaged default keymap would
    // surprise users on first install.
    diagnostics.push({ level: "error", path, message: "defaults must not ship a prefix or bindings" });
    return undefined;
  }
  return layer;
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // WHY: absence is ordinary; only malformed content is a diagnostic.
    return undefined;
  }
}

function readLayer(
  path: string,
  isDefaults: boolean,
  diagnostics: ConfigDiagnostic[],
): ParsedLayer | undefined {
  const raw = readRaw(path);
  return raw === undefined ? undefined : parseLayer(raw, path, isDefaults, diagnostics);
}

/**
 * Canonical project identity for approvals. WHY: symlinked or relative
 * spellings of one directory must map to a single allowlist entry.
 */
export function canonicalProjectPath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Parse an overlay and enforce the project-layer limits. WHY: a repository is
 * less trusted than the user, so it may only add command bindings; changing
 * the prefix, timeout, or the user's own bindings stays a user decision.
 * Problems are returned, never thrown, so callers can report every reason.
 */
export function parseProjectOverlay(
  raw: string,
  path: string,
  userBindings: ReadonlyMap<KeyId, PrefixTarget | null> | undefined,
): { layer?: ParsedLayer; problems: string[] } {
  const parseDiagnostics: ConfigDiagnostic[] = [];
  const layer = parseLayer(raw, path, false, parseDiagnostics);
  const problems = parseDiagnostics.filter((d) => d.level === "error").map((d) => d.message);
  if (layer === undefined) return { problems };
  if (layer.approvals !== undefined) {
    problems.push(`${PROJECT_OVERLAYS_KEY} is only allowed in the global config`);
  }
  for (const scalar of PROJECT_FORBIDDEN_SCALARS) {
    if (layer[scalar] !== undefined) problems.push(`"${scalar}" can only be set in the global config`);
  }
  for (const [key, target] of layer.bindings ?? []) {
    if (target === null) {
      problems.push(`binding "${key}" cannot remove a user binding`);
    } else if (userBindings?.has(key)) {
      problems.push(`binding "${key}" cannot replace a user binding`);
    } else if (!("command" in target)) {
      problems.push(`binding "${key}" must be a command`);
    } else {
      const problem = projectCommandProblem(target.command);
      // WHY: JSON.stringify escapes hidden characters so the reason shown to
      // the user cannot itself be disguised.
      if (problem !== undefined) problems.push(`binding "${key}" command ${JSON.stringify(target.command)} ${problem}`);
    }
  }
  return problems.length > 0 ? { problems } : { layer, problems };
}

export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const globalPath = join(options.agentDir, CONFIG_FILE_NAME);
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

  const defaultsLayer = readLayer(DEFAULTS_PATH, true, diagnostics);
  const globalLayer = readLayer(globalPath, false, diagnostics);
  let projectLayer: ParsedLayer | undefined;
  let projectState: ProjectOverlayState = "absent";
  const projectRaw = readRaw(projectPath);
  if (projectRaw !== undefined) {
    // WHY: Pi trust alone is vacuously true for some projects, so it is a
    // necessary gate but never consent; consent is the pinned global entry.
    const realPath = canonicalProjectPath(options.cwd);
    const approval = globalLayer?.approvals?.find((entry) => entry.path === realPath);
    if (!options.projectTrusted) {
      projectState = "untrusted";
    } else if (approval === undefined) {
      projectState = "not-allowed";
      diagnostics.push({
        level: "warning",
        path: projectPath,
        message: "project overlay ignored: not approved; run /pi-prefix allow-project to review and approve it",
      });
    } else if (approval.sha256 !== hashOverlay(projectRaw)) {
      projectState = "changed";
      diagnostics.push({
        level: "warning",
        path: projectPath,
        message: "project overlay ignored: changed since approval; run /pi-prefix allow-project to review it again",
      });
    } else {
      const parsed = parseProjectOverlay(projectRaw, projectPath, globalLayer?.bindings);
      if (parsed.layer === undefined) {
        projectState = "rejected";
        // WHY: warnings, not errors, so a bad overlay can never disable the
        // user's own working global keymap.
        for (const problem of parsed.problems) {
          diagnostics.push({ level: "warning", path: projectPath, message: `project overlay ignored: ${problem}` });
        }
      } else {
        projectLayer = parsed.layer;
        projectState = "loaded";
      }
    }
  }

  const result: LoadConfigResult = {
    diagnostics,
    globalPath,
    projectPath,
    projectLoaded: projectState === "loaded",
    projectState,
  };
  // WHY: any error in any loaded layer fails the whole effective config so a
  // partially merged map can never activate.
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return result;
  }
  const prefix = globalLayer?.prefix;
  const timeoutMs = globalLayer?.timeoutMs ?? defaultsLayer?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bindings = new Map<KeyId, PrefixTarget>();
  for (const [key, target] of globalLayer?.bindings ?? []) {
    if (target !== null) bindings.set(key, target);
  }
  const projectKeys = new Set<KeyId>();
  for (const [key, target] of projectLayer?.bindings ?? []) {
    if (target === null) continue;
    bindings.set(key, target);
    projectKeys.add(key);
  }
  if (prefix === undefined || bindings.size === 0) {
    // WHY: inert is the safe default; absence of a full map is not an error.
    return result;
  }
  result.config = { prefix, timeoutMs, bindings, projectKeys };
  return result;
}
