import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { DEFAULT_TOOLS, parseConfig } from "../src/config.ts";

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
    assert.equal(config.channels.C456!.tools, DEFAULT_TOOLS);
  });

  it("defaults tools to the manager allowlist for dm and static channels", () => {
    assert.equal(DEFAULT_TOOLS, "subagent,subagent_supervisor,contact_supervisor,bg_wait,read,grep,find,ls");
    const config = parseConfig({ ...base, dm: { cwd: tmpdir() }, channels: { C123: { cwd: tmpdir() }, C456: tmpdir() } });
    assert.equal(config.dm.tools, DEFAULT_TOOLS);
    assert.equal(config.channels.C123!.tools, DEFAULT_TOOLS);
    assert.equal(config.channels.C456!.tools, DEFAULT_TOOLS);
    assert.equal(parseConfig(base).dm.tools, DEFAULT_TOOLS);
  });

  it("default allowlist keeps the supervisor reply tool and excludes inline work tools", () => {
    const tools = DEFAULT_TOOLS.split(",");
    for (const name of ["subagent", "subagent_supervisor", "contact_supervisor", "bg_wait"]) assert.ok(tools.includes(name), name);
    for (const name of ["bash", "edit", "write"]) assert.ok(!tools.includes(name), name);
  });

  it("lets an explicit tools string override the default", () => {
    const config = parseConfig({ ...base, dm: { cwd: tmpdir(), tools: "read" } });
    assert.equal(config.dm.tools, "read");
  });

  it("treats tools null or empty as opting out to pi's default tools", () => {
    const config = parseConfig({
      ...base,
      dm: { cwd: tmpdir(), tools: null },
      channels: { C123: { cwd: tmpdir(), tools: "" }, C456: { cwd: tmpdir(), tools: "  " } },
    });
    assert.equal(config.dm.tools, undefined);
    assert.equal(config.channels.C123!.tools, undefined);
    assert.equal(config.channels.C456!.tools, undefined);
  });

  it("rejects a non-string tools value", () => {
    assert.throws(() => parseConfig({ ...base, channels: { C123: { cwd: tmpdir(), tools: ["read"] } } }), /channels\.C123\.tools must be a string/);
  });
});
