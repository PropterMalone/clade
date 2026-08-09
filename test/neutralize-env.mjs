// Preloaded via `node --test --import` before any test module is evaluated.
//
// Shells freeze dataPath() into module-scope consts, so merely IMPORTING one
// resolves the data root — env read, existence check, possible throw. That makes
// the suite sensitive to the operator's ambient environment, and the documented
// private-instance workflow is to export CLADE_DATA_DIR pointing at their real
// address book. Two consequences, both observed 2026-08-09:
//
//   - `CLADE_DATA_DIR=/nonexistent npm test` → 6 failures at import time, none
//     of them near the code under test.
//   - With a VALID ambient value, importing a shell resolved against the
//     operator's real data dir, and any test that spawns a shell without pinning
//     env would operate on their real contacts.
//
// Tests that need a data root create their own tmpdir and pass it explicitly.
delete process.env.CLADE_DATA_DIR
