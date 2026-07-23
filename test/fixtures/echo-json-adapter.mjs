#!/usr/bin/env node
// Test adapter: reads the prompt on stdin, ignores it, prints a fixed enrichment
// JSON block on stdout. Exercises the custom-provider path without a live model.
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  process.stdout.write('```json\n' + JSON.stringify({ marker: 'from-adapter', promptLen: input.length }) + '\n```\n')
  process.exit(0)
})
