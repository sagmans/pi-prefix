import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { setupPiPrefix } from "../index.ts";
import type { EditorComponent } from "@earendil-works/pi-tui";

type SavedShortcut = { shortcut: string; handler: () => void };

type UserMessage = { content: string; options?: Record<string, unknown> };

type Harness = {
  pi: Record<string, unknown>;
  priorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => EditorComponent) | undefined;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  shortcuts: SavedShortcut[];
  userMessages: UserMessage[];
  availableCommands: Array<{ name: string; source: string }>;
  events: Array<{ event: string; payload?: unknown }>;
  notifications: Array<{ message: string; type?: string }>;
  statuses: Array<[string, string | undefined]>;
  editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => EditorComponent) | undefined;
  handlers: Map<string, (event: unknown, ctx: unknown) => void>;
  startSession: (options: { cwd: string; trusted: boolean }) => void;
  notifyCount: (level: string) => number;
};

function makeHarness(agentDir: string): Harness {
  const commands = new Map();
  const shortcuts: SavedShortcut[] = [];
  const userMessages: UserMessage[] = [];
  const availableCommands: Array<{ name: string; source: string }> = [
    { name: "plan", source: "extension" },
  ];
  const events: Array<{ event: string; payload?: unknown }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let editorFactory: Harness["editorFactory"];
  let priorFactory: Harness["editorFactory"];
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
    registerShortcut: (shortcut: string, options: { handler: () => void }) => {
      shortcuts.push({ shortcut, handler: options.handler });
    },
    getCommands: () => availableCommands.map((command) => ({ ...command })),
    sendUserMessage: (content: string, options?: Record<string, unknown>) => {
      userMessages.push({ content, options });
    },
    events: {
      emit: (event: string, payload?: unknown) => events.push({ event, payload }),
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
  const harness: Harness = {
    pi,
    priorFactory,
    commands,
    shortcuts,
    userMessages,
    availableCommands,
    events,
    notifications,
    statuses,
    editorFactory,
    handlers,
    startSession: () => {},
    notifyCount: () => 0,
  };
  harness.startSession = ({ cwd, trusted }) => {
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => trusted,
      ui: {
        getEditorComponent: () => harness.priorFactory ?? editorFactory,
        setEditorComponent: (factory: Harness["editorFactory"]) => {
          editorFactory = factory;
          harness.editorFactory = factory;
        },
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      },
    };
    handlers.get("session_start")?.({}, ctx);
  };
  harness.notifyCount = (level) => notifications.filter((n) => n.type === level).length;
  setupPiPrefix(pi as never, { agentDir });
  return harness;
}

function writeAgentConfig(agentDir: string, value: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "pi-prefix.json"), JSON.stringify(value));
}

function makeKeybindings(defaults: Record<string, unknown> = {}): KeybindingsManager {
  const definitions: Record<string, { defaultKeys: unknown }> = {
    "tui.input.submit": { defaultKeys: "enter" },
    ...Object.fromEntries(
      Object.entries(defaults).map(([id, keys]) => [id, { defaultKeys: keys }]),
    ),
  };
  return new KeybindingsManager(definitions as never);
}

const TUI = { requestRender() {} };
const THEME = { borderColor: (str: string) => str };

function mount(harness: Harness, keybindings: KeybindingsManager): EditorComponent & { activate?: () => void } {
  assert.ok(harness.editorFactory, "editor factory not installed");
  return harness.editorFactory(TUI, THEME, keybindings) as never;
}

test("no config keeps the extension inert", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  assert.equal(harness.editorFactory, undefined);
  assert.equal(harness.notifications.length, 0);
});

test("invalid config reports errors and stays inactive", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, { prefix: "ctrl+x", bindings: { h: { command: "hotkeys", submit: true } } });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  assert.ok(harness.notifyCount("error") >= 1);
  assert.equal(harness.editorFactory, undefined);
  assert.equal(harness.shortcuts.length, 0);
});

test("config warnings notify without blocking", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, { prefix: "ctrl+x", bindings: { escape: { action: "app.clear" } } });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  assert.ok(harness.notifyCount("warning") >= 1);
  assert.ok(harness.editorFactory);
});

