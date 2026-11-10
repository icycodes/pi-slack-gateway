import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BindingOptions } from "../src/config.ts";
import { BindingSession, formatCostLine } from "../src/session.ts";
import { FakeSink, quietLog, tempDir, testConfig, testEnv, waitFor } from "./helpers.ts";

const sessions: BindingSession[] = [];

function makeSession(overrides: { sessionFile?: string; onSessionFile?: (f?: string) => void; cwd?: string; tools?: string; binding?: BindingOptions } = {}) {
  const sink = new FakeSink();
  const files: (string | undefined)[] = [];
  const session = new BindingSession({
    key: "ch:CTEST",
    label: "slack #test",
    binding: overrides.binding ?? { cwd: overrides.cwd ?? tempDir(), ...(overrides.tools ? { tools: overrides.tools } : {}) },
    config: testConfig(),
    sink,
    sessionFile: overrides.sessionFile,
    onSessionFile: (f) => {
      files.push(f);
      overrides.onSessionFile?.(f);
    },
    env: testEnv(),
    log: quietLog,
    restartBackoffMs: () => 20,
  });
  sessions.push(session);
  return { session, sink, files };
}

const msg = (text: string, ts = "1.0001", threadTs?: string) => ({ userId: "U111", text, ts, threadTs });

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
});

