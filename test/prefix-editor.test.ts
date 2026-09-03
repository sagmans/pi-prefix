import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { PrefixEditor } from "../src/prefix-editor.ts";
import type { EffectivePrefixConfig, PrefixTarget } from "../src/config.ts";
import type { KeyId } from "@earendil-works/pi-tui";

const SUBMIT_KEY_INPUT = "\r";

const BASE_TARGETS: Record<string, PrefixTarget> = {
  m: { action: "app.model.select" },
  h: { command: "/hotkeys", submit: true },
  i: { command: "/model", submit: false },
  o: { event: "example:open", payload: { source: "pi-prefix" } },
};

function makeConfig(overrides: Record<string, PrefixTarget> = {}): EffectivePrefixConfig {
  const targets = { ...BASE_TARGETS, ...overrides };
  const bindings = new Map<KeyId, PrefixTarget>(
    Object.entries(targets) as [KeyId, PrefixTarget][],
  );
  return { prefix: "ctrl+x", timeoutMs: 2000, bindings };
}

type InnerCalls = {
  input: string[];
  texts: string[];
  renders: number[];
};

function makeInner() {
  const calls: InnerCalls = { input: [], texts: [], renders: [] };
  const inner = {
    actionHandlers: new Map(),
    focused: false,
    onSubmit: undefined,
    onChange: undefined,
    disableSubmit: false,
    onEscape: undefined,
    onCtrlD: undefined,
    onPasteImage: undefined,
    onExtensionShortcut: undefined,
    borderColor: undefined,
    handleInput(data: string) {
      calls.input.push(data);
    },
    setText(text: string) {
      calls.texts.push(text);
    },
    getText() {
      return calls.texts.at(-1) ?? "";
    },
    render(width: number) {
      calls.renders.push(width);
      return ["line"];
    },
    invalidate() {},
    addToHistory() {},
    insertTextAtCursor() {},
    getExpandedText() {
      return calls.texts.at(-1) ?? "";
    },
    setAutocompleteProvider() {},
    setPaddingX() {},
    setAutocompleteMaxVisible() {},
  };
  return { inner, calls };
}

function makeEditor(
  config = makeConfig(),
  dispatchExtensionCommandHandler: (command: string) => boolean = () => false,
) {
  const { inner, calls } = makeInner();
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const events: Array<{ event: string; payload?: unknown }> = [];
  const tui = { requestRender() {} };
  const keybindings = new KeybindingsManager({
    "tui.input.submit": { defaultKeys: "enter" },
  } as never);
  const theme = { borderColor: (str: string) => str };
  const dispatches: string[] = [];
  const editor = new PrefixEditor(tui as never, theme as never, keybindings as never, inner as never, {
    config,
    emitEvent: (event, payload) => events.push({ event, payload }),
    setStatus: (text) => statuses.push(text),
    notify: (message, type) => notifications.push({ message, type }),
    dispatchExtensionCommand: (command) => {
      dispatches.push(command);
      return dispatchExtensionCommandHandler(command);
    },
  });
  return { editor, inner, calls, statuses, notifications, events, dispatches };
}

test("extension shortcut callback is honored before delegation", () => {
  const { editor, calls } = makeEditor();
  const seen: string[] = [];
  editor.onExtensionShortcut = (data: string) => {
    seen.push(data);
    return true;
  };
  editor.handleInput("ctrl+x");
  assert.deepEqual(seen, ["ctrl+x"]);
  assert.deepEqual(calls.input, []);
});

test("non-prefix input passes through transparently", () => {
  const { editor, calls, statuses } = makeEditor();
  editor.handleInput("a");
  assert.deepEqual(calls.input, ["a"]);
  assert.deepEqual(statuses, []);
});

test("activation sets status and dispatch waits for second key", () => {
  const { editor, statuses, calls } = makeEditor();
  editor.activate();
  assert.equal(statuses.length, 1);
  assert.equal(typeof statuses[0], "string");
  editor.handleInput("q");
  assert.deepEqual(calls.input, ["q"]);
  assert.ok(statuses.includes(undefined));
});

test("timeout clears prefix mode", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { editor, statuses, calls } = makeEditor();
    editor.activate();
    mock.timers.tick(2000);
    editor.handleInput("m");
    assert.deepEqual(calls.input, ["m"]);
    assert.ok(statuses.includes(undefined));
  } finally {
    mock.timers.reset();
  }
});

