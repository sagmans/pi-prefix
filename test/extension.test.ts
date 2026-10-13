import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, renameSync, rmSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { setupPiPrefix } from "../index.ts";
import { hashOverlay } from "../src/config.ts";
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
    { content: "/plan", options: { expandPromptTemplates: true, deliverAs: "steer" } },
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

test("status command reports load errors while inactive", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-prefix-ext-"));
  writeAgentConfig(agentDir, { prefix: "ctrl+x", timeoutMs: 0, bindings: { h: { command: "/hotkeys" } } });
  const harness = makeHarness(agentDir);
  harness.startSession({ cwd: agentDir, trusted: true });
  const handler = harness.commands.get("pi-prefix");
  assert.ok(handler);
  await handler("", {
    ui: { notify: (message: string, type?: string) => harness.notifications.push({ message, type }) },
  });
  const status = harness.notifications.at(-1)?.message ?? "";
  assert.ok(status.includes("inactive"));
  assert.ok(status.includes("error:"));
  assert.ok(status.includes("timeoutMs must be a positive integer"));
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

// Approval flow: the only consent step, so every refusal path must leave the
// global config untouched and acceptance must pin exactly one entry.
type ApproveContext = {
  ctx: Record<string, unknown>;
  dialogs: Array<{ title: string; options: string[] }>;
  notifications: Array<{ message: string; type?: string }>;
};

function makeApproveContext(
  cwd: string,
  answer: string | undefined,
  overrides: Record<string, unknown> = {},
): ApproveContext {
  const dialogs: ApproveContext["dialogs"] = [];
  const notifications: ApproveContext["notifications"] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        return answer;
      },
    },
    ...overrides,
  };
  return { ctx, dialogs, notifications };
}

function makeApproveEnv(overlay: unknown = { bindings: { w: { command: "/plan", submit: true } } }) {
  const root = mkdtempSync(join(tmpdir(), "pi-prefix-approve-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeAgentConfig(agentDir, { prefix: "ctrl+x", bindings: { h: { command: "/hotkeys", submit: true } } });
  chmodSync(join(agentDir, "pi-prefix.json"), 0o600);
  writeFileSync(join(projectDir, ".pi", "pi-prefix.json"), typeof overlay === "string" ? overlay : JSON.stringify(overlay));
  const harness = makeHarness(agentDir);
  const handler = harness.commands.get("pi-prefix");
  assert.ok(handler);
  const globalPath = join(agentDir, "pi-prefix.json");
  return { agentDir, projectDir, handler, globalPath, before: readFileSync(globalPath, "utf8") };
}

test("approval dialog offers No first and lists commands instead of raw text", async () => {
  const env = makeApproveEnv();
  const { ctx, dialogs } = makeApproveContext(env.projectDir, undefined);
  await env.handler("allow-project", ctx);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].options[0], "No");
  assert.ok(dialogs[0].title.includes("w -> /plan"));
  assert.ok(!dialogs[0].title.includes('"bindings"'));
  assert.equal(readFileSync(env.globalPath, "utf8"), env.before);
});

test("declining or dismissing approval writes nothing", async () => {
  for (const answer of ["No", undefined]) {
    const env = makeApproveEnv();
    const { ctx } = makeApproveContext(env.projectDir, answer);
    await env.handler("allow-project", ctx);
    assert.equal(readFileSync(env.globalPath, "utf8"), env.before, String(answer));
  }
});

