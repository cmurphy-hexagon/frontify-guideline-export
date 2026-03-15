const { exitWithError } = require('./errors');

function printHelp() {
  console.log(`
Frontify Guideline Page Crawler

Crawls every document page in a Frontify hub and exports each page as Markdown.
Uses Playwright to render the full JS/React DOM before extraction.

Authentication:
  Frontify uses SSO (SAML) login. Run with --login first to save a session file,
  then use that session file for headless crawls.

Usage:
  # Step 1: Log in once (opens a visible browser for SSO)
  node export-pages.js --domain <DOMAIN> --hub-path <HUB_PATH> --login
                       [--session-file <PATH>]

  # Step 2: Crawl (uses saved session, suppresses browser window)
  node export-pages.js --domain <DOMAIN> --hub-path <HUB_PATH> --output <NAME>
                       [--session-file <PATH>] [--concurrency <N>] [--timeout <MS>]
                       [--include-prefix <PREFIX>]...
                       [--skip-existing-file]
                       [--dry-run] [--verbose] [--help]

Options:
  --login        Open a browser for SSO login and save session, then exit
  --session-file Path to session state file (default: ./frontify-session.json)
  --token        Frontify bearer token (or set FRONTIFY_TOKEN env var)
                 Only used as a fallback when no session file is present
  --domain       Frontify domain, e.g. "brand.octave.com"  (required)
  --hub-path     URL path to the hub root, e.g. "/hub/2"   (required)
  --output       Output folder name under ./output/         (required unless --login)
  --concurrency  Max pages to crawl in parallel (default: 3)
  --timeout      Per-page navigation timeout in ms (default: 30000)
  --include-prefix
                 Keep only discovered pages whose URL path+hash starts with prefix.
                 Repeatable. Example: --include-prefix /document/6#
  --skip-existing-file
                 Skip page export when target markdown file already exists.
  --dry-run      Discover and list all pages, do not write files
  --verbose      Print extra detail during crawl
  --help         Show this message

Examples:
  node export-pages.js --domain brand.octave.com --hub-path /hub/2 --login
  node export-pages.js --domain brand.octave.com --hub-path /hub/2 --output octave-pages
  node export-pages.js --domain brand.octave.com --hub-path /hub/2 --output octave-pages --include-prefix /document/6#
  node export-pages.js --domain brand.octave.com --hub-path /hub/2 --output octave-pages --skip-existing-file
  node export-pages.js --domain brand.octave.com --hub-path /hub/2 --output octave-pages --dry-run
`);
}

function parsePositiveInt(value, flagName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    exitWithError(`Error: ${flagName} must be a positive integer.`);
  }
  return n;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = argv;
  const parsed = {
    concurrency: 3,
    timeout: 30000,
    dryRun: false,
    verbose: false,
    login: false,
    sessionFile: './frontify-session.json',
    includePrefixes: [],
    skipExistingFile: false,
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
    } else if (args[i] === '--domain') {
      parsed.domain = nextValueOrError(i, '--domain');
      i++;
    } else if (args[i] === '--hub-path') {
      parsed.hubPath = nextValueOrError(i, '--hub-path');
      i++;
    } else if (args[i] === '--output') {
      parsed.outputName = nextValueOrError(i, '--output');
      i++;
    } else if (args[i] === '--concurrency') {
      parsed.concurrency = parsePositiveInt(nextValueOrError(i, '--concurrency'), '--concurrency');
      i++;
    } else if (args[i] === '--timeout') {
      parsed.timeout = parsePositiveInt(nextValueOrError(i, '--timeout'), '--timeout');
      i++;
    } else if (args[i] === '--include-prefix') {
      const raw = nextValueOrError(i, '--include-prefix');
      const values = String(raw)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length === 0) {
        exitWithError('Error: --include-prefix requires at least one non-empty prefix.');
      }
      parsed.includePrefixes.push(...values);
      i++;
    } else if (args[i] === '--skip-existing-file') {
      parsed.skipExistingFile = true;
    } else if (args[i] === '--dry-run') {
      parsed.dryRun = true;
    } else if (args[i] === '--login') {
      parsed.login = true;
    } else if (args[i] === '--session-file') {
      parsed.sessionFile = nextValueOrError(i, '--session-file');
      i++;
    } else if (args[i] === '--verbose') {
      parsed.verbose = true;
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

  if (!parsed.domain) {
    exitWithError('Error: --domain is required (e.g. brand.octave.com).');
  }
  if (!parsed.hubPath) {
    exitWithError('Error: --hub-path is required (e.g. /hub/2).');
  }

  // In login mode we only need domain + hub-path (no output, no token required)
  if (!parsed.login) {
    if (!parsed.outputName) {
      exitWithError('Error: --output is required (or run with --login to set up authentication first).');
    }
    const sessionExists = require('fs').existsSync(parsed.sessionFile);
    if (!sessionExists && !parsed.token) {
      exitWithError(
        `Error: no session file found at ${parsed.sessionFile} and no --token provided.\n` +
        '  Run with --login to authenticate via SSO, or supply --token for bearer token fallback.'
      );
    }
  }

  parsed.domain = parsed.domain
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  parsed.hubPath = parsed.hubPath.startsWith('/')
    ? parsed.hubPath
    : '/' + parsed.hubPath;

  // Normalize include prefixes to path-like values for robust matching.
  parsed.includePrefixes = parsed.includePrefixes
    .map((prefix) => {
      if (/^https?:\/\//i.test(prefix)) {
        try {
          const u = new URL(prefix);
          return `${u.pathname}${u.hash || ''}`;
        } catch (_e) {
          return prefix;
        }
      }
      return prefix;
    })
    .map((prefix) => (prefix.startsWith('/') ? prefix : `/${prefix}`));

  return parsed;
}

module.exports = { parseArgs, printHelp };
