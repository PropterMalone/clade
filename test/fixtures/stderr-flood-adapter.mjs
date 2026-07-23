#!/usr/bin/env node
// Test adapter: floods stderr (not stdout) to exercise the stderr maxBuffer cap.
process.stdin.resume()
const chunk = 'x'.repeat(4096)
const t = setInterval(() => process.stderr.write(chunk), 1)
process.stdin.on('end', () => {})
setTimeout(() => clearInterval(t), 8000)
