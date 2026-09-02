import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("packaged files match the exact allowlist", () => {
  const EXPECTED_PACK_FILES = new Set([
    "README.md",
    "SECURITY.md",
    "LICENSE",
    "defaults.json",
    "schema.json",
    "index.ts",
    "package.json",
    "skills/pi-prefix/SKILL.md",
    "src/config.ts",
    "src/conflicts.ts",
    "src/prefix-editor.ts",
  ]);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ) as Array<{ files: Array<{ path: string }> }>;
  const actual = new Set(packed[0].files.map((file) => file.path));
  assert.deepEqual([...actual].sort(), [...EXPECTED_PACK_FILES].sort());
});

test("shipped defaults stay neutral", () => {
  const defaults = JSON.parse(readFileSync(join(packageRoot, "defaults.json"), "utf8"));
  assert.deepEqual(Object.keys(defaults).sort(), ["timeoutMs"]);
  assert.equal(typeof defaults.timeoutMs, "number");
});
