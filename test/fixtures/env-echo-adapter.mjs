#!/usr/bin/env node
// Test adapter: echoes the model hint it received via CLADE_AGENT_MODEL, so the
// test can assert model precedence/injection. Also proves the env is MINIMAL by
// reporting whether a planted secret leaked through.
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  process.stdout.write('```json\n' + JSON.stringify({
    gotModel: process.env.CLADE_AGENT_MODEL || null,
    sawSecret: process.env.CLADE_TEST_SECRET || null,
  }) + '\n```\n')
  process.exit(0)
})
