#!/usr/bin/env bash
# Hard gate: this is a PUBLIC, pseudonymously-published repo. The owner's real
# identity must never land in it (a leak in public git history is not reliably
# reversible — forks and caches keep it). This scans tracked content for the
# owner's real name and home path and fails loudly if either appears.
#
# Run manually:  bash scripts/check-no-owner-identity.sh
# Installed as a pre-push hook (see below) it blocks the push.
#
# When a NEW instance owner adopts this engine, replace the OWNER_PATTERN below
# with the identifiers that must never be published for them.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Case-insensitive real-name + home-path patterns. Extend per instance owner.
OWNER_PATTERN='karl|/home/karl'
SELF='scripts/check-no-owner-identity.sh'

# Scan every tracked file except this script (which necessarily names the pattern).
hits=$(git ls-files \
  | grep -vF "$SELF" \
  | xargs -r grep -niE "$OWNER_PATTERN" 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "BLOCKED: owner identity found in tracked content of a public repo." >&2
  echo "$hits" >&2
  echo "" >&2
  echo "Strip the identifier(s) above before committing/pushing. This is the" >&2
  echo "pseudonymity gate — do not bypass without deliberate reason." >&2
  exit 1
fi

echo "clean: no owner identity in tracked content."
