#!/usr/bin/env node
// Test adapter: a plain failure (non-75 non-zero exit).
process.stderr.write('adapter boom\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(1))
