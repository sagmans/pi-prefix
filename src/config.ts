import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyId } from "@earendil-works/pi-tui";

export type PrefixTarget =
  | { action: string }
  | { command: string; submit: boolean }
  | { event: string; payload?: unknown };

export type PrefixConfigLayer = {
  $schema?: string;
  prefix?: string;
  timeoutMs?: number;
  bindings?: Record<string, PrefixTarget | null>;
};

export type EffectivePrefixConfig = {
  prefix: KeyId;
  timeoutMs: number;
  bindings: ReadonlyMap<KeyId, PrefixTarget>;
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

export type LoadConfigResult = {
  config?: EffectivePrefixConfig;
  diagnostics: ConfigDiagnostic[];
  globalPath: string;
  projectPath: string;
  projectLoaded: boolean;
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

const LAYER_TOP_LEVEL_KEYS = new Set(["$schema", "prefix", "timeoutMs", "bindings"]);
const TARGET_KEYS = ["action", "command", "event"] as const;
// WHY: submit belongs to command targets and payload to event targets; both
// must pass the unknown-property guard before kind-specific validation.
const TARGET_PROPERTIES = [...TARGET_KEYS, "submit", "payload"] as const;
const ESCAPE_KEY = "escape";
const DEFAULT_TIMEOUT_MS = 2000;
const CONFIG_FILE_NAME = "pi-prefix.json";
const PROJECT_CONFIG_DIR = ".pi";
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
  } else if (KEY_ALIASES[rawKey] !== undefined) {
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
};

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

function readLayer(
  path: string,
  isDefaults: boolean,
  diagnostics: ConfigDiagnostic[],
): ParsedLayer | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // WHY: absence is ordinary; only malformed content is a diagnostic.
    return undefined;
  }
  return parseLayer(raw, path, isDefaults, diagnostics);
}

export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const globalPath = join(options.agentDir, CONFIG_FILE_NAME);
  const projectPath = join(options.cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME);

  const defaultsLayer = readLayer(DEFAULTS_PATH, true, diagnostics);
  const globalLayer = readLayer(globalPath, false, diagnostics);
  let projectLayer: ParsedLayer | undefined;
  let projectLoaded = false;
  if (options.projectTrusted) {
    projectLayer = readLayer(projectPath, false, diagnostics);
    projectLoaded = projectLayer !== undefined;
  }

  const result: LoadConfigResult = { diagnostics, globalPath, projectPath, projectLoaded };
  // WHY: any error in any loaded layer fails the whole effective config so a
  // partially merged map can never activate.
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return result;
  }
  const prefix = projectLayer?.prefix ?? globalLayer?.prefix;
  const timeoutMs =
    projectLayer?.timeoutMs ?? globalLayer?.timeoutMs ?? defaultsLayer?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bindings = new Map<KeyId, PrefixTarget>();
  const overlays = [globalLayer, projectLayer];
  for (const overlay of overlays) {
    if (overlay?.bindings === undefined) {
      continue;
    }
    for (const [key, target] of overlay.bindings) {
      if (target === null) {
        bindings.delete(key);
      } else {
        bindings.set(key, target);
      }
    }
  }
  if (prefix === undefined || bindings.size === 0) {
    // WHY: inert is the safe default; absence of a full map is not an error.
    return result;
  }
  result.config = { prefix, timeoutMs, bindings };
  return result;
}
