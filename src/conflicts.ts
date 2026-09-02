import type { KeyId, KeybindingsManager } from "@earendil-works/pi-tui";
import { normalizeKeyId } from "./config.ts";

export type PrefixConflict = {
  key: KeyId;
  keybinding: string;
};

// WHY: only these app actions are wired into Pi's main editor; picker- and
// dialog-only actions (tui.select.*, app.tree.*, app.models.*) never fire
// while the editor has focus, so they are not conflicts.
const MAIN_EDITOR_APP_ACTIONS = [
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.copy",
  "app.message.followUp",
  "app.message.dequeue",
  "app.clipboard.pasteImage",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
] as const;

const MAIN_EDITOR_PREFIXES = ["tui.editor.", "tui.input."];
const MAIN_EDITOR_IDS = new Set<string>(MAIN_EDITOR_APP_ACTIONS);

function isMainEditorBinding(id: string): boolean {
  return (
    MAIN_EDITOR_IDS.has(id) ||
    MAIN_EDITOR_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}

export function findPrefixConflicts(
  prefix: KeyId,
  keybindings: KeybindingsManager,
): PrefixConflict[] {
  const normalizedPrefix = normalizeKeyId(prefix);
  if (normalizedPrefix === undefined) {
    return [];
  }
  const conflicts: PrefixConflict[] = [];
  for (const [id, keys] of Object.entries(keybindings.getResolvedBindings())) {
    if (!isMainEditorBinding(id)) {
      continue;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const rawKey of keyList) {
      if (rawKey === undefined) {
        continue;
      }
      const normalized = normalizeKeyId(rawKey);
      if (normalized === normalizedPrefix) {
        conflicts.push({ key: normalized, keybinding: id });
      }
    }
  }
  // WHY: stable output keeps /pi-prefix diagnostics and tests deterministic.
  conflicts.sort((a, b) => a.keybinding.localeCompare(b.keybinding));
  return conflicts;
}
