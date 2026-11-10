import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";

const base = { allowedUsers: ["U111"], allowedRoots: [tmpdir()] };

describe("parseConfig bindings", () => {
  it("parses tools from a binding object", () => {
    const config = parseConfig({
      ...base,
      dm: { cwd: tmpdir(), tools: "subagent,read,grep,find,ls" },
      channels: { C123: { cwd: tmpdir(), tools: "subagent,read" }, C456: tmpdir() },
    });
    assert.equal(config.dm.tools, "subagent,read,grep,find,ls");
    assert.equal(config.channels.C123!.tools, "subagent,read");
    assert.equal(config.channels.C456!.tools, undefined);
  });

  it("rejects a non-string tools value", () => {
    assert.throws(() => parseConfig({ ...base, channels: { C123: { cwd: tmpdir(), tools: ["read"] } } }), /channels\.C123\.tools must be a string/);
  });
});
