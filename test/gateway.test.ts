import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { type ChatPlatform, Gateway, type InboundEvent, type InboundFile } from "../src/gateway.ts";
import { StateStore } from "../src/state.ts";
import { FakeSink, quietLog, tempDir, testConfig, testEnv, waitFor } from "./helpers.ts";

class FakePlatform implements ChatPlatform {
  readonly botUserId = "UBOT";
  sinks = new Map<string, FakeSink>();
  downloads: string[] = [];
  sinkFor(channelId: string): FakeSink {
    let sink = this.sinks.get(channelId);
    if (!sink) this.sinks.set(channelId, (sink = new FakeSink()));
    return sink;
  }
  async downloadFile(file: InboundFile, destPath: string): Promise<void> {
    this.downloads.push(destPath);
    writeFileSync(destPath, `content of ${file.name}`);
  }
  async channelName(channelId: string): Promise<string> {
    return `name-${channelId}`;
  }
}

const gateways: Gateway[] = [];

function setup(configOverrides: Record<string, unknown> = {}) {
  const config = testConfig(configOverrides);
  const state = new StateStore(config.stateDir, quietLog);
  const platform = new FakePlatform();
  const env = testEnv();
  const gateway = new Gateway({ config, state, platform, log: quietLog, env });
  gateways.push(gateway);
  return { config, state, platform, gateway, env };
}

let tsCounter = 0;
function event(partial: Partial<InboundEvent>): InboundEvent {
  return { userId: "U111", channelId: "D1", channelType: "im", text: "", ts: `9.${String(++tsCounter).padStart(4, "0")}`, files: [], ...partial };
}

const toolsValues = (argv: string[]) => argv.flatMap((a, i) => (a === "--tools" ? [argv[i + 1]] : []));

/** Send "argv" to a channel and return the fake pi's argv from the reply. */
async function argvIn(gateway: Gateway, platform: FakePlatform, channelId: string): Promise<string[]> {
  const sink = platform.sinkFor(channelId);
  const before = sink.texts("markdown").length;
  await gateway.handle(event({ channelId, channelType: "channel", text: "argv" }));
  const reply = await waitFor(() => sink.texts("markdown")[before], 5_000, "argv reply");
  return JSON.parse(reply) as string[];
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.shutdown()));
});

