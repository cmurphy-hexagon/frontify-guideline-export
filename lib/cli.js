const { VALID_STRUCTURES, VALID_OUTPUT_MODES } = require('./constants');
const { exitWithError } = require('./errors');
const { validateGuidelineIdOrExit } = require('./guideline-id');

function parsePositiveInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    exitWithError(`Error: ${flagName} must be a positive integer.`);
  }
  return parsed;
}

function printHelp() {
  console.log(`
Frontify Guideline Export Tool

Usage:
  node export-guideline.js (--guideline <ID> | --guideline-n <N> | --guideline-name "<name>") --domain <DOMAIN> --output <NAME> [--token <TOKEN>] [--structure <flat|by-document>] [--output-mode <split|combined|both>] [--probe] [--skip-download] [--dry-run] [--max-libraries <N>] [--max-assets-per-library <N>]

Guideline selection (one required):
  --guideline      Full base64 node ID (explicit override)
  --guideline-n    Numeric identifier N; constructs the base64 ID for you
  --guideline-name Guideline name; searches identifiers 1-200 to find it

Options:
  --token        Frontify API bearer token (or set FRONTIFY_TOKEN env var)
  --domain       Frontify domain, for example "weare.frontify.com" (required)
  --output       Output subfolder name under ./output/ (required)
  --structure    Output organization: flat or by-document (default: flat)
  --output-mode  Output files to write: split, combined, or both (default: split)
  --combine      Backward-compatible alias for --output-mode both
  --probe        Test GraphQL connectivity/auth first, then continue export
  --skip-download  Do not download asset files (metadata markdown only)
  --dry-run      Fetch summary only; do not write files or download assets
  --max-libraries  Limit number of libraries to export (debug helper)
  --max-assets-per-library  Limit assets fetched per library (debug helper)
  --help         Show this help message

Examples:
  node export-guideline.js --guideline-n 6 --domain brand.octave.com --output octave-flat
  node export-guideline.js --guideline-name "Octave" --domain brand.octave.com --output octave-docs --structure by-document
  node export-guideline.js --guideline <ID> --domain brand.octave.com --output octave-ai --structure by-document --output-mode both --probe
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = argv;
  const parsed = {
    structure: 'flat',
    outputMode: 'split',
    probe: false,
    skipDownload: false,
    dryRun: false
  };

  const nextValueOrError = (index, flagName) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      exitWithError(`Error: ${flagName} requires a value.`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token') {
      parsed.token = nextValueOrError(i, '--token');
      i++;
    } else if (args[i] === '--guideline') {
      parsed.guidelineId = nextValueOrError(i, '--guideline');
      i++;
    } else if (args[i] === '--guideline-n') {
      parsed.guidelineN = parsePositiveInt(nextValueOrError(i, '--guideline-n'), '--guideline-n');
      i++;
    } else if (args[i] === '--guideline-name') {
      parsed.guidelineName = nextValueOrError(i, '--guideline-name');
      i++;
    } else if (args[i] === '--output') {
      parsed.outputName = nextValueOrError(i, '--output');
      i++;
    } else if (args[i] === '--domain') {
      parsed.domain = nextValueOrError(i, '--domain');
      i++;
    } else if (args[i] === '--structure') {
      parsed.structure = String(nextValueOrError(i, '--structure')).toLowerCase();
      i++;
    } else if (args[i] === '--output-mode') {
      parsed.outputMode = String(nextValueOrError(i, '--output-mode')).toLowerCase();
      i++;
    } else if (args[i] === '--combine') {
      parsed.outputMode = 'both';
    } else if (args[i] === '--probe') {
      parsed.probe = true;
    } else if (args[i] === '--skip-download') {
      parsed.skipDownload = true;
    } else if (args[i] === '--dry-run') {
      parsed.dryRun = true;
    } else if (args[i] === '--max-libraries') {
      parsed.maxLibraries = parsePositiveInt(nextValueOrError(i, '--max-libraries'), '--max-libraries');
      i++;
    } else if (args[i] === '--max-assets-per-library') {
      parsed.maxAssetsPerLibrary = parsePositiveInt(nextValueOrError(i, '--max-assets-per-library'), '--max-assets-per-library');
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else if (String(args[i]).startsWith('--')) {
      exitWithError(`Error: unknown option ${args[i]}. Use --help to see valid options.`);
    } else {
      exitWithError(`Error: unexpected argument ${args[i]}. Use --help to see usage.`);
    }
  }

  if (!parsed.token && process.env.FRONTIFY_TOKEN) {
    parsed.token = process.env.FRONTIFY_TOKEN;
  }

  if (!parsed.token) {
    exitWithError('Error: --token is required (or set FRONTIFY_TOKEN environment variable).');
  }

  const selectorCount = [
    Boolean(parsed.guidelineId),
    parsed.guidelineN !== undefined,
    Boolean(parsed.guidelineName)
  ].filter(Boolean).length;

  if (selectorCount === 0) {
    exitWithError('Error: specify one of --guideline <ID>, --guideline-n <N>, or --guideline-name "<name>".');
  }
  if (selectorCount > 1) {
    exitWithError('Error: use only one of --guideline, --guideline-n, or --guideline-name.');
  }
  if (parsed.guidelineName && !String(parsed.guidelineName).trim()) {
    exitWithError('Error: --guideline-name cannot be empty.');
  }
  if (parsed.guidelineId) {
    validateGuidelineIdOrExit(parsed.guidelineId);
  }
  if (!parsed.domain) {
    exitWithError('Error: --domain is required (for example: weare.frontify.com).');
  }
  if (!parsed.outputName) {
    exitWithError('Error: --output is required (name for the output subfolder).');
  }
  if (!VALID_STRUCTURES.has(parsed.structure)) {
    exitWithError('Error: --structure must be one of: flat, by-document.');
  }
  if (!VALID_OUTPUT_MODES.has(parsed.outputMode)) {
    exitWithError('Error: --output-mode must be one of: split, combined, both.');
  }

  parsed.domain = parsed.domain
    .replace(/^https?:\/\//, '')
    .replace(/\/graphql$/, '')
    .replace(/\/$/, '');

  return parsed;
}

module.exports = {
  parseArgs,
  printHelp,
  parsePositiveInt
};
