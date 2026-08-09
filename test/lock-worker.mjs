// Test helper (not a test file — the runner globs *.test.mjs).
// Drives updateJsonFile in a tight loop so several of these racing each other
// produce SUSTAINED contention. Spawning one-shot CLIs does not: ~50ms of node
// startup jitter staggers the acquisitions, so the narrow window inside the lock
// acquisition almost never gets hit, and a broken lock still passes.
//
//   node test/lock-worker.mjs <target.json> <workerId> <iterations>
//
// Each iteration adds one uniquely-named key. With W workers × C iterations the
// file must end with exactly W×C keys; anything fewer is a lost update.

import { updateJsonFile } from '../scripts/overlay-write.mjs'

const [target, idStr, countStr] = process.argv.slice(2)
const id = Number(idStr)
const count = Number(countStr)

for (let i = 0; i < count; i++) {
  updateJsonFile(
    target,
    (current) => {
      current[`w${id}-i${i}`] = true
      return current
    },
    {},
  )
}
