import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionLiveness, listLiveInteractiveSessions } from "../.github/extensions/uhura/src/uhura-session-liveness.mjs";

function writeSession(root, id, { pid = process.pid, clientName = "github/cli", cwd = "C:\\repos\\uhura" } = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `inuse.${pid}.lock`), "");
  writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\nclient_name: ${clientName}\n`);
}

test("session liveness includes only live interactive Copilot CLI sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "uhura-session-liveness-"));
  const live = "11111111-aaaa-bbbb-cccc-111111111111";
  const autopilot = "22222222-aaaa-bbbb-cccc-222222222222";
  const stale = "33333333-aaaa-bbbb-cccc-333333333333";
  try {
    writeSession(root, live);
    writeSession(root, autopilot, { clientName: "github/autopilot" });
    writeSession(root, stale, { pid: 999999 });

    const getProcessInfos = (pids) => new Map(pids.map((pid) => [pid, { name: "copilot.exe", commandLine: `copilot.exe --session-id ${live}` }]));
    const isLive = createSessionLiveness({ sessionStateDir: root, ttlMs: 0, getProcessInfos });
    assert.equal(isLive({ sessionId: live }), true);
    assert.equal(isLive({ sessionId: autopilot }), false);
    assert.equal(isLive({ sessionId: stale }), false);

    assert.deepEqual(listLiveInteractiveSessions({ sessionStateDir: root, getProcessInfos }), [
      { sessionId: live, cwd: "C:\\repos\\uhura", dir: "uhura" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
