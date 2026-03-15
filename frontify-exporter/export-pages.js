/**
 * export-pages.js
 *
 * Crawls every document page in a Frontify guideline hub using Playwright.
 * The browser loads the full JS-rendered DOM (post-AJAX, post-React) and each
 * page's main content is extracted and converted to Markdown.
 *
 * Authentication: Frontify uses SSO (SAML). Run with --login first to save a
 * session file, then subsequent headless runs use that session automatically.
 *
 * Usage:
 *   # Step 1 – log in via SSO (opens a browser window):
 *   node export-pages.js --domain brand.octave.com --hub-path /hub/2 --login
 *
 *   # Step 2 – crawl:
 *   node export-pages.js --domain brand.octave.com --hub-path /hub/2 --output octave-pages
 */

const { parseArgs } = require('./lib/cli-pages');
const { crawlGuideline, loginAndSaveSession } = require('./lib/crawler');

const args = parseArgs();

const run = args.login
  ? loginAndSaveSession({ domain: args.domain, hubPath: args.hubPath, sessionFile: args.sessionFile })
  : crawlGuideline(args);

run.catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed: ${message}`);
  process.exit(1);
});

