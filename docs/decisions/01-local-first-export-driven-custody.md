---
id: 01-local-first-export-driven-custody
name: Local-first, export-driven custody
date: 2026-07-17
status: active
supersedes: null
commits: [9c180e7]
---

# Local-first, export-driven custody

**Decision**: Clade never OAuths into a user's live accounts. It ingests platform *data exports* (LinkedIn/Facebook/Google Takeout/Twitter archives) that the user requests and drops in `imports/`. All data lives in the user's own repo/machine; the only network egress is per-contact web-search queries during enrichment (one person's public identity at a time).

**Why**: This is the load-bearing bet that defines Clade against the funded incumbents (Happenstance, and the broader relationship-intelligence market — all cloud/OAuth). Server-side OAuth forces custody of the user's whole social graph, plus Google's mandatory annual CASA security assessment and Limited-Use restrictions for any app touching Gmail restricted scopes. Export-driven sidesteps all of it: no server, no custody, no compliance surface, and zero marginal cost because enrichment runs on the user's own Claude subscription. It's also the only path that works for a personal/hobby tool a friend can self-host. (LinkedIn's API forbids pulling connections anyway — even Happenstance uses export upload for that source — so export-first isn't a compromise, it's the sane path.)

**Rejected alternative**: Cloud OAuth aggregation (the Happenstance model). Dropped because it converts a weekend favor into a funded startup: server hosting, SOC-2/CASA, per-seat billing, and holding other people's mailboxes. All cost, no benefit for the actual goal (enrich the owner's own contacts).

**Could-be-wrong-if**: enrichment quality proves to depend on *live* signal that a point-in-time export can't provide — e.g. if >30% of a real user's high-value contacts are unresolvable from an export but trivially resolvable from live API data. Check by comparing resolution rates on the same contact set via export vs. a live-connected tool. Threshold: if export-driven caps resolution materially below live, the local-first thesis needs a live-refresh escape hatch.

**How to apply**: Any feature that would require holding a persistent OAuth token to a user's live account is out of scope by default. Ingest is always "parse what's in `imports/`." The exception already carved out (live Bluesky public-API reads) works only because it needs no auth and no PII custody — new "live source" proposals must clear that same bar.
