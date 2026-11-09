import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineSplitter, PiRpc, type RpcRecord } from "../src/pi-rpc.ts";
import { FAKE_PI, quietLog, tempDir, testEnv, waitFor } from "./helpers.ts";

describe("LineSplitter", () => {
  it("splits only on LF, across chunk boundaries, keeping U+2028 inside records", () => {
    const lines: string[] = [];
    const s = new LineSplitter();
    const payload = Buffer.from(`${JSON.stringify({ a: "x\u2028y" })}\r\n{"b":"é"}\n`, "utf8");
    // Feed byte by byte to split multibyte sequences too.
    for (const byte of payload) s.push(Buffer.from([byte]), (l) => lines.push(l));
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: "x\u2028y" }, { b: "é" }]);
  });

  it("buffers an incomplete trailing line", () => {
    const lines: string[] = [];
    const s = new LineSplitter();
    s.push(Buffer.from('{"a":1}\n{"b"'), (l) => lines.push(l));
    assert.deepEqual(lines, ['{"a":1}']);
    s.push(Buffer.from(":2}\n"), (l) => lines.push(l));
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });
});

describe("PiRpc", () => {
  const spawnFake = () => {
    const rpc = new PiRpc({ command: FAKE_PI, args: ["--mode", "rpc"], cwd: tempDir(), env: testEnv(), log: quietLog });
    rpc.start();
    return rpc;
  };

  it("correlates responses and streams events", async () => {
    const rpc = spawnFake();
    const events: RpcRecord[] = [];
    rpc.on("event", (e) => events.push(e));
    const state = await rpc.request<{ model: { id: string } }>({ type: "get_state" });
    assert.equal(state.model.id, "fake-model");
    const res = await rpc.request<{ disposition: string }>({ type: "prompt", message: "unicode" });
    assert.equal(res.disposition, "started");
    await waitFor(() => events.some((e) => e.type === "agent_settled"));
    const end = events.find((e) => e.type === "message_end" && (e.message as { role: string }).role === "assistant");
    assert.deepEqual((end?.message as { content: unknown }).content, [{ type: "text", text: "line\u2028sep" }]);
    await rpc.stop();
    assert.equal(rpc.alive, false);
  });

  it("rejects failed commands with pi's error", async () => {
    const rpc = spawnFake();
    await assert.rejects(rpc.request({ type: "bogus" }), /unsupported command: bogus/);
    await rpc.stop();
  });

  it("rejects pending requests when pi exits", async () => {
    const rpc = spawnFake();
    await rpc.request({ type: "get_state" });
    const exited = new Promise<number | null>((r) => rpc.once("exit", (code) => r(code)));
    await assert.rejects(rpc.request({ type: "prompt", message: "crash" }), /exited/);
    assert.equal(await exited, 3);
    await assert.rejects(rpc.request({ type: "get_state" }), /not running/);
  });
});
