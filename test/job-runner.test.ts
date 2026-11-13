import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const agentFile = join(root, "agents", "job-runner.md");
const agentSource = readFileSync(agentFile, "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  "pi-subagents"?: { agents?: string[] };
};

function frontmatterAndBody(source: string): { frontmatter: string; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "agents/job-runner.md has a --- frontmatter block");
  return { frontmatter: match[1]!, body: match[2]!.trim() };
}

/** The `- |` literal block that follows `- -c` under `runner.args`, dedented. */
function runnerScript(frontmatter: string): string {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line, i) => line.trim() === "- |" && lines[i - 1]?.trim() === "- -c");
  assert.ok(start > 0, "runner.args is [-c, <literal block>]");
  const indent = lines[start]!.search(/\S/) + 2;
  const script: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    script.push(line.slice(indent));
  }
  return script.join("\n");
}

const { frontmatter, body } = frontmatterAndBody(agentSource);
const script = runnerScript(frontmatter);

const jobTmp = mkdtempSync(join(tmpdir(), "job-runner-test-"));
after(() => rmSync(jobTmp, { recursive: true, force: true }));

/** Runs the agent's script the way pi-subagents' external-cli runner does: prompt on stdin. */
function runJob(task: string) {
  // Same layout as pi-subagents' buildExternalCliPrompt(systemInstructions, task).
  const prompt = `<System instructions>\n${body}\n\n<Task>\n${task}`;
  return spawnSync("/bin/bash", ["-c", script], {
    input: prompt,
    cwd: jobTmp,
    env: { ...process.env, TMPDIR: jobTmp },
    encoding: "utf8",
  });
}

describe("job-runner agent packaging", () => {
  it("ships the agents directory and declares it for pi-subagents discovery", () => {
    assert.ok(pkg.files.includes("agents"));
    const dirs = pkg["pi-subagents"]?.agents;
    assert.deepEqual(dirs, ["./agents"]);
    for (const dir of dirs!) assert.ok(statSync(join(root, dir)).isDirectory(), `${dir} exists`);
    assert.ok(existsSync(agentFile));
  });

  it("is a model-free external-cli agent with a self-contained bash script", () => {
    assert.match(frontmatter, /^name: job-runner$/m);
    assert.match(frontmatter, /^description: \S/m);
    assert.match(frontmatter, /^runner:\n {2}type: external-cli$/m);
    assert.match(frontmatter, /^ {2}command: \/bin\/bash$/m);
    assert.match(frontmatter, /^ {2}promptDelivery: stdin$/m);
    assert.match(frontmatter, /^async: true$/m);
    assert.match(frontmatter, /^timeoutMs: \d+$/m);
    assert.match(frontmatter, /^timeoutMs: 2147483647$/m);
    // pi-subagents rejects Pi-only fields such as model/tools on external-cli agents.
    assert.doesNotMatch(frontmatter, /^(model|tools|thinking):/m);
    assert.match(script, /JOB_CMD:/);
    assert.match(script, /exit "\$code"/);
    // No dependency on a file outside the agent definition.
    assert.doesNotMatch(script, /monitor-probe|\.sh\b/);
  });

  it("sets timeoutMs to the largest value pi-subagents accepts", () => {
    // Without the line, async runs fall back to pi-subagents' 30-minute default. A value above
    // 2147483647 (the Node.js timer limit) still loads, but every launch is then rejected.
    const timeoutMs = Number(frontmatter.match(/^timeoutMs: (\S+)$/m)?.[1]);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "timeoutMs is a positive integer");
    assert.ok(timeoutMs <= 2_147_483_647, "timeoutMs does not exceed the timer limit");
    assert.equal(timeoutMs, 2_147_483_647);
  });

  it("keeps the script parseable by pi-subagents' frontmatter reader", () => {
    // That reader drops lines starting with '#' inside nested blocks, so the script must have none.
    for (const line of script.split("\n")) assert.ok(!line.trim().startsWith("#"), `comment line: ${line}`);
  });

  it("has no JOB_CMD line in its body, which precedes the task on stdin", () => {
    assert.doesNotMatch(body, /^\s*JOB_CMD:/m);
  });
});

