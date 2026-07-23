#!/usr/bin/env node
// Test adapter: signals a rate-limit/retryable condition via EX_TEMPFAIL (75).
process.stdin.resume()
process.stdin.on('end', () => process.exit(75))