describe("BindingSession", () => {
  it("prompts pi, posts the answer, and manages the ack reaction", async () => {
    const { session, sink, files } = makeSession();
    await session.handleMessage(msg("hello"));
    await waitFor(() => sink.texts("markdown").includes("echo: hello"), 5_000, "echo");
    await waitFor(() => sink.calls.some((c) => c.kind === "unreact" && c.ts === "1.0001" && c.emoji === "eyes"), 5_000, "unreact");
    assert.ok(sink.calls.some((c) => c.kind === "react" && c.ts === "1.0001" && c.emoji === "eyes"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /\.jsonl$/);
  });

  it("answers in the thread the user wrote in", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("in thread", "2.0001", "2.0000"));
    const call = await waitFor(() => sink.calls.find((c) => c.kind === "markdown" && c.text === "echo: in thread"));
    assert.equal(call.kind === "markdown" && call.threadTs, "2.0000");
  });

  it("shows a live status message during long runs and removes it afterwards", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("slow"));
    const status = await waitFor(() => sink.calls.find((c) => c.kind === "notice" && c.text.includes("working")), 5_000, "status");
    await waitFor(() => sink.texts("markdown").includes("done slow"), 5_000, "final");
    await waitFor(() => sink.calls.some((c) => c.kind === "remove" && c.ts === status.ts), 5_000, "status removal");
    assert.ok(!sink.texts("markdown").includes("working on it"), "interim toolUse text must not be posted as a reply");
  });

  it("marks read-only tool calls as inspection and bash as inline work in the status", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("inspect"));
    await waitFor(() => sink.calls.some((c) => (c.kind === "notice" || c.kind === "update") && c.text.includes(":mag: read `src/config.ts`")), 5_000, "inspection status");
    await waitFor(() => sink.texts("markdown").includes("done inspect"), 5_000, "final");
    await session.handleMessage(msg("slow", "1.0002"));
    await waitFor(() => sink.calls.some((c) => (c.kind === "notice" || c.kind === "update") && c.text.includes(":wrench: bash")), 5_000, "work status");
    await waitFor(() => sink.texts("markdown").includes("done slow"), 5_000, "final slow");
  });

  it("passes the binding's tools to pi as a single --tools flag", async () => {
    const { session, sink } = makeSession({ tools: "subagent,read,grep,find,ls" });
    await session.handleMessage(msg("argv"));
    const reply = await waitFor(() => sink.texts("markdown")[0], 5_000, "argv reply");
    const argv = JSON.parse(reply) as string[];
    assert.equal(argv.filter((a) => a === "--tools").length, 1);
    assert.equal(argv[argv.indexOf("--tools") + 1], "subagent,read,grep,find,ls");
  });

  it("does not pass --tools when the binding sets none", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("argv"));
    const reply = await waitFor(() => sink.texts("markdown")[0], 5_000, "argv reply");
    assert.ok(!(JSON.parse(reply) as string[]).includes("--tools"));
  });

  describe("--tools from parsed config bindings", () => {
    const argvFor = async (binding: BindingOptions): Promise<string[]> => {
      const { session, sink } = makeSession({ binding });
      await session.handleMessage(msg("argv"));
      return JSON.parse(await waitFor(() => sink.texts("markdown")[0], 5_000, "argv reply")) as string[];
    };
    const toolsValues = (argv: string[]) => argv.flatMap((a, i) => (a === "--tools" ? [argv[i + 1]] : []));

    it("a dm with only cwd gets the default manager allowlist", async () => {
      const config = testConfig({ dm: { cwd: tempDir() } });
      assert.deepEqual(toolsValues(await argvFor(config.dm)), ["subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls"]);
    });

    it("a static channel with only cwd gets the default manager allowlist", async () => {
      const config = testConfig({ channels: { CTEST: { cwd: tempDir() }, CPLAIN: tempDir() } });
      assert.deepEqual(toolsValues(await argvFor(config.channels.CTEST!)), ["subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls"]);
      assert.deepEqual(toolsValues(await argvFor(config.channels.CPLAIN!)), ["subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls"]);
    });

    it("an explicit tools string wins", async () => {
      const config = testConfig({ channels: { CTEST: { cwd: tempDir(), tools: "read" } } });
      assert.deepEqual(toolsValues(await argvFor(config.channels.CTEST!)), ["read"]);
    });

    it("tools null emits no --tools flag", async () => {
      const config = testConfig({ channels: { CTEST: { cwd: tempDir(), tools: null } } });
      assert.deepEqual(toolsValues(await argvFor(config.channels.CTEST!)), []);
    });

    it("tools empty string emits no --tools flag (never --tools \"\")", async () => {
      const config = testConfig({ channels: { CTEST: { cwd: tempDir(), tools: "" } } });
      const argv = await argvFor(config.channels.CTEST!);
      assert.deepEqual(toolsValues(argv), []);
      assert.ok(!argv.includes(""));
    });
  });

  it("posts provider errors once the run settles", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("fail"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("provider exploded")), 5_000, "error notice");
  });

  it("bridges select dialogs to buttons", async () => {
    const { session, sink } = makeSession();
    await session.handleMessage(msg("ask"));
    const dialog = await waitFor(() => sink.calls.find((c) => c.kind === "buttons"), 5_000, "buttons");
    assert.ok(dialog.kind === "buttons");
    assert.deepEqual(dialog.buttons.map((b) => b.label), ["A", "B", "Cancel"]);
    const value = JSON.parse(dialog.buttons[1]!.value) as { r: string; i: number };
    assert.equal(session.handleDialogAction(value.r, value.i), true);
    await waitFor(() => sink.texts("markdown").includes("chose B"), 5_000, "answer");
    assert.equal(session.handleDialogAction(value.r, value.i), false, "second click is rejected");
  });

  it("restarts pi after a crash and resumes the same session file", async () => {
    const { session, sink, files } = makeSession();
    await session.handleMessage(msg("first"));
    await waitFor(() => sink.texts("markdown").includes("echo: first"));
    await session.handleMessage(msg("crash", "1.0002"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("restarting")), 5_000, "restart notice");
    await waitFor(() => session.alive, 5_000, "respawn");
    await session.handleMessage(msg("again", "1.0003"));
    await waitFor(() => sink.texts("markdown").includes("echo: again"));
    assert.equal(files.length, 1, "session file unchanged across restart");
    const status = await session.statusReport();
    assert.match(status, /Directory/);
  });

  it("uploads files named by [send-file: …] directives and strips them from the reply", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "shot.png"), "png");
    const abs = join(tempDir(), "other file.txt");
    writeFileSync(abs, "txt");
    const { session, sink } = makeSession({ cwd });
    await session.handleMessage(msg(`here\n[send-file: shot.png] The login page\n[send-file: \`${abs}\`]`, "3.0001", "3.0000"));
    await waitFor(() => sink.calls.filter((c) => c.kind === "upload").length === 2, 5_000, "uploads");
    const uploads = sink.calls.filter((c) => c.kind === "upload");
    assert.deepEqual(
      uploads.map((c) => c.kind === "upload" && [c.path, c.caption, c.filename, c.threadTs]),
      [
        [join(cwd, "shot.png"), "The login page", "shot.png", "3.0000"],
        [abs, undefined, "other file.txt", "3.0000"],
      ],
    );
    assert.deepEqual(sink.texts("markdown"), ["echo: here"]);
    assert.ok(sink.calls.findIndex((c) => c.kind === "markdown") < sink.calls.findIndex((c) => c.kind === "upload"), "text is posted before uploads");
  });

  it("reports unsendable files without dropping the reply", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "adir"));
    const { session, sink } = makeSession({ cwd });
    await session.handleMessage(msg("still here\n[send-file: /nonexistent/x.png]\n[send-file: adir]"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("adir")), 5_000, "directory warning");
    assert.deepEqual(sink.texts("markdown"), ["echo: still here"]);
    assert.ok(sink.texts("notice").includes(":warning: could not send /nonexistent/x.png: file not found"));
    assert.ok(sink.texts("notice").includes(":warning: could not send adir: is a directory"));
    assert.ok(!sink.calls.some((c) => c.kind === "upload"));
    assert.ok(session.alive, "session survives failed uploads");
  });

  it("reports Slack upload errors and skips the empty text post", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "shot.png"), "png");
    const { session, sink } = makeSession({ cwd });
    sink.uploadError = new Error("Slack upload failed: missing_scope (grant the files:write scope and reinstall the app)");
    await session.handleMessage(msg("say:[send-file: shot.png]"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("missing_scope")), 5_000, "upload error notice");
    assert.deepEqual(sink.texts("notice").filter((t) => t.startsWith(":warning:")), [
      ":warning: could not send shot.png: Slack upload failed: missing_scope (grant the files:write scope and reinstall the app)",
    ]);
    assert.deepEqual(sink.texts("markdown"), [], "no empty message is posted");
  });

  it("handles !new and !status commands", async () => {
    const { session, sink, files } = makeSession();
    await session.handleMessage(msg("hi"));
    await waitFor(() => sink.texts("markdown").includes("echo: hi"));
    await session.handleMessage(msg("!new", "1.0002"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("new session")));
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
    await session.handleMessage(msg("!status", "1.0003"));
    const status = await waitFor(() => sink.texts("notice").find((t) => t.includes("*Model*")));
    assert.match(status, /test\/fake-model/);
    assert.match(status, /Context\* 1%/);
    assert.ok(status.includes("*Cost* $0.0100 · 42 tokens total"));
    await session.handleMessage(msg("!nope", "1.0004"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("Unknown command")));
  });
});

describe("formatCostLine", () => {
  it("renders a positive cost with 4 decimals and the token total", () => {
    assert.equal(formatCostLine(0.0123, 142_224), "*Cost* $0.0123 · 142,224 tokens total");
  });

  it("reports zero cost with tokens spent as unknown, keeping the token total", () => {
    const line = formatCostLine(0, 142_224);
    assert.equal(line, "*Cost* unknown (no pricing for this model) · 142,224 tokens total");
    assert.ok(!line.includes("$0.0000"));
  });

  it("renders a fresh session with no tokens as $0.0000", () => {
    assert.equal(formatCostLine(0, 0), "*Cost* $0.0000 · 0 tokens total");
  });
});