test("escape cancels prefix mode and is swallowed", () => {
  const { editor, calls } = makeEditor();
  editor.activate();
  editor.handleInput("\x1b");
  assert.deepEqual(calls.input, []);
});

test("unbound second key clears prefix mode and reaches the editor", () => {
  const { editor, calls } = makeEditor();
  editor.activate();
  editor.handleInput("z");
  assert.deepEqual(calls.input, ["z"]);
  assert.equal(calls.input.length, 1);
});

test("bound action key dispatches the app action", () => {
  const { editor } = makeEditor();
  let dispatched = 0;
  editor.onAction("app.model.select", () => {
    dispatched += 1;
  });
  editor.activate();
  editor.handleInput("m");
  assert.equal(dispatched, 1);
});

test("interrupt action uses the onEscape callback", () => {
  const { editor } = makeEditor(makeConfig({ e: { action: "app.interrupt" } }));
  let escaped = 0;
  editor.onEscape = () => {
    escaped += 1;
  };
  editor.activate();
  editor.handleInput("e");
  assert.equal(escaped, 1);
});

test("unavailable action notifies without throwing", () => {
  const { editor, notifications } = makeEditor(makeConfig({ u: { action: "app.zap" } }));
  editor.activate();
  editor.handleInput("u");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
});

test("command with submit false only replaces the draft", () => {
  const { editor, calls, dispatches } = makeEditor();
  editor.activate();
  editor.handleInput("i");
  assert.deepEqual(calls.texts, ["/model"]);
  assert.equal(calls.input.includes(SUBMIT_KEY_INPUT), false);
  assert.deepEqual(dispatches, []);
});

test("handled submitted extension command preserves the draft", () => {
  const draft = "long draft that must survive a plan-mode toggle";
  const { editor, calls, dispatches } = makeEditor(makeConfig(), () => true);
  editor.setText(draft);
  editor.activate();
  editor.handleInput("h");
  assert.deepEqual(dispatches, ["/hotkeys"]);
  assert.equal(editor.getText(), draft);
  assert.equal(calls.input.includes(SUBMIT_KEY_INPUT), false);
});

test("unhandled submitted command falls back to editor replacement", () => {
  const { editor, calls, dispatches } = makeEditor(makeConfig(), () => false);
  editor.activate();
  editor.handleInput("h");
  assert.deepEqual(dispatches, ["/hotkeys"]);
  assert.deepEqual(calls.texts, ["/hotkeys"]);
  assert.equal(calls.input.at(-1), SUBMIT_KEY_INPUT);
});

test("command with submit true replaces and submits", () => {
  const { editor, calls } = makeEditor();
  editor.activate();
  editor.handleInput("h");
  assert.deepEqual(calls.texts, ["/hotkeys"]);
  assert.equal(calls.input.at(-1), SUBMIT_KEY_INPUT);
});

test("disabled submission is respected", () => {
  const { editor, calls } = makeEditor();
  editor.disableSubmit = true;
  editor.activate();
  editor.handleInput("h");
  assert.deepEqual(calls.texts, ["/hotkeys"]);
  assert.equal(calls.input.includes(SUBMIT_KEY_INPUT), false);
});

test("event target emits the exact payload", () => {
  const { editor, events } = makeEditor();
  editor.activate();
  editor.handleInput("o");
  assert.deepEqual(events, [
    { event: "example:open", payload: { source: "pi-prefix" } },
  ]);
});

test("repeated activation keeps prefix mode active", () => {
  const { editor, statuses } = makeEditor();
  editor.activate();
  editor.activate();
  assert.ok(statuses.every((s) => s !== undefined));
  editor.handleInput("\x1b");
  assert.equal(statuses.at(-1), undefined);
});

test("callback synchronization forwards callbacks to the inner editor", () => {
  const { editor, inner } = makeEditor();
  const submitted = () => {};
  editor.onSubmit = submitted;
  editor.handleInput("a");
  assert.equal(inner.onSubmit, submitted);
});

test("render forwards focus and border color to the inner editor", () => {
  const { editor, inner, calls } = makeEditor();
  editor.focused = true;
  const lines = editor.render(40);
  assert.deepEqual(lines, ["line"]);
  assert.equal(inner.focused, true);
  assert.equal(calls.renders.at(-1), 40);
});

test("disposal makes the wrapper transparent", () => {
  const { editor, calls } = makeEditor();
  editor.dispose();
  editor.activate();
  editor.handleInput("m");
  assert.deepEqual(calls.input, ["m"]);
});
