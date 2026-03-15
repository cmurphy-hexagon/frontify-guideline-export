#!/usr/bin/env node

const { parseArgs } = require('./lib/cli');
const { exportGuideline } = require('./lib/exporter');

const args = parseArgs();
exportGuideline(args).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nExport failed: ${message}`);
  process.exit(1);
});