describe("job-runner script", () => {
  it("runs the JOB_CMD line and reports success", () => {
    const r = runJob("Run the job.\nJOB_CMD: echo hello; echo world\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^JOB_CMD: echo hello; echo world$/m);
    assert.match(r.stdout, /^JOB_START: \S+$/m);
    assert.match(r.stdout, /^JOB_END: \S+$/m);
    assert.match(r.stdout, /^JOB_EXIT_CODE=0$/m);
    assert.match(r.stdout, /^hello\nworld$/m);
    const out = r.stdout.match(/^JOB_OUTPUT: (.+)$/m)?.[1] ?? "";
    assert.ok(out.startsWith(join(jobTmp, "pi-job-runner")), out);
    assert.equal(readFileSync(out, "utf8"), "hello\nworld\n");
  });

  it("exits with the command's non-zero exit code and repeats the summary on stderr", () => {
    const r = runJob("JOB_CMD: echo failing; exit 7");
    assert.equal(r.status, 7);
    assert.match(r.stdout, /^JOB_EXIT_CODE=7$/m);
    assert.match(r.stderr, /^JOB_EXIT_CODE=7$/m);
    assert.match(r.stderr, /^failing$/m);
  });

  it("uses only the first JOB_CMD line", () => {
    const r = runJob("JOB_CMD: exit 3\nJOB_CMD: exit 0");
    assert.equal(r.status, 3);
  });

  it("fails with 64 when the task has no JOB_CMD line", () => {
    const r = runJob("no command here");
    assert.equal(r.status, 64);
    assert.match(r.stderr, /no 'JOB_CMD: <command>' line/);
  });
});

describe("manager prompt monitoring section", () => {
  const prompt = readFileSync(join(root, "prompts", "manager.md"), "utf8");
  const section = prompt.slice(prompt.indexOf("### Monitoring long-running jobs"));

  it("keeps the directives for launching, cleaning up, and the traps", () => {
    assert.ok(prompt.includes("### Monitoring long-running jobs"));
    assert.match(section, /Opt-in/);
    assert.match(section, /subagent\(\{agent:"job-runner", async:true, task:"JOB_CMD: /);
    assert.match(section, /action:"schedule\.create", id:"<job>-tail", args:\{log:"<log>"\}, options:\{every:"10m", script:"/);
    // workflow:true with a fenced block failed in a real session; it may be mentioned only as the fallback to avoid.
    assert.doesNotMatch(section, /schedule\.create"[^\n]*workflow:true/);
    assert.doesNotMatch(section, /```js workflow\n/);
    assert.match(section, /action:"schedule\.delete", id:"<job>-tail"/);
    assert.match(section, /model child that uses `bash`/);
    assert.match(section, /restart the gateway/);
    assert.match(section, /no observed activity for 60s/);
    assert.match(section, /not a user-facing event: do not reply to it or post about it/);
    assert.match(section, /channel root/);
    assert.match(section, /2147483647 ms/);
    assert.match(section, /options:\{timeoutMs:<ms>\}/);
    assert.match(section, /hung job is not killed automatically/);
    assert.match(section, /action:"status", id:/);
    assert.doesNotMatch(section, /2 hours/);
    // The package agent resolves from any cwd; project-local agents and probe paths are gone.
    assert.doesNotMatch(section, /\.pi\/agents|\.pi\/workflows|monitor-probe/);
  });

  it("passes a tail script as options.script that runs job-runner on args.log", () => {
    const literal = section.match(/options:\{every:"10m", script:("(?:[^"\\]|\\.)*")\}/)?.[1];
    assert.ok(literal, "has an options.script string literal");
    const script: string = JSON.parse(literal);
    const calls: [string, { agent: string; cwd: string; task: string }][] = [];
    const runs = { run: (key: string, params: { agent: string; cwd: string; task: string }) => calls.push([key, params]) };
    new Function("runs", "args", script)(runs, Object.freeze({ log: "/var/log/job.log" }));
    assert.equal(calls.length, 1);
    const [key, params] = calls[0]!;
    assert.equal(key, "tail");
    assert.equal(params.agent, "job-runner");
    assert.equal(params.cwd, "<dir>");
    assert.match(params.task, /^JOB_CMD: .*tail -n 3 \/var\/log\/job\.log$/);
  });
});
