#!/usr/bin/env node
/**
 * Contract self-test for the Zora presence worker harness.
 *
 * Runs the real harness loop against an in-memory mock of the two
 * control-plane endpoints and asserts the behaviour documented in
 * worker/README.md: bearer auth, apply-on-change, no-op when unchanged,
 * update on a new revision, clear on stop, error reporting, token freshness.
 *
 * Run:  node worker/harness/selftest.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { createWorker, stubDiscord } from "./worker.mjs";

const SECRET = "test-secret";

async function startMockApi() {
  /** discord_user_id → row served by /poll */
  const rows = new Map();
  const heartbeats = [];
  const counters = {
    poll: 0,
    pollAuthed: 0,
    heartbeat: 0,
    heartbeatAuthed: 0,
    unauthorized: 0,
  };

  const server = createServer((req, res) => {
    const authorized = req.headers["authorization"] === `Bearer ${SECRET}`;
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && req.url === "/api/public/worker/poll") {
      counters.poll++;
      if (!authorized) {
        counters.unauthorized++;
        res.writeHead(401);
        return res.end("Unauthorized");
      }
      counters.pollAuthed++;
      return json(200, {
        sessions: [...rows.values()].map((row) => ({ ...row })),
        server_time: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && req.url === "/api/public/worker/heartbeat") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!authorized) {
          counters.unauthorized++;
          res.writeHead(401);
          return res.end("Unauthorized");
        }
        counters.heartbeatAuthed++;
        heartbeats.push(JSON.parse(body));
        return json(200, { ok: true });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, rows, heartbeats, counters, base: `http://127.0.0.1:${port}` };
}

async function withFixture({ failDiscord = false } = {}, run) {
  const api = await startMockApi();
  const discord = stubDiscord({ fail: failDiscord, log: { info() {}, warn() {} } });
  const pollOnce = createWorker({
    apiBase: api.base,
    secret: SECRET,
    discord,
    log: { info() {}, warn() {} },
  });
  try {
    await run({ ...api, discord, pollOnce });
  } finally {
    api.server.close();
    await once(api.server, "close");
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("poll without the shared secret is rejected (401)", async () => {
  await withFixture({}, async ({ base, counters }) => {
    const res = await fetch(`${base}/api/public/worker/poll`);
    assert.equal(res.status, 401);
    assert.equal(counters.unauthorized, 1);
    const post = await fetch(`${base}/api/public/worker/heartbeat`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
      body: "{}",
    });
    assert.equal(post.status, 401);
  });
});

test("start: applies the activity and reports running with the fresh token + revision", async () => {
  await withFixture({}, async ({ rows, heartbeats, pollOnce, discord }) => {
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 1,
      activity: { type: 2, details: "🎵 Listening to Music" },
      access_token: "token-v1",
    });

    assert.equal(await pollOnce(), 1);

    assert.deepEqual(discord.calls, [
      { op: "apply", token: "token-v1", activity: { type: 2, details: "🎵 Listening to Music" } },
    ]);
    assert.deepEqual(heartbeats, [
      { discord_user_id: "u1", state: "running", message: null, revision: 1 },
    ]);
  });
});

test("unchanged revision does not re-apply, but keeps heartbeating", async () => {
  await withFixture({}, async ({ rows, heartbeats, pollOnce, discord }) => {
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 7,
      activity: { type: 0, details: "⛏️ Playing Minecraft" },
      access_token: "token-v1",
    });
    await pollOnce();
    await pollOnce();
    await pollOnce();

    assert.equal(discord.calls.length, 1, "apply must happen exactly once");
    assert.equal(heartbeats.length, 3, "one heartbeat per poll pass");
    for (const beat of heartbeats) {
      assert.equal(beat.state, "running");
      assert.equal(beat.revision, 7);
    }
  });
});

test("new revision updates with the refreshed token", async () => {
  await withFixture({}, async ({ rows, heartbeats, pollOnce, discord }) => {
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 1,
      activity: { type: 2, details: "old" },
      access_token: "token-v1",
    });
    await pollOnce();

    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 2,
      activity: { type: 3, details: "▶️ Watching YouTube" },
      access_token: "token-v2",
    });
    await pollOnce();

    assert.deepEqual(discord.calls, [
      { op: "apply", token: "token-v1", activity: { type: 2, details: "old" } },
      { op: "apply", token: "token-v2", activity: { type: 3, details: "▶️ Watching YouTube" } },
    ]);
    assert.equal(heartbeats.at(-1).revision, 2);
    assert.equal(heartbeats.at(-1).state, "running");
  });
});

test("stop clears once and then heartbeats cleared without re-clearing", async () => {
  await withFixture({}, async ({ rows, heartbeats, pollOnce, discord }) => {
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 1,
      activity: { type: 0, details: "live" },
      access_token: "token-v1",
    });
    await pollOnce();

    // The poll endpoint hands out a null token for stopped sessions.
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "stopped",
      revision: 2,
      activity: null,
      access_token: null,
    });
    await pollOnce();
    await pollOnce();

    assert.deepEqual(discord.calls, [
      { op: "apply", token: "token-v1", activity: { type: 0, details: "live" } },
      { op: "clear", token: null },
    ]);
    assert.equal(heartbeats.at(-1).state, "cleared");
    assert.equal(heartbeats.at(-1).revision, 2);
  });
});

test("Discord failure is reported as an error heartbeat and retried next pass", async () => {
  await withFixture({ failDiscord: true }, async ({ rows, heartbeats, pollOnce, discord }) => {
    rows.set("u1", {
      discord_user_id: "u1",
      desired_state: "running",
      revision: 1,
      activity: { type: 0, details: "x" },
      access_token: "token-v1",
    });
    await pollOnce();
    await pollOnce();

    assert.equal(discord.calls.length, 2, "failed apply is retried every pass");
    assert.equal(heartbeats.at(-1).state, "error");
    assert.match(heartbeats.at(-1).message, /stubbed Discord failure/);
  });
});

test("multiple users are reconciled independently", async () => {
  await withFixture({}, async ({ rows, pollOnce, discord }) => {
    rows.set("a", {
      discord_user_id: "a",
      desired_state: "running",
      revision: 1,
      activity: { type: 0, details: "A" },
      access_token: "tok-a",
    });
    rows.set("b", {
      discord_user_id: "b",
      desired_state: "stopped",
      revision: 5,
      activity: null,
      access_token: null,
    });
    await pollOnce();

    const byUser = Object.groupBy(discord.calls, (call) => call.token);
    assert.deepEqual(
      byUser["tok-a"].map((c) => c.op),
      ["apply"],
    );
    assert.equal(
      discord.calls.filter((c) => c.op === "clear").length,
      0,
      "stopped user was never running here — nothing to clear",
    );
    assert.equal(await pollOnce(), 2);
  });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
