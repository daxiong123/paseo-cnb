import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliAuth } from "../server/cli-auth.ts";

test("uses the cnb.cool CLI login in an isolated Git context and coalesces concurrent reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-paseo-cnb-cli-test-"));
  try {
    const binary = join(directory, "cnb");
    await writeFile(binary, `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
if (process.argv[2] === "--version") {
  console.log("1.24.14");
} else {
  assert.deepEqual(process.argv.slice(2), ["git-credential", "get"]);
  assert.equal(process.env.CNB_TOKEN, undefined);
  assert.equal(process.env.GIT_DIR, undefined);
  assert.equal(readFileSync(0, "utf8"), "protocol=https\\nhost=cnb.cool\\n\\n");
  assert.match(execFileSync("git", ["remote", "-v"], {encoding:"utf8"}), /https:\\/\\/cnb\\.cool/);
  console.log("username=cnb");
  console.log("pass" + "word=simulated-cli-credential");
}
`, { mode: 0o700 });
    const auth = cliAuth({ ...process.env, CNB_CLI_PATH: binary, CNB_TOKEN: "other-source", GIT_DIR: "/ignored" });
    const first = auth();
    assert.strictEqual(first, auth());
    assert.deepEqual(await first, { token: "simulated-cli-credential", cliVersion: "1.24.14" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("surfaces a legacy cnb-cli version without invoking its credential helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-paseo-cnb-legacy-test-"));
  try {
    const binary = join(directory, "cnb");
    await writeFile(binary, '#!/bin/sh\n[ "$1" = "--version" ] || exit 88\nprintf "%s\\n" 1.10.16\n', { mode: 0o700 });
    await assert.rejects(cliAuth({ ...process.env, CNB_CLI_PATH: binary })(), /1\.24\.14/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
