#!/bin/sh
# PreToolUse guard: block git commits that bypass signing (AGENTS.md rule 1).
input=$(cat)
command=$(printf '%s' "$input" | python -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))' 2>/dev/null)

case "$command" in
  *"git commit"*)
    if printf '%s' "$command" | grep -qiE -- '--no-gpg-sign|gpg-sign=false|gpgsign=false'; then
      printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AGENTS.md rule: commits must be signed. Do not bypass signing with --no-gpg-sign or -c commit.gpgsign=false."}}'
      exit 0
    fi
    ;;
esac
exit 0
