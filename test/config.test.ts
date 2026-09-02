import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeKeyId } from "../src/config.ts";

type Env = {
  agentDir: string;
  projectDir: string;
  load: (projectTrusted: boolean) => ReturnType<typeof loadConfig>;
};

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "pi-prefix-config-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return {
    agentDir,
    projectDir,
    load: (projectTrusted: boolean) =>
      loadConfig({ agentDir, cwd: projectDir, projectTrusted }),
  };
}

function writeGlobal(env: Env, value: unknown): void {
  writeFileSync(join(env.agentDir, "pi-prefix.json"), JSON.stringify(value));
}

function writeProject(env: Env, value: unknown): void {
  mkdirSync(join(env.projectDir, ".pi"), { recursive: true });
  writeFileSync(join(env.projectDir, ".pi", "pi-prefix.json"), JSON.stringify(value));
}

const GLOBAL_CONFIG = {
  prefix: "ctrl+x",
  bindings: {
    m: { action: "app.model.select" },
    h: { command: "/hotkeys", submit: true },
    o: { event: "example-extension:open", payload: { source: "pi-prefix" } },
  },
};

test("no config stays inert with no diagnostics", () => {
  const env = makeEnv();
  const result = env.load(true);
  assert.equal(result.config, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.projectLoaded, false);
});

test("valid global config activates with shipped default timeout", () => {
  const env = makeEnv();
  writeGlobal(env, GLOBAL_CONFIG);
  const result = env.load(false);
  assert.ok(result.config);
  assert.equal(result.config.prefix, "ctrl+x");
  assert.equal(result.config.timeoutMs, 2000);
  assert.equal(result.config.bindings.size, 3);
  assert.deepEqual(result.config.bindings.get("m"), { action: "app.model.select" });
  assert.deepEqual(result.config.bindings.get("h"), { command: "/hotkeys", submit: true });
  assert.deepEqual(result.config.bindings.get("o"), {
    event: "example-extension:open",
    payload: { source: "pi-prefix" },
  });
});

test("global timeout override applies", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, timeoutMs: 5000 });
  const result = env.load(false);
  assert.equal(result.config?.timeoutMs, 5000);
});

test("trusted project overlay adds, replaces, and removes bindings", () => {
  const env = makeEnv();
  writeGlobal(env, GLOBAL_CONFIG);
  writeProject(env, {
    bindings: {
      o: null,
      h: { command: "/model", submit: false },
      w: { command: "/project-command", submit: true },
    },
  });
  const result = env.load(true);
  assert.equal(result.projectLoaded, true);
  const { config } = result;
  assert.ok(config);
  assert.equal(config.bindings.size, 3);
  assert.equal(config.bindings.has("o"), false);
  assert.deepEqual(config.bindings.get("h"), { command: "/model", submit: false });
  assert.deepEqual(config.bindings.get("w"), { command: "/project-command", submit: true });
  assert.deepEqual(config.bindings.get("m"), { action: "app.model.select" });
});

test("project scalar prefix replaces global prefix", () => {
  const env = makeEnv();
  writeGlobal(env, GLOBAL_CONFIG);
  writeProject(env, { prefix: "ctrl+alt+p" });
  const result = env.load(true);
  assert.equal(result.config?.prefix, "ctrl+alt+p");
});

test("untrusted project config is ignored", () => {
  const env = makeEnv();
  writeGlobal(env, GLOBAL_CONFIG);
  writeProject(env, { prefix: "ctrl+alt+p", bindings: { z: { action: "app.zap" } } });
  const result = env.load(false);
  assert.equal(result.projectLoaded, false);
  assert.equal(result.config?.prefix, "ctrl+x");
  assert.equal(result.config?.bindings.size, 3);
});

