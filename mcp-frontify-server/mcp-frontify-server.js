#!/usr/bin/env node
/**
 * mcp-frontify-server.js
 *
 * MCP server for Frontify tooling. Crawler/export tools delegate directly to
 * the project's CLI scripts (export-pages.js, export-guideline.js) so that
 * testing via MCP exercises the same code paths as running the scripts manually.
 *
 * Tools:
 *   frontify_graphql          – raw GraphQL query (direct API call, no CLI equivalent)
 *   frontify_list_libraries   – list guideline library pages (direct GraphQL)
 *   frontify_list_assets      – list assets in a library page (direct GraphQL)
 *   frontify_discover_pages   – page discovery dry-run  → delegates to export-pages.js --dry-run
 *   frontify_crawl_hub        – full hub crawl to Markdown → delegates to export-pages.js
 *   frontify_export_assets    – export asset library       → delegates to export-guideline.js
 *   frontify_setup_auth       – SSO login + session save   → Playwright (needs visible browser)
 *
 * Config (env / .vscode/mcp.json inputs):
 *   FRONTIFY_TOKEN        – bearer token (GraphQL tools only)
 *   FRONTIFY_DOMAIN       – default domain (e.g. brand.octave.com)
 *   FRONTIFY_SESSION_FILE – path to saved SSO session (default: <project>/frontify-session.json)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = resolve(join(__dirname, '..'));
const EXPORTER_DIR = join(WORKSPACE_DIR, 'frontify-exporter');

const TOKEN = process.env.FRONTIFY_TOKEN || '';
const DEFAULT_DOMAIN = (process.env.FRONTIFY_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const DEFAULT_SESSION_FILE = process.env.FRONTIFY_SESSION_FILE || join(WORKSPACE_DIR, 'frontify-session.json');

// ---------------------------------------------------------------------------
// CLI runner — spawns a project CLI script and returns its stdout
// ---------------------------------------------------------------------------

function runCLI(scriptName, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const script = join(EXPORTER_DIR, scriptName);
    execFile('node', [script, ...args], {
      // Keep workspace root as cwd so output/ and session paths remain stable.
      cwd: WORKSPACE_DIR,
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr?.trim() || error.message).substring(0, 2000)));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// GraphQL helper (direct API — no CLI equivalent for arbitrary queries)
// ---------------------------------------------------------------------------

async function graphqlRequest(domain, query, variables = {}) {
  const response = await fetch(`https://${domain}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'x-frontify-beta': 'enabled',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const parsed = await response.json();
  if (parsed.errors) {
    const messages = Array.isArray(parsed.errors)
      ? parsed.errors.map(e => e?.message ?? JSON.stringify(e)).join('; ')
      : JSON.stringify(parsed.errors);
    throw new Error(`GraphQL errors: ${messages}`);
  }
  return parsed.data;
}

function guidelineIdFromN(n) {
  return Buffer.from(JSON.stringify({ identifier: n, type: 'guideline' })).toString('base64');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'frontify_graphql',
    description: 'Execute a raw GraphQL query against the Frontify API. Returns parsed data.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        domain:    { type: 'string', description: 'Frontify domain. Uses FRONTIFY_DOMAIN env if omitted.' },
        query:     { type: 'string', description: 'GraphQL query string.' },
        variables: { type: 'object', description: 'Optional variables.' },
      },
    },
  },
  {
    name: 'frontify_list_libraries',
    description: 'List all library pages in a Frontify guideline by identifier number.',
    inputSchema: {
      type: 'object',
      required: ['guideline_n'],
      properties: {
        domain:      { type: 'string', description: 'Frontify domain. Uses FRONTIFY_DOMAIN env if omitted.' },
        guideline_n: { type: 'number', description: 'Numeric guideline identifier (e.g. 6).' },
      },
    },
  },
  {
    name: 'frontify_list_assets',
    description: 'List assets for a specific library page by its Frontify node ID.',
    inputSchema: {
      type: 'object',
      required: ['library_id'],
      properties: {
        domain:     { type: 'string', description: 'Frontify domain. Uses FRONTIFY_DOMAIN env if omitted.' },
        library_id: { type: 'string', description: 'Base64 Frontify node ID for the library page.' },
        page:       { type: 'number', description: 'Page number (default: 1).' },
        limit:      { type: 'number', description: 'Assets per page (default: 20, max: 100).' },
      },
    },
  },
  {
    name: 'frontify_discover_pages',
    description: 'Discover all document page URLs in a hub without writing any files. Delegates to: node export-pages.js --dry-run',
    inputSchema: {
      type: 'object',
      required: ['domain', 'hub_path'],
      properties: {
        domain:       { type: 'string', description: 'Frontify domain (e.g. brand.octave.com).' },
        hub_path:     { type: 'string', description: 'Hub URL path (e.g. /hub/2).' },
        session_file: { type: 'string', description: 'Path to SSO session JSON. Defaults to FRONTIFY_SESSION_FILE env.' },
        include_prefixes: { type: 'array', items: { type: 'string' }, description: 'Optional URL path/hash prefixes to keep (e.g. /document/6#).' },
        timeout:      { type: 'number', description: 'Per-page navigation timeout ms (default: 30000).' },
        verbose:      { type: 'boolean', description: 'Print extra discovery detail.' },
      },
    },
  },
  {
    name: 'frontify_crawl_hub',
    description: 'Crawl all pages in a Frontify hub and export each as a Markdown file. Delegates to: node export-pages.js',
    inputSchema: {
      type: 'object',
      required: ['domain', 'hub_path', 'output'],
      properties: {
        domain:       { type: 'string', description: 'Frontify domain.' },
        hub_path:     { type: 'string', description: 'Hub URL path (e.g. /hub/2).' },
        output:       { type: 'string', description: 'Output folder name under ./output/.' },
        session_file: { type: 'string', description: 'Path to SSO session JSON.' },
        include_prefixes: { type: 'array', items: { type: 'string' }, description: 'Optional URL path/hash prefixes to keep (e.g. /document/6#).' },
        skip_existing_file: { type: 'boolean', description: 'Skip page export when target markdown file already exists.' },
        concurrency:  { type: 'number', description: 'Max parallel page crawls (default: 3).' },
        timeout:      { type: 'number', description: 'Per-page navigation timeout ms.' },
        verbose:      { type: 'boolean', description: 'Verbose output.' },
      },
    },
  },
  {
    name: 'frontify_export_assets',
    description: 'Export Frontify asset libraries to Markdown. Delegates to: node export-guideline.js',
    inputSchema: {
      type: 'object',
      required: ['guideline_n', 'output'],
      properties: {
        domain:        { type: 'string', description: 'Frontify domain. Uses FRONTIFY_DOMAIN env if omitted.' },
        guideline_n:   { type: 'number', description: 'Numeric guideline identifier.' },
        output:        { type: 'string', description: 'Output folder name under ./output/.' },
        probe:         { type: 'boolean', description: 'Probe connection only, no files written.' },
        skip_download: { type: 'boolean', description: 'List assets but skip downloading files.' },
        structure:     { type: 'string', description: 'flat | by-document' },
        output_mode:   { type: 'string', description: 'split | combined | both' },
        asset_types:   { type: 'array', items: { type: 'string' }, description: 'Optional asset types to keep (e.g. Image, Document).' },
        library_types: { type: 'array', items: { type: 'string' }, description: 'Optional library filters (e.g. logo, template, LOGO_LIBRARY).' },
        skip_existing_asset: { type: 'boolean', description: 'Skip downloading an asset file when target path already exists.' },
        dry_run:       { type: 'boolean', description: 'Show what would be exported without writing.' },
      },
    },
  },
  {
    name: 'frontify_setup_auth',
    description: 'Open a visible browser window for SSO login and save the resulting session file. Must be run before crawl tools on SSO-protected portals.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'hub_path'],
      properties: {
        domain:       { type: 'string', description: 'Frontify domain (e.g. brand.octave.com).' },
        hub_path:     { type: 'string', description: 'Hub URL path (e.g. /hub/2).' },
        session_file: { type: 'string', description: 'Path to save session JSON. Defaults to FRONTIFY_SESSION_FILE env.' },
        wait_seconds: { type: 'number', description: 'Seconds to wait for login before timing out (default: 60).' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  const domain = (args.domain || DEFAULT_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  // --- Direct GraphQL tools (no CLI equivalent) ---

  if (name === 'frontify_graphql') {
    if (!domain) throw new Error('domain is required (or set FRONTIFY_DOMAIN env).');
    return JSON.stringify(await graphqlRequest(domain, args.query, args.variables ?? {}), null, 2);
  }

  if (name === 'frontify_list_libraries') {
    if (!domain) throw new Error('domain is required (or set FRONTIFY_DOMAIN env).');
    const id = guidelineIdFromN(args.guideline_n);
    const data = await graphqlRequest(domain, `
      query($id: ID!, $page: Int!, $limit: Int!) {
        node(id: $id) {
          ... on Guideline {
            id name url
            libraryPages(page: $page, limit: $limit) {
              total hasNextPage
              items { id title type assets(limit: 1, page: 1) { total } }
            }
          }
        }
      }`, { id, page: 1, limit: 100 });
    const g = data?.node;
    if (!g) throw new Error('Guideline not found.');
    return JSON.stringify({
      guideline: { id: g.id, name: g.name, url: g.url },
      libraries: (g.libraryPages?.items ?? []).map(l => ({
        id: l.id, title: l.title, type: l.type, assetTotal: l.assets?.total ?? 0,
      })),
      total: g.libraryPages?.total ?? 0,
    }, null, 2);
  }

  if (name === 'frontify_list_assets') {
    if (!domain) throw new Error('domain is required (or set FRONTIFY_DOMAIN env).');
    const page = args.page ?? 1;
    const limit = Math.min(args.limit ?? 20, 100);
    const data = await graphqlRequest(domain, `
      query($id: ID!, $page: Int!, $limit: Int!) {
        node(id: $id) {
          __typename
          ... on LibraryPage {
            id title type
            assets(page: $page, limit: $limit) {
              total hasNextPage
              items {
                __typename id title
                ... on Image    { filename extension downloadUrl previewUrl width height }
                ... on Document { filename extension downloadUrl previewUrl pageCount }
                ... on File     { filename extension downloadUrl previewUrl }
              }
            }
          }
        }
      }`, { id: args.library_id, page, limit });
    return JSON.stringify(data?.node ?? {}, null, 2);
  }

  // --- CLI-delegating tools ---

  if (name === 'frontify_discover_pages') {
    if (!domain) throw new Error('domain is required.');
    const sessionFile = args.session_file ?? DEFAULT_SESSION_FILE;
    const cliArgs = [
      '--domain', domain,
      '--hub-path', args.hub_path,
      '--output', '_mcp_discover_',
      '--dry-run',
    ];
    if (existsSync(sessionFile)) cliArgs.push('--session-file', sessionFile);
    if (Array.isArray(args.include_prefixes)) {
      for (const p of args.include_prefixes) {
        if (p) cliArgs.push('--include-prefix', String(p));
      }
    }
    if (args.timeout) cliArgs.push('--timeout', String(args.timeout));
    if (args.verbose) cliArgs.push('--verbose');
    const extraMs = (args.timeout ?? 30000) * 5 + 60000;
    return await runCLI('export-pages.js', cliArgs, extraMs);
  }

  if (name === 'frontify_crawl_hub') {
    if (!domain) throw new Error('domain is required.');
    const sessionFile = args.session_file ?? DEFAULT_SESSION_FILE;
    const cliArgs = [
      '--domain', domain,
      '--hub-path', args.hub_path,
      '--output', args.output,
    ];
    if (existsSync(sessionFile)) cliArgs.push('--session-file', sessionFile);
    if (Array.isArray(args.include_prefixes)) {
      for (const p of args.include_prefixes) {
        if (p) cliArgs.push('--include-prefix', String(p));
      }
    }
    if (args.skip_existing_file) cliArgs.push('--skip-existing-file');
    if (args.concurrency) cliArgs.push('--concurrency', String(args.concurrency));
    if (args.timeout) cliArgs.push('--timeout', String(args.timeout));
    if (args.verbose) cliArgs.push('--verbose');
    const stdout = await runCLI('export-pages.js', cliArgs, 600000);
    const indexPath = join(WORKSPACE_DIR, 'output', args.output, '00-INDEX.md');
    const index = existsSync(indexPath) ? '\n\n---\n\n' + readFileSync(indexPath, 'utf8') : '';
    return stdout + index;
  }

  if (name === 'frontify_export_assets') {
    if (!domain) throw new Error('domain is required.');
    const cliArgs = [
      '--guideline-n', String(args.guideline_n),
      '--domain', domain,
      '--output', args.output,
    ];
    if (args.probe) cliArgs.push('--probe');
    if (args.skip_download) cliArgs.push('--skip-download');
    if (args.structure) cliArgs.push('--structure', args.structure);
    if (args.output_mode) cliArgs.push('--output-mode', args.output_mode);
    if (Array.isArray(args.asset_types)) {
      for (const t of args.asset_types) {
        if (t) cliArgs.push('--asset-types', String(t));
      }
    }
    if (Array.isArray(args.library_types)) {
      for (const t of args.library_types) {
        if (t) cliArgs.push('--library-types', String(t));
      }
    }
    if (args.skip_existing_asset) cliArgs.push('--skip-existing-asset');
    if (args.dry_run) cliArgs.push('--dry-run');
    return await runCLI('export-guideline.js', cliArgs, 600000);
  }

  if (name === 'frontify_setup_auth') {
    // The CLI --login command requires interactive stdin (readline), which can't be
    // driven from MCP. Instead we open the browser directly via Playwright and
    // auto-detect when login is complete (no Enter key required).
    if (!domain) throw new Error('domain is required.');
    const sessionFile = args.session_file ?? DEFAULT_SESSION_FILE;
    const waitSeconds = args.wait_seconds ?? 60;
    const hubUrl = `https://${domain}${args.hub_path}`;
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('Playwright not installed. Run: npm install --save-dev playwright && npx playwright install chromium');
    }
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + waitSeconds * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const title = await page.title().catch(() => '');
      const url = page.url();
      if (!title.toLowerCase().includes('login') && !url.toLowerCase().includes('login') && !url.toLowerCase().includes('/auth/')) {
        loggedIn = true;
        break;
      }
    }
    if (loggedIn) {
      await context.storageState({ path: sessionFile });
      await browser.close();
      return `Session saved to ${sessionFile}. You can now use frontify_discover_pages and frontify_crawl_hub.`;
    } else {
      await browser.close();
      throw new Error(`Timed out after ${waitSeconds}s waiting for login to complete.`);
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'frontify', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requiresToken = new Set(['frontify_graphql', 'frontify_list_libraries', 'frontify_list_assets']);
  if (!TOKEN && requiresToken.has(name)) {
    return { content: [{ type: 'text', text: 'Error: FRONTIFY_TOKEN is not set.' }], isError: true };
  }
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

