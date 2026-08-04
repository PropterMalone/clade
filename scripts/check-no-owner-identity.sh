#!/usr/bin/env bash
# Hard gate: this is a PUBLIC, pseudonymously-published repo. The owner's real
# identity must never land in it (a leak in public git history is not reliably
# reversible — forks and caches keep it). This scans tracked content for the
# owner's identifiers and fails loudly if any appears.
#
# Run manually:  bash scripts/check-no-owner-identity.sh
# Installed as a pre-push hook (see README) it blocks the push.
#
# THE PATTERN LIVES OUTSIDE TRACKED CONTENT, DELIBERATELY. An earlier version of
# this script hard-coded it here — which published the exact string the gate
# exists to suppress, in the one file a reader would open first, and the gate
# could never catch it because it excludes itself from its own scan. A deny-list
# is not infrastructure; it is a mapping table, and it belongs next to the data
# it protects, not next to the release. (angel privacy review, 2026-08-04.)
#
# Supply the pattern one of two ways:
#   1. CLADE_OWNER_PATTERN='name|/home/name'   (env var; good for CI)
#   2. .owner-pattern in the repo root         (gitignored; one ERE per file)
# With neither present the gate WARNS AND PASSES, so a fresh clone by an adopter
# who has not configured it yet is not blocked by a check that cannot know what
# to look for.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

OWNER_PATTERN="${CLADE_OWNER_PATTERN:-}"
if [ -z "$OWNER_PATTERN" ] && [ -f .owner-pattern ]; then
  OWNER_PATTERN=$(grep -v '^[[:space:]]*#' .owner-pattern | grep -v '^[[:space:]]*$' | head -1)
fi

if [ -z "$OWNER_PATTERN" ]; then
  echo "WARNING: pseudonymity gate not configured — nothing scanned." >&2
  echo "Set CLADE_OWNER_PATTERN or create .owner-pattern (gitignored) with an" >&2
  echo "extended-regex of the identifiers that must never be published." >&2
  exit 0
fi

hits=$(git ls-files | xargs -r grep -niE "$OWNER_PATTERN" 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "BLOCKED: owner identity found in tracked content of a public repo." >&2
  echo "$hits" >&2
  echo "" >&2
  echo "Strip the identifier(s) above before committing/pushing. This is the" >&2
  echo "pseudonymity gate — do not bypass without deliberate reason." >&2
  exit 1
fi

echo "clean: no owner identity in tracked content."