test("malformed JSON fails closed with path and reason", () => {
  const env = makeEnv();
  writeFileSync(join(env.agentDir, "pi-prefix.json"), "{ not json");
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].level, "error");
  assert.equal(result.diagnostics[0].path, join(env.agentDir, "pi-prefix.json"));
  assert.ok(result.diagnostics[0].message.length > 0);
});

test("unknown top-level property fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, mode: "aggressive" });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("mode")));
});

test("invalid prefix key id fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+meta+x", bindings: { m: { action: "app.model.select" } } });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error" && d.path.includes("pi-prefix.json")));
});

test("target with zero kinds fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+x", bindings: { m: {} } });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("m")));
});

test("target with multiple kinds fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, {
    prefix: "ctrl+x",
    bindings: { m: { action: "app.model.select", command: "/hotkeys", submit: true } },
  });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error"));
});

test("command without leading slash fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+x", bindings: { h: { command: "hotkeys", submit: true } } });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error"));
});

test("empty event name fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+x", bindings: { o: { event: "" } } });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error"));
});

test("payload outside event target fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+x", bindings: { m: { action: "app.model.select", payload: {} } } });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error"));
});

test("zero timeout fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, timeoutMs: 0 });
  const result = env.load(false);
  assert.equal(result.config, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("timeoutMs")));
});

test("negative timeout fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, timeoutMs: -5 });
  const result = env.load(false);
  assert.equal(result.config, undefined);
});

test("non-integer timeout fails closed", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, timeoutMs: 1.5 });
  const result = env.load(false);
  assert.equal(result.config, undefined);
});

test("large positive integer timeout is accepted", () => {
  const env = makeEnv();
  writeGlobal(env, { ...GLOBAL_CONFIG, timeoutMs: 600000 });
  const result = env.load(false);
  assert.equal(result.config?.timeoutMs, 600000);
});

test("escape binding warns but stays active", () => {
  const env = makeEnv();
  writeGlobal(env, {
    prefix: "ctrl+x",
    bindings: { escape: { action: "app.model.select" }, m: { action: "app.model.select" } },
  });
  const result = env.load(false);
  assert.ok(result.config);
  assert.equal(result.config.bindings.size, 2);
  assert.ok(result.diagnostics.some((d) => d.level === "warning" && d.message.includes("escape")));
});

test("bindings emptied by overlay stays inert", () => {
  const env = makeEnv();
  writeGlobal(env, { prefix: "ctrl+x", bindings: { m: { action: "app.model.select" } } });
  writeProject(env, { bindings: { m: null } });
  const result = env.load(true);
  assert.equal(result.config, undefined);
  assert.deepEqual(result.diagnostics, []);
});

test("normalizeKeyId maps aliases and modifier order", () => {
  assert.equal(normalizeKeyId("esc"), "escape");
  assert.equal(normalizeKeyId("return"), "enter");
  assert.equal(normalizeKeyId("alt+ctrl+x"), "ctrl+alt+x");
  assert.equal(normalizeKeyId("super+shift+ctrl+k"), "ctrl+shift+super+k");
  assert.equal(normalizeKeyId("M"), "shift+m");
  assert.equal(normalizeKeyId("ctrl+X"), "ctrl+shift+x");
  assert.equal(normalizeKeyId("shift+m"), "shift+m");
  assert.equal(normalizeKeyId("f5"), "f5");
  assert.equal(normalizeKeyId("pageUp"), "pageUp");
  assert.equal(normalizeKeyId("ctrl+/"), "ctrl+/");
});

test("normalizeKeyId rejects invalid input", () => {
  assert.equal(normalizeKeyId("ctrl+meta+x"), undefined);
  assert.equal(normalizeKeyId("ctrl"), undefined);
  assert.equal(normalizeKeyId("ctrl+ctrl+x"), undefined);
  assert.equal(normalizeKeyId("x+y"), undefined);
  assert.equal(normalizeKeyId("f13"), undefined);
  assert.equal(normalizeKeyId(""), undefined);
  assert.equal(normalizeKeyId("CTRL+X"), undefined);
});