describe("Gateway", () => {
  it("ignores users that are not allowed", async () => {
    const { gateway, platform } = setup();
    await gateway.handle(event({ userId: "U999", text: "hi" }));
    assert.equal(platform.sinks.get("D1")?.calls.length ?? 0, 0);
  });

  it("routes DMs to the dm binding and strips Slack markup", async () => {
    const { gateway, platform, state } = setup();
    await gateway.handle(event({ text: "<@UBOT> look at <https://x.y|this> &amp; that" }));
    const sink = platform.sinkFor("D1");
    await waitFor(() => sink.texts("markdown").includes("echo: look at this (https://x.y) & that"), 5_000, "dm echo");
    assert.equal(state.sessions["dm:U111"]?.channelId, "D1");
    assert.match(state.sessions["dm:U111"]?.sessionFile ?? "", /\.jsonl$/);
  });

  it("asks to bind unbound channels only when addressed", async () => {
    const { gateway, platform } = setup();
    await gateway.handle(event({ channelId: "C1", channelType: "channel", text: "just chatting" }));
    assert.equal(platform.sinkFor("C1").calls.length, 0);
    await gateway.handle(event({ channelId: "C1", channelType: "channel", text: "<@UBOT> hello" }));
    assert.match(platform.sinkFor("C1").texts("notice")[0] ?? "", /isn't bound/);
  });

  it("binds a channel inside the allowed roots and routes messages there", async () => {
    const { gateway, platform, state } = setup();
    const sink = platform.sinkFor("C2");
    await gateway.handle(event({ channelId: "C2", channelType: "channel", text: "!bind /" }));
    assert.match(sink.texts("notice").at(-1) ?? "", /outside the allowed roots/);

    const repo = tempDir("psg-repo-");
    await gateway.handle(event({ channelId: "C2", channelType: "channel", text: `!bind ${repo}` }));
    assert.match(sink.texts("notice").at(-1) ?? "", /Bound this channel/);
    assert.equal(state.channels.C2?.cwd, repo);

    await gateway.handle(event({ channelId: "C2", channelType: "channel", text: "build it" }));
    await waitFor(() => sink.texts("markdown").includes("echo: build it"), 5_000, "channel echo");

    await gateway.handle(event({ channelId: "C2", channelType: "channel", text: "!unbind" }));
    assert.match(sink.texts("notice").at(-1) ?? "", /Unbound/);
    assert.equal(state.channels.C2, undefined);
  });

  it("starts pi for a !bind channel with the default tools", async () => {
    const { gateway, platform } = setup();
    await gateway.handle(event({ channelId: "C4", channelType: "channel", text: `!bind ${tempDir("psg-repo-")}` }));
    assert.match(platform.sinkFor("C4").texts("notice").at(-1) ?? "", /Bound this channel/);
    assert.deepEqual(toolsValues(await argvIn(gateway, platform, "C4")), ["subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls"]);
  });

  it("gives a resumed !bind channel the default tools", async () => {
    const first = setup();
    await first.gateway.handle(event({ channelId: "C5", channelType: "channel", text: `!bind ${tempDir("psg-repo-")}` }));
    await first.gateway.handle(event({ channelId: "C5", channelType: "channel", text: "hi" }));
    await waitFor(() => first.platform.sinkFor("C5").texts("markdown").includes("echo: hi"));
    await first.gateway.shutdown();

    // Persisted state holds only { cwd, boundBy, boundAt }; resumeAll re-resolves the binding.
    const state = new StateStore(first.config.stateDir, quietLog);
    const platform = new FakePlatform();
    const gateway = new Gateway({ config: first.config, state, platform, log: quietLog, env: first.env });
    gateways.push(gateway);
    await gateway.resumeAll();
    const argv = await argvIn(gateway, platform, "C5");
    assert.ok(argv.includes("--session"), "resumed the stored session");
    assert.deepEqual(toolsValues(argv), ["subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls"]);
  });

  it("a static channel binding wins over a stored !bind binding, with its own tools", async () => {
    const { gateway, platform, state } = setup({
      channels: { C6: { cwd: tempDir(), tools: null }, C7: { cwd: tempDir(), tools: "read" } },
    });
    state.bindChannel("C6", tempDir("psg-repo-"), "U111");
    state.bindChannel("C7", tempDir("psg-repo-"), "U111");
    assert.deepEqual(toolsValues(await argvIn(gateway, platform, "C6")), []);
    assert.deepEqual(toolsValues(await argvIn(gateway, platform, "C7")), ["read"]);
  });

  it("downloads attachments and lists their paths in the prompt", async () => {
    const { gateway, platform } = setup();
    await gateway.handle(event({ text: "see file", files: [{ id: "F1", name: "notes.txt", mimeType: "text/plain", size: 10, url: "https://files/x" }] }));
    const sink = platform.sinkFor("D1");
    const echo = await waitFor(() => sink.texts("markdown").find((t) => t.startsWith("echo: see file")), 5_000, "echo");
    assert.equal(platform.downloads.length, 1);
    assert.ok(echo.includes(platform.downloads[0]!), echo);
  });

  it("resumes bindings that have a stored session at startup", async () => {
    const first = setup();
    await first.gateway.handle(event({ text: "remember me" }));
    await waitFor(() => first.platform.sinkFor("D1").texts("markdown").includes("echo: remember me"));
    await first.gateway.shutdown();

    const state = new StateStore(first.config.stateDir, quietLog);
    const platform = new FakePlatform();
    const gateway = new Gateway({ config: first.config, state, platform, log: quietLog, env: first.env });
    gateways.push(gateway);
    await gateway.resumeAll();
    await gateway.handle(event({ text: "!status" }));
    const status = await waitFor(() => platform.sinkFor("D1").texts("notice").find((t) => t.includes("*Session*")), 5_000, "status");
    const file = state.sessions["dm:U111"]?.sessionFile ?? "";
    assert.ok(file && status.includes(file.replace(/.*\//, "").slice(0, 8)), status);
  });
});