test("conflicting prefix is reported and never registered", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, { prefix: "ctrl+l", bindings: { m: { action: "app.clear" } } });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  mount(harness, makeKeybindings({ "app.model.select": "ctrl+l" }));
  assert.ok(harness.notifyCount("error") >= 1);
  assert.ok(harness.notifications.some((n) => n.message.includes("app.model.select")));
  assert.equal(harness.shortcuts.length, 0);
});

test("free prefix installs a composing editor and registers the shortcut", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    bindings: { m: { action: "app.model.select" } },
  });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const editor = mount(harness, makeKeybindings());
  assert.equal(harness.shortcuts.length, 1);
  assert.equal(harness.shortcuts[0].shortcut, "ctrl+x");
  let dispatched = 0;
  (editor as never as { onAction: (a: string, h: () => void) => void }).onAction(
    "app.model.select",
    () => {
      dispatched += 1;
    },
  );
  harness.shortcuts[0].handler();
  editor.handleInput("m");
  assert.equal(dispatched, 1);
});

test("prior custom editor stays composed under the wrapper", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    bindings: { m: { action: "app.model.select" } },
  });
  const harness = makeHarness(agentDir);
  harness.priorFactory = () =>
    ({
      handleInput() {},
      getText: () => "inner-text",
      setText() {},
      render: () => ["inner"],
    }) as never;
  harness.startSession({ cwd: agentDir, trusted: true });
  const editor = mount(harness, makeKeybindings());
  assert.equal(editor.getText(), "inner-text");
});

test("submitted extension command dispatches directly and preserves the draft", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    bindings: { p: { command: "/plan", submit: true } },
  });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const editor = mount(harness, makeKeybindings());
  const draft = "long draft that must survive a plan-mode toggle";
  editor.setText(draft);
  harness.shortcuts[0].handler();
  editor.handleInput("p");
  assert.deepEqual(harness.userMessages, [
    { content: "/plan", options: { expandPromptTemplates: true } },
  ]);
  assert.equal(editor.getText(), draft);
});

test("submitted non-extension command falls back to editor submission", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    bindings: { h: { command: "/hotkeys", submit: true } },
  });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const editor = mount(harness, makeKeybindings());
  harness.shortcuts[0].handler();
  editor.handleInput("h");
  assert.deepEqual(harness.userMessages, []);
  // WHY: the fallback mirrors manual typing, so the command text is consumed by
  // the editor submission rather than surviving as the draft.
  assert.equal(editor.getText(), "");
});

test("session shutdown disposes the wrapper and clears status", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    bindings: { m: { action: "app.model.select" } },
  });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const editor = mount(harness, makeKeybindings());
  const shutdownCtx = {
    ui: {
      notify: (message: string, type?: string) => harness.notifications.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => harness.statuses.push([key, text]),
    },
  };
  harness.handlers.get("session_shutdown")?.({}, shutdownCtx);
  editor.handleInput("m");
  const dispatchStillWorks = harness.shortcuts[0];
  dispatchStillWorks.handler();
  editor.handleInput("m");
  assert.ok(harness.statuses.some(([key, text]) => key === "pi-prefix" && text === undefined));
});

test("status command reports inactive state without config", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const handler = harness.commands.get("pi-prefix");
  assert.ok(handler);
  await handler("", {
    ui: { notify: (message: string, type?: string) => harness.notifications.push({ message, type }) },
  });
  assert.ok(harness.notifications.some((n) => n.message.includes("inactive")));
  assert.ok(harness.notifications.some((n) => n.message.includes("pi-prefix.json")));
});

test("status command reports active state with config summary", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, {
    prefix: "ctrl+x",
    timeoutMs: 3000,
    bindings: { m: { action: "app.model.select" }, h: { command: "/hotkeys", submit: true } },
  });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  mount(harness, makeKeybindings());
  const handler = harness.commands.get("pi-prefix");
  assert.ok(handler);
  await handler("", {
    ui: { notify: (message: string, type?: string) => harness.notifications.push({ message, type }) },
  });
  const summary = harness.notifications.find((n) => n.message.includes("active"));
  assert.ok(summary);
  assert.ok(summary.message.includes("ctrl+x"));
  assert.ok(summary.message.includes("3000"));
  assert.ok(summary.message.includes("/hotkeys"));
});
