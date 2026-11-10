import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTool, formatDuration, messageText, parseSendFileDirectives, parseSubagentSnapshot, slackToPlain, splitMarkdown } from "../src/format.ts";

describe("splitMarkdown", () => {
  it("returns short text unchanged", () => {
    assert.deepEqual(splitMarkdown("hello", 100), ["hello"]);
  });

  it("splits on line boundaries within the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMarkdown(text, 100);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 100, `chunk too long: ${c.length}`);
    assert.equal(chunks.join("\n"), text);
  });

  it("keeps code fences balanced across chunks", () => {
    const body = Array.from({ length: 40 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `intro\n\`\`\`ts\n${body}\n\`\`\`\noutro`;
    const chunks = splitMarkdown(text, 200);
    assert.ok(chunks.length > 2);
    for (const c of chunks) {
      assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
      const fences = c.split("\n").filter((l) => l.trim().startsWith("```")).length;
      assert.equal(fences % 2, 0, `unbalanced fences in:\n${c}`);
    }
    assert.ok(chunks[1]!.startsWith("```ts"));
    assert.ok(chunks.at(-1)!.endsWith("outro"));
  });

  it("hard-wraps a single overlong line", () => {
    const chunks = splitMarkdown("x".repeat(1000), 300);
    assert.ok(chunks.every((c) => c.length <= 300));
    assert.equal(chunks.join(""), "x".repeat(1000));
  });
});

describe("slackToPlain", () => {
  it("decodes links, mentions, channels and entities", () => {
    assert.equal(
      slackToPlain("see <https://a.b/c|docs> and <https://x.y> cc <@U123> in <#C42|dev> &lt;tag&gt; &amp; <mailto:a@b.c|a@b.c>"),
      "see docs (https://a.b/c) and https://x.y cc @U123 in #dev <tag> & a@b.c",
    );
  });
});

describe("describeTool", () => {
  it("summarizes common tools", () => {
    assert.equal(describeTool("bash", { command: "npm test -- --watch=false" }), "bash `npm test -- --watch=false`");
    assert.equal(describeTool("edit", { path: "src/a.ts" }), "edit `src/a.ts`");
    assert.equal(describeTool("subagent", { agent: "worker", task: "x" }), "subagent `worker`");
    assert.equal(describeTool("custom_tool", {}), "custom_tool");
  });
});

describe("parseSubagentSnapshot", () => {
  it("parses pi-subagents widget payloads", () => {
    const payload = { kind: "pi-subagents.async-status-snapshot", runs: [{ id: "abcdef123456", label: "delegate", state: "running", startedAt: 1 }] };
    const runs = parseSubagentSnapshot([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`]);
    assert.deepEqual(runs, [{ id: "abcdef123456", label: "delegate", state: "running", startedAt: 1, updatedAt: undefined }]);
    assert.equal(parseSubagentSnapshot(["plain widget line"]), null);
    assert.equal(parseSubagentSnapshot(undefined), null);
  });
});

describe("misc", () => {
  it("formats durations", () => {
    assert.equal(formatDuration(5_000), "5s");
    assert.equal(formatDuration(125_000), "2m05s");
    assert.equal(formatDuration(3_720_000), "1h02m");
  });

  it("extracts assistant text", () => {
    assert.equal(
      messageText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] }),
      "a\n\nb",
    );
  });
});

describe("parseSendFileDirectives", () => {
  it("returns text unchanged when there are no directives", () => {
    const text = "  hello\n\nworld  ";
    assert.deepEqual(parseSendFileDirectives(text), { files: [], text });
  });

  it("extracts one directive and removes its line", () => {
    assert.deepEqual(parseSendFileDirectives("Here is the page:\n[send-file: /tmp/shot.png]\nLooks fine."), {
      files: [{ path: "/tmp/shot.png" }],
      text: "Here is the page:\nLooks fine.",
    });
  });

  it("handles multiple directives in order", () => {
    const r = parseSendFileDirectives("[send-file: /a.png]\ntwo shots\n  [send-file: ~/b.png]");
    assert.deepEqual(r.files, [{ path: "/a.png" }, { path: "~/b.png" }]);
    assert.equal(r.text, "two shots");
  });

  it("captures an optional caption", () => {
    assert.deepEqual(parseSendFileDirectives("[send-file: /tmp/shot.png] Login page after the fix").files, [
      { path: "/tmp/shot.png", caption: "Login page after the fix" },
    ]);
  });

  it("strips backticks around the path", () => {
    assert.deepEqual(parseSendFileDirectives("[send-file: `/tmp/shot.png`]").files, [{ path: "/tmp/shot.png" }]);
  });

  it("keeps spaces inside the path", () => {
    assert.deepEqual(parseSendFileDirectives("[send-file: /tmp/my shots/page 1.png] caption").files, [
      { path: "/tmp/my shots/page 1.png", caption: "caption" },
    ]);
  });

  it("only matches directives at the start of a line", () => {
    const text = "See [send-file: /tmp/x.png] for details";
    assert.deepEqual(parseSendFileDirectives(text), { files: [], text });
  });

  it("returns empty text when only directives remain", () => {
    assert.deepEqual(parseSendFileDirectives("\n[send-file: /tmp/x.png]\n\n"), { files: [{ path: "/tmp/x.png" }], text: "" });
  });

  it("does not match an unclosed directive", () => {
    const text = "[send-file: /tmp/x.png is what I would use";
    assert.deepEqual(parseSendFileDirectives(text), { files: [], text });
  });

  it("ignores directives inside fenced code blocks", () => {
    const text = "Syntax:\n```\n[send-file: /path/shot.png]\n```";
    assert.deepEqual(parseSendFileDirectives(text), { files: [], text });
  });
});
