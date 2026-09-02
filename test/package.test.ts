import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("pi manifest references existing extension and skill paths", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    pi: { extensions: string[]; skills: string[] };
  };
  for (const extension of manifest.pi.extensions) {
    assert.ok(existsSync(join(packageRoot, extension)), `missing extension: ${extension}`);
  }
  for (const skill of manifest.pi.skills) {
    assert.ok(existsSync(join(packageRoot, skill)), `missing skill dir: ${skill}`);
  }
  assert.ok(
    existsSync(join(packageRoot, "skills", "pi-prefix", "SKILL.md")),
    "skill entrypoint missing",
  );
});

test("shipped defaults stay neutral", () => {
  const defaults = JSON.parse(readFileSync(join(packageRoot, "defaults.json"), "utf8"));
  assert.deepEqual(Object.keys(defaults).sort(), ["timeoutMs"]);
  assert.equal(typeof defaults.timeoutMs, "number");
});
