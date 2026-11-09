import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BindingSession } from "../src/session.ts";
import { FakeSink, quietLog, tempDir, testConfig, testEnv, waitFor } from "./helpers.ts";

const sessions: BindingSession[] = [];

function makeSession(overrides: { sessionFile?: string; onSessionFile?: (f?: string) => void } = {}) {
  const sink = new FakeSink();
  const files: (string | undefined)[] = [];
  const session = new BindingSession({
    key: "ch:CTEST",
    label: "slack #test",
    binding: { cwd: tempDir() },
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
    await session.handleMessage(msg("!nope", "1.0004"));
    await waitFor(() => sink.texts("notice").some((t) => t.includes("Unknown command")));
  });
});
