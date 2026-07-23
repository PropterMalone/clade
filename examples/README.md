# Example fixtures

Synthetic data showing the shapes from `docs/schema.md` and exercising each
merge path. To see the pipeline work without any real data:

```
cp examples/normalized-*.json contacts/normalized/
cp examples/attested.json examples/merge-decisions.json contacts/
node scripts/build-index.mjs
node search.mjs --stats
```

Rename the copies to drop the `normalized-` prefix if you like — the `source`
field inside the file is what matters, not the filename.

What the fixtures demonstrate:

- **Jane Wilson** becomes one three-source person: linkedin + gmail merge on
  shared email (strong identifier), and facebook's name-only "Jane Wilson"
  joins via the exact-unique-name rule (exact multi-token name, only one Jane
  Wilson per source, no employer conflict).
- **John Smith** shows the uniqueness gate: facebook has TWO John Smiths, so
  neither auto-merges with linkedin's John Smith. One pair is pre-ruled
  `different` in `merge-decisions.json` (stays suppressed); the other lands in
  `contacts/merge-candidates.json` for a human ruling.
- **Priya Raman** (linkedin + gmail) auto-merges on near-exact name + shared
  employer.
- **Mike Delgado** (facebook-only, no web presence) carries user-attested
  facts from `attested.json` — searchable via `node search.mjs roommate` or
  `--domain "craft brewing"`, confidence `attested`.

Clean up after: `rm contacts/normalized/normalized-*.json contacts/attested.json contacts/merge-decisions.json contacts/unified-index.json contacts/merge-candidates.json`
