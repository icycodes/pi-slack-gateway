import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTool, formatDuration, messageText, parseSubagentSnapshot, slackToPlain, splitMarkdown } from "../src/format.ts";

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