test("accepting approval pins one entry and keeps the file mode", async () => {
  const env = makeApproveEnv();
  const { ctx, notifications } = makeApproveContext(env.projectDir, "Yes, approve");
  await env.handler("allow-project", ctx);
  await env.handler("allow-project", ctx);
  const written = JSON.parse(readFileSync(env.globalPath, "utf8"));
  assert.equal(written.projectOverlays.allow.length, 1);
  assert.equal(written.projectOverlays.allow[0].path, realpathSync.native(env.projectDir));
  assert.equal(
    written.projectOverlays.allow[0].sha256,
    hashOverlay(readFileSync(join(env.projectDir, ".pi", "pi-prefix.json"))),
  );
  assert.equal(written.prefix, "ctrl+x");
  assert.equal(statSync(env.globalPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(env.agentDir).filter((name) => name.endsWith(".tmp")), []);
  assert.ok(notifications.some((n) => n.message.includes("approved")));
});

test("approval is refused without the interactive UI or project trust", async () => {
  for (const overrides of [{ hasUI: false }, { mode: "rpc" }, { mode: "print" }, { isProjectTrusted: () => false }]) {
    const env = makeApproveEnv();
    const { ctx, dialogs, notifications } = makeApproveContext(env.projectDir, "Yes, approve", overrides);
    await env.handler("allow-project", ctx);
    assert.equal(dialogs.length, 0, JSON.stringify(overrides));
    assert.ok(notifications.some((n) => n.type === "error"), JSON.stringify(overrides));
    assert.equal(readFileSync(env.globalPath, "utf8"), env.before);
  }
});

test("approval refuses an unparsable global config and invalid overlays", async () => {
  const broken = makeApproveEnv();
  writeFileSync(broken.globalPath, "{ not json");
  const first = makeApproveContext(broken.projectDir, "Yes, approve");
  await broken.handler("allow-project", first.ctx);
  assert.equal(first.dialogs.length, 0);
  assert.equal(readFileSync(broken.globalPath, "utf8"), "{ not json");

  for (const overlay of [
    { bindings: { w: { command: "/plan now", submit: true } } },
    { bindings: { w: { command: "/pi-prefix", submit: true } } },
    { prefix: "ctrl+y" },
  ]) {
    const env = makeApproveEnv(overlay);
    const { ctx, dialogs } = makeApproveContext(env.projectDir, "Yes, approve");
    await env.handler("allow-project", ctx);
    assert.equal(dialogs.length, 0, JSON.stringify(overlay));
    assert.equal(readFileSync(env.globalPath, "utf8"), env.before);
  }
});

test("a symlinked project directory approves its real path", async () => {
  const env = makeApproveEnv();
  const link = `${env.projectDir}-link`;
  symlinkSync(env.projectDir, link);
  const { ctx } = makeApproveContext(link, "Yes, approve");
  await env.handler("allow-project", ctx);
  const written = JSON.parse(readFileSync(env.globalPath, "utf8"));
  assert.equal(written.projectOverlays.allow[0].path, realpathSync.native(env.projectDir));
});

test("active project overlay notice names each key's command", () => {
  const env = makeApproveEnv();
  const raw = readFileSync(join(env.projectDir, ".pi", "pi-prefix.json"));
  writeAgentConfig(env.agentDir, {
    prefix: "ctrl+x",
    bindings: { h: { command: "/hotkeys", submit: true } },
    projectOverlays: { allow: [{ path: realpathSync.native(env.projectDir), sha256: hashOverlay(raw) }] },
  });
  const harness = makeHarness(env.agentDir);
  harness.startSession({ cwd: env.projectDir, trusted: true });
  const notice = harness.notifications.find((n) => n.message.includes("project overlay active"));
  assert.ok(notice);
  assert.ok(notice.message.includes("w -> /plan"));
  assert.equal(notice.type, "warning");
});

test("approval refuses device, FIFO and oversized overlays without hanging", async () => {
  for (const target of ["/dev/zero", "/dev/stdin"]) {
    const env = makeApproveEnv();
    const overlayPath = join(env.projectDir, ".pi", "pi-prefix.json");
    rmSync(overlayPath);
    symlinkSync(target, overlayPath);
    const { ctx, dialogs, notifications } = makeApproveContext(env.projectDir, "Yes, approve");
    await env.handler("allow-project", ctx);
    assert.equal(dialogs.length, 0, target);
    assert.ok(notifications.some((n) => n.type === "error" && n.message.includes("not approvable")), target);
    assert.equal(readFileSync(env.globalPath, "utf8"), env.before);
  }
});

test("approval refuses a key the user removed with null", async () => {
  const env = makeApproveEnv();
  writeAgentConfig(env.agentDir, { prefix: "ctrl+x", bindings: { w: null } });
  const before = readFileSync(env.globalPath, "utf8");
  const { ctx, dialogs } = makeApproveContext(env.projectDir, "Yes, approve");
  await env.handler("allow-project", ctx);
  assert.equal(dialogs.length, 0);
  assert.equal(readFileSync(env.globalPath, "utf8"), before);
});

test("approval refuses global configs it cannot safely update", async () => {
  for (const text of [
    "[]",
    '{"projectOverlays": []}',
    '{"projectOverlays": {"allow": {}}}',
    '{"prefix": "ctrl+x", "timeoutMs": 0}',
  ]) {
    const env = makeApproveEnv();
    writeFileSync(env.globalPath, text);
    const { ctx, dialogs } = makeApproveContext(env.projectDir, "Yes, approve");
    await env.handler("allow-project", ctx);
    assert.equal(dialogs.length, 0, text);
    assert.equal(readFileSync(env.globalPath, "utf8"), text);
  }
});

test("approval aborts when either file changes during review", async () => {
  for (const change of ["overlay", "global"]) {
    const env = makeApproveEnv();
    const overlayPath = join(env.projectDir, ".pi", "pi-prefix.json");
    const { ctx } = makeApproveContext(env.projectDir, "Yes, approve");
    const ui = ctx.ui as { select: (t: string, o: string[]) => Promise<string> };
    ui.select = async () => {
      if (change === "overlay") writeFileSync(overlayPath, '{"bindings":{"w":{"command":"/other","submit":true}}}');
      else writeFileSync(env.globalPath, '{"prefix":"ctrl+y"}');
      return "Yes, approve";
    };
    await env.handler("allow-project", ctx);
    const global = readFileSync(env.globalPath, "utf8");
    assert.ok(!global.includes("projectOverlays"), change);
  }
});

test("approval keeps a symlinked global config a symlink", async () => {
  const env = makeApproveEnv();
  const realFile = join(env.agentDir, "..", "dotfiles-pi-prefix.json");
  renameSync(env.globalPath, realFile);
  symlinkSync(realFile, env.globalPath);
  const { ctx } = makeApproveContext(env.projectDir, "Yes, approve");
  await env.handler("allow-project", ctx);
  assert.ok(lstatSync(env.globalPath).isSymbolicLink());
  assert.ok(readFileSync(realFile, "utf8").includes("projectOverlays"));
});

test("prefix conflict leaves no project marker in the status line", () => {
  const env = makeApproveEnv();
  const raw = readFileSync(join(env.projectDir, ".pi", "pi-prefix.json"));
  writeAgentConfig(env.agentDir, {
    prefix: "ctrl+x",
    bindings: { h: { command: "/hotkeys", submit: true } },
    projectOverlays: { allow: [{ path: realpathSync.native(env.projectDir), sha256: hashOverlay(raw) }] },
  });
  const harness = makeHarness(env.agentDir);
  harness.startSession({ cwd: env.projectDir, trusted: true });
  mount(harness, makeKeybindings({ "app.model.select": "ctrl+x" }));
  assert.equal(harness.shortcuts.length, 0);
  assert.equal(harness.statuses.at(-1)?.[1], undefined);
});
