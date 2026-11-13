---
name: job-runner
description: Model-free runner for one long shell command. Put the command on a task line "JOB_CMD: <command>"; it runs via bash, saves the output to a file, and the run fails with the command's exit code. Launch it async to be woken when the job ends. Its default timeout is the maximum (about 24.85 days), so pass options.timeoutMs to bound one job.
runner:
  type: external-cli
  command: /bin/bash
  args:
    - -c
    - |
      set -uo pipefail
      prompt="$(cat)"
      cmd="$(printf '%s\n' "$prompt" | sed -n 's/^[[:space:]]*JOB_CMD:[[:space:]]*//p' | head -n 1)"
      if [[ -z "$cmd" ]]; then
        echo "job-runner: no 'JOB_CMD: <command>' line in task" >&2
        exit 64
      fi
      dir="${TMPDIR:-/tmp}/pi-job-runner"
      mkdir -p "$dir" || exit 70
      out="$dir/job-$(date -u +%Y%m%dT%H%M%SZ)-$$.out"
      start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      bash -c "$cmd" > "$out" 2>&1
      code=$?
      end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      summary="$(printf 'JOB_CMD: %s\nJOB_START: %s\nJOB_END: %s\nJOB_EXIT_CODE=%s\nJOB_OUTPUT: %s\n--- last 15 lines ---\n%s\n' "$cmd" "$start" "$end" "$code" "$out" "$(tail -n 15 "$out")")"
      printf '%s\n' "$summary"
      if [[ "$code" -ne 0 ]]; then printf '%s\n' "$summary" >&2; fi
      exit "$code"
  promptDelivery: stdin
async: true
timeoutMs: 2147483647
---
Runs one shell command without a model. The task must contain a line that starts with the marker "JOB_CMD:" followed by the command.
