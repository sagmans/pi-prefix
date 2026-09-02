import { test } from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { findPrefixConflicts } from "../src/conflicts.ts";

// WHY: a minimal definition table mirrors the ids Pi wires into the main
// editor so conflict classification is testable without a live TUI.
const DEFINITIONS = {
  "tui.editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"] },
  "tui.input.submit": { defaultKeys: "enter" },
  "app.interrupt": { defaultKeys: "escape" },
  "app.model.select": { defaultKeys: "ctrl+l" },
  "app.message.copy": { defaultKeys: "ctrl+x" },
  "tui.select.up": { defaultKeys: "up" },
  "app.models.save": { defaultKeys: "ctrl+s" },
};

function makeManager(userBindings = {}): KeybindingsManager {
  return new KeybindingsManager(DEFINITIONS as never, userBindings);
}

test("editor binding collision is reported", () => {
  const conflicts = findPrefixConflicts("ctrl+b", makeManager());
  assert.deepEqual(conflicts, [
    { key: "ctrl+b", keybinding: "tui.editor.cursorLeft" },
  ]);
});

test("app binding collision is reported", () => {
  const conflicts = findPrefixConflicts("ctrl+l", makeManager());
  assert.deepEqual(conflicts, [
    { key: "ctrl+l", keybinding: "app.model.select" },
  ]);
});

test("multiple collisions are all reported in stable order", () => {
  const conflicts = findPrefixConflicts("ctrl+x", makeManager({
    "app.model.select": "ctrl+x",
  }));
  assert.deepEqual(conflicts, [
    { key: "ctrl+x", keybinding: "app.message.copy" },
    { key: "ctrl+x", keybinding: "app.model.select" },
  ]);
});

test("normalized spelling of the same key still collides", () => {
  const conflicts = findPrefixConflicts("ctrl+alt+l", makeManager({
    "app.model.select": "alt+ctrl+l",
  }));
  assert.deepEqual(conflicts, [
    { key: "ctrl+alt+l", keybinding: "app.model.select" },
  ]);
});

test("free prefix yields no conflicts", () => {
  const conflicts = findPrefixConflicts("ctrl+alt+9", makeManager());
  assert.deepEqual(conflicts, []);
});

test("picker-only bindings are not conflicts", () => {
  const conflicts = findPrefixConflicts("up", makeManager());
  assert.deepEqual(conflicts, []);
});

test("user-rebound keys replace defaults in the scan", () => {
  const conflicts = findPrefixConflicts("f9", makeManager({
    "app.model.select": "f9",
  }));
  assert.deepEqual(conflicts, [
    { key: "f9", keybinding: "app.model.select" },
  ]);
});

test("unbound action replaced with empty array is no conflict", () => {
  const conflicts = findPrefixConflicts("ctrl+l", makeManager({
    "app.model.select": [],
  }));
  assert.deepEqual(conflicts, []);
});
