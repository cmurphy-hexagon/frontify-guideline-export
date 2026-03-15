/**
 * lib/crawler.js
 *
 * Playwright-based guideline page crawler.
 *
 * Authentication:
 *   Frontify uses SSO (SAML) for its brand portal SPA. The API bearer token
 *   only works for the public /graphql endpoint, not the SPA's /graphql-internal.
 *
 *   To authenticate:
 *     1. Run with --login: opens a visible browser so you can complete SSO login,
 *        then saves session cookies to a JSON file (default: ./frontify-session.json).
 *     2. Subsequent runs load the session file for headless crawling.
 *
 *   See loginAndSaveSession() and crawlGuideline() below.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Playwright is a peer dependency installed in this project.
// We require it lazily so that the rest of the lib still loads if Playwright
// is not yet installed.
function requirePlaywright() {
  try {
    return require('playwright');
  } catch (_error) {
    throw new Error(
      'Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium'
    );
  }
}

/**
 * Open a visible browser so the user can complete SSO login, then save the
 * resulting session (cookies + localStorage) to sessionFile.
 *
 * @param {object} config
 * @param {string} config.domain   - e.g. 'brand.octave.com'
 * @param {string} config.hubPath  - e.g. '/hub/2'
 * @param {string} config.sessionFile - path to write the session JSON
 * @param {number} [config.timeout=60000] - navigation timeout ms
 */
async function loginAndSaveSession({ domain, hubPath, sessionFile, timeout = 60000 }) {
  const { chromium } = requirePlaywright();
  const hubUrl = `https://${domain}${hubPath}`;

  console.log('\nOpening browser for SSO login...');
  console.log(`  Hub URL: ${hubUrl}`);
  console.log(`  Session will be saved to: ${sessionFile}`);
  console.log('\nPlease log in using SSO in the browser window that is about to open.');
  console.log('Once you can see the hub page content (not the login page), come back here\nand press Enter.');
  console.log('');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout });

  // Wait for the user to press Enter
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter to save session and close browser: ', () => {
      rl.close();
      resolve();
    });
  });

  await context.storageState({ path: sessionFile });
  await browser.close();

  console.log(`\nSession saved to ${sessionFile}`);
  console.log('You can now run the crawler normally (it will load this session automatically).\n');
}

// ---------------------------------------------------------------------------
// HTML → Markdown conversion (no external dep)
// ---------------------------------------------------------------------------

/**
 * Converts a Playwright ElementHandle's inner HTML to plain Markdown.
 * We evaluate a conversion function inside the browser context so we have
 * access to the full DOM tree (including pseudo-elements, computed roles etc.).
 *
 * The strategy is a recursive walker over the DOM that emits Markdown tokens.
 */
async function innerHtmlToMarkdown(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return '';

    const BLOCK_ELEMENTS = new Set([
      'p','div','section','article','aside','main','header','footer',
      'h1','h2','h3','h4','h5','h6','blockquote','pre','ul','ol','li',
      'table','thead','tbody','tr','th','td','hr','figure','figcaption',
      'dl','dt','dd','details','summary'
    ]);

    function walk(node, context) {
      const parts = [];
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) parts.push(text);
        return parts.join('');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes);
      const inner = () => children.map(c => walk(c, context)).join('');

      // Skip hidden/decorative nodes
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';

      // Skip nav and interactive chrome — we only want content
      if (['nav','script','style','button','input','select','textarea'].includes(tag)) return '';
      const role = node.getAttribute('role');
      if (role === 'navigation' || role === 'banner') return '';

      // Heading levels
      const headingMap = { h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######' };
      if (headingMap[tag]) {
        const content = inner().trim().replace(/\s+/g, ' ');
        return content ? `\n\n${headingMap[tag]} ${content}\n\n` : '';
      }

      if (tag === 'hr') return '\n\n---\n\n';

      if (tag === 'br') return '  \n';

      if (tag === 'strong' || tag === 'b') {
        const content = inner();
        return content.trim() ? `**${content.trim()}**` : '';
      }

      if (tag === 'em' || tag === 'i') {
        const content = inner();
        return content.trim() ? `_${content.trim()}_` : '';
      }

      if (tag === 'code') {
        const content = inner();
        return content.trim() ? `\`${content.trim()}\`` : '';
      }

      if (tag === 'pre') {
        const codeNode = node.querySelector('code');
        const codeText = (codeNode || node).textContent.trim();
        const lang = (codeNode && codeNode.className.match(/language-(\w+)/)?.[1]) || '';
        return `\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
      }

      if (tag === 'blockquote') {
        const content = inner().trim().split('\n').map(l => `> ${l}`).join('\n');
        return `\n\n${content}\n\n`;
      }

      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const content = inner().trim();
        if (!content) return '';
        if (!href || href === '#') return content;
        const absHref = href.startsWith('http') ? href : href;
        return `[${content}](${absHref})`;
      }

      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        return src ? `![${alt}](${src})` : '';
      }

      if (tag === 'ul') {
        const items = Array.from(node.children)
          .filter(c => c.tagName.toLowerCase() === 'li')
          .map(li => `- ${walk(li, context).trim().replace(/\n/g, ' ')}`)
          .join('\n');
        return items ? `\n\n${items}\n\n` : '';
      }

      if (tag === 'ol') {
        const items = Array.from(node.children)
          .filter(c => c.tagName.toLowerCase() === 'li')
          .map((li, idx) => `${idx + 1}. ${walk(li, context).trim().replace(/\n/g, ' ')}`)
          .join('\n');
        return items ? `\n\n${items}\n\n` : '';
      }

      if (tag === 'li') return inner();

      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        const toRow = (tr) => {
          const cells = Array.from(tr.querySelectorAll('th,td'))
            .map(c => c.textContent.trim().replace(/\|/g, '\\|'));
          return `| ${cells.join(' | ')} |`;
        };
        const headerRow = rows[0];
        const isHeader = !!headerRow.querySelector('th');
        const lines = rows.map(toRow);
        if (isHeader) {
          const sep = `| ${Array.from(headerRow.querySelectorAll('th,td')).map(() => '---').join(' | ')} |`;
          lines.splice(1, 0, sep);
        }
        return `\n\n${lines.join('\n')}\n\n`;
      }

      // Generic block wrapper — add newlines around content
      if (BLOCK_ELEMENTS.has(tag)) {
        const content = inner().trim();
        return content ? `\n\n${content}\n\n` : '';
      }

      return inner();
    }

    const raw = walk(root, {});
    // Collapse 3+ consecutive blank lines into 2
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }, selector);
}

// ---------------------------------------------------------------------------
// Navigation discovery
// ---------------------------------------------------------------------------

/**
 * Discovers all page links from the Frontify hub navigation.
 * Returns [{ title, url, section }]
 */
/**
 * Discovers all page links from the Frontify hub navigation.
 * Requires the page to be loaded with a valid authenticated session.
 * Returns [{ title, url }]
 */
async function discoverPages(page, baseUrl, verbose) {
  async function expandNavTrees() {
    for (let round = 0; round < 6; round++) {
      const clicked = await page.evaluate(() => {
        const selectors = [
          '[data-test-id*="nav"] button[aria-expanded="false"]',
          '[data-test-id*="sidebar"] button[aria-expanded="false"]',
          'nav button[aria-expanded="false"]',
          'aside button[aria-expanded="false"]'
        ];

        let count = 0;
        for (const sel of selectors) {
          for (const btn of document.querySelectorAll(sel)) {
            try {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              count++;
            } catch (_e) {
              // ignore
            }
          }
        }
        return count;
      });

      if (clicked === 0) break;
      await page.waitForTimeout(300);
    }
  }

  // Wait up to 15s for any <a> tag to appear (i.e. the SPA has rendered)
  await page.waitForSelector('a', { timeout: 15000 }).catch(() => null);

  // Allow the SPA nav to fully settle — Frontify lazy-renders nested items.
  await page.waitForTimeout(3000);

  // Expand nav trees so child links are rendered before extraction.
  await expandNavTrees();
  await page.waitForTimeout(500);

  // Incrementally scroll nav/sidebar containers so virtual/lazy-rendered items
  // have time to appear at each position before we move to the next step.
  await page.evaluate(async () => {
    const containers = Array.from(document.querySelectorAll(
      'nav, aside, [class*="sidebar"], [class*="Sidebar"], [class*="navdocuments"], [class*="NavDocuments"]'
    )).filter(el => el.scrollHeight > el.clientHeight);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const el of containers) {
      const step = Math.max(el.clientHeight * 0.6, 200);
      // Guard against custom/virtual containers where scrollTop may stop moving.
      let guard = 0;
      while (el.scrollTop + el.clientHeight < el.scrollHeight - 10 && guard < 80) {
        const before = el.scrollTop;
        el.scrollTop = before + step;
        if (el.scrollTop === before) {
          break;
        }
        guard++;
        await sleep(120);
      }
      el.scrollTop = el.scrollHeight;
      await sleep(120);
    }
  });
  await page.waitForTimeout(500);

  const links = await page.evaluate((base) => {
    const seen = new Set();
    const results = [];

    const isGuidelineLink = (href) => {
      if (!href || href.startsWith('#') || href.startsWith('javascript')) return false;
      if (href.includes('/edit') || href.includes('/logout') || href.includes('/login')) return false;
      if (href.includes('/api/')) return false;
      if (href.includes('/dashboard')) return false;
      try {
        const u = new URL(href, base);
        const b = new URL(base);
        if (u.hostname !== b.hostname) return false;
        // Keep content-centric links only.
        return u.pathname.startsWith('/document/') || u.pathname.startsWith('/hub/');
      } catch {
        return false;
      }
    };

    // Priority nav selectors — Frontify uses data-test-id attributes more reliably
    // than class names. Fall back progressively.
    const selectors = [
      '[data-test-id*="nav"] a',
      '[data-test-id*="sidebar"] a',
      '[data-test-id*="navigation"] a',
      '[class*="navdocuments"] a',
      '[class*="NavDocuments"] a',
      '[class*="sidebar"] a',
      '[class*="Sidebar"] a',
      'nav a',
      'aside a',
    ];

    let found = false;
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const a of nodes) {
        const href = a.getAttribute('href');
        if (!isGuidelineLink(href)) continue;
        const abs = new URL(href, base).toString();
        if (seen.has(abs)) continue;
        seen.add(abs);
        results.push({ url: abs, title: a.textContent.trim() || abs });
        found = true;
      }
      if (found) break;
    }

    // ALWAYS also collect Frontify document pagination controls (prev/next chapter
    // links at the bottom of content pages). Frontify documents are paginated —
    // each view only shows the current chapter’s nav items, not the full TOC.
    // Following pagination links is the only way to discover all chapters.
    const paginationSelectors = [
      '[data-test-id="page-control-link"]',
      '[data-test-id="page-control-next-item"] a',
      '[data-test-id="page-control-prev-item"] a',
    ];
    for (const sel of paginationSelectors) {
      for (const a of document.querySelectorAll(sel)) {
        const href = a.getAttribute('href');
        if (!isGuidelineLink(href)) continue;
        const abs = new URL(href, base).toString();
        if (seen.has(abs)) continue;
        seen.add(abs);
        results.push({ url: abs, title: a.textContent.trim() || abs, viaPageControl: true });
        found = true;
      }
    }

    // Final fallback: all same-domain content links
    if (!found) {
      const allLinks = Array.from(document.querySelectorAll('a'));
      for (const a of allLinks) {
        const href = a.getAttribute('href');
        if (!isGuidelineLink(href)) continue;
        try {
          const u = new URL(href, base);
          const b = new URL(base);
          // Only include paths that look like hub content (not assets, api, etc.)
          if (u.hostname !== b.hostname) continue;
          const p = u.pathname;
          if (p === '/' || p === b.pathname) continue;
          if (p.startsWith('/api') || p.startsWith('/assets')) continue;
          const abs = u.toString();
          if (seen.has(abs)) continue;
          seen.add(abs);
          results.push({ url: abs, title: a.textContent.trim() || abs });
        } catch { /* skip */ }
      }
    }

    return results;
  }, baseUrl);

  if (verbose) {
    console.log(`  Discovered ${links.length} page links from nav`);
  }

  return links;
}

// ---------------------------------------------------------------------------
// Per-page content extraction
// ---------------------------------------------------------------------------

const CONTENT_SELECTORS = [
  '.page-content',
  '[class*="page-content"]',
  '.block-content',
  'main',
  '[role="main"]',
  'article'
];

async function extractPageContent(page, url, timeout, verbose) {
  await page.goto(url, { waitUntil: 'networkidle', timeout });

  // Extra wait for any deferred block rendering
  await page.waitForTimeout(1500);

  // Try each content selector in priority order
  let selector = null;
  for (const sel of CONTENT_SELECTORS) {
    const exists = await page.$(sel);
    if (exists) { selector = sel; break; }
  }

  if (!selector) {
    if (verbose) console.log(`    [warn] No content selector matched on ${url}`);
    selector = 'body';
  }

  if (verbose) console.log(`    Using selector: ${selector}`);

  const title = await page.title();
  const markdown = await innerHtmlToMarkdown(page, selector);

  return { title, markdown };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

function sanitizeFilename(str) {
  return String(str)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 120) || 'page';
}

async function crawlGuideline(config) {
  const {
    domain,
    hubPath,
    token,
    sessionFile,
    outputName,
    concurrency,
    timeout,
    dryRun,
    verbose,
    includePrefixes = [],
    skipExistingFile = false
  } = config;

  const { chromium } = requirePlaywright();
  const baseUrl = `https://${domain}`;
  const hubUrl = `${baseUrl}${hubPath}`;

  // Determine which auth method to use.
  // Session file (SSO cookies) takes priority over bearer token header.
  const sessionExists = sessionFile && fs.existsSync(sessionFile);
  if (!sessionExists && !token) {
    throw new Error(
      'No authentication available. Provide --token or run with --login to save a session first.'
    );
  }
  if (!sessionExists) {
    console.log('\n[warn] No session file found. Falling back to bearer token header injection.');
    console.log('[warn] This may not work for SSO-protected portals. Run with --login first.\n');
  }

  console.log('\nStarting Frontify Page Crawler\n');
  console.log(`  Domain:   ${domain}`);
  console.log(`  Hub:      ${hubUrl}`);
  console.log(`  Auth:     ${sessionExists ? `session file (${sessionFile})` : 'bearer token header'}`);
  console.log(`  Output:   ./output/${outputName}`);
  if (dryRun) console.log('  Dry run:  yes');
  console.log('');

  const browser = await chromium.launch({ headless: true });

  // Use a large viewport so Frontify's responsive nav renders its full tree.
  // At small sizes (e.g. 1280×720) the sidebar collapses and hides child links.
  const baseContextOptions = { viewport: { width: 1920, height: 1080 } };
  const contextOptions = sessionExists
    ? { ...baseContextOptions, storageState: sessionFile }
    : { ...baseContextOptions, extraHTTPHeaders: { Authorization: `Bearer ${token}` } };

  const context = await browser.newContext(contextOptions);

  // Silence JS console noise from the SPA unless verbose.
  if (!verbose) {
    context.on('page', (p) => {
      p.on('console', () => {});
      p.on('pageerror', () => {});
    });
  }

  try {
    console.log('Opening hub root page...');
    const rootPage = await context.newPage();
    await rootPage.goto(hubUrl, { waitUntil: 'networkidle', timeout });

    console.log('Discovering navigation pages...\n');
    let pages = await discoverPages(rootPage, hubUrl, verbose);

    // Always include the hub root itself as the first entry if it isn't already
    const rootEntry = { url: hubUrl, title: await rootPage.title() };
    const alreadyIncludesRoot = pages.some(p => p.url === hubUrl);
    if (!alreadyIncludesRoot) {
      pages = [rootEntry, ...pages];
    }

    // Recursively discover deeper links by visiting each discovered page and
    // reading its nav. This captures child pages nested under top-level items.
    const seenUrls = new Set(pages.map((p) => p.url));
    const queue = pages.map((p) => ({ url: p.url, depth: p.url === hubUrl ? 0 : 1 }));
    const maxDiscoveryPages = 500;
    // Depth 1 = document roots; depth 2+ = paginated chapter chain.
    // Some Frontify docs chain many chapter pages (logo -> color -> typography
    // -> unleash mark -> iconography, etc.), so allow deeper traversal.
    const maxDiscoveryDepth = 20;
    // Use networkidle for shallow passes, domcontentloaded for deeper ones.
    // Respect user-provided timeout; defaults still remain bounded and practical.
    const getDiscoveryTimeout = (depth) =>
      depth <= 2 ? Math.max(timeout, 20000) : Math.max(Math.floor(timeout * 0.6), 12000);

    while (queue.length > 0 && seenUrls.size < maxDiscoveryPages) {
      const current = queue.shift();
      if (!current || !current.url) break;
      if (current.depth >= maxDiscoveryDepth) continue;

      const navPage = await context.newPage();
      try {
        if (verbose) process.stdout.write(`  [discovery d${current.depth}] ${current.url} ... `);
        const waitUntil = current.depth <= 2 ? 'networkidle' : 'domcontentloaded';
        const discoveryTimeout = getDiscoveryTimeout(current.depth);
        try {
          await navPage.goto(current.url, { waitUntil, timeout: discoveryTimeout });
        } catch (e) {
          // Frontify pages may keep background requests open and never hit
          // networkidle. Fall back to domcontentloaded for robustness.
          if (waitUntil === 'networkidle') {
            await navPage.goto(current.url, { waitUntil: 'domcontentloaded', timeout: discoveryTimeout });
          } else {
            throw e;
          }
        }
        const found = await discoverPages(navPage, hubUrl, false);
        const newItems = found.filter(item => !seenUrls.has(item.url));
        for (const item of newItems) {
          seenUrls.add(item.url);
          pages.push(item);
          queue.push({ url: item.url, depth: current.depth + 1 });
        }
        if (verbose) console.log(`${newItems.length} new`);
      } catch (_e) {
        if (verbose) console.log(`skipped (${_e.message?.substring(0, 60)})`);
      } finally {
        await navPage.close().catch(() => {});
      }
    }

    if (includePrefixes.length > 0) {
      const matchesPrefix = (rawUrl) => {
        try {
          const u = new URL(rawUrl);
          const pathWithHash = `${u.pathname}${u.hash || ''}`;
          return includePrefixes.some((prefix) =>
            pathWithHash.toLowerCase().startsWith(String(prefix).toLowerCase())
          );
        } catch (_e) {
          return false;
        }
      };

      const before = pages.length;
      pages = pages.filter((p) => matchesPrefix(p.url));
      console.log(`Applied include-prefix filter (${includePrefixes.join(', ')}): ${pages.length}/${before} pages kept.`);
      console.log('');
    }

    if (verbose) {
      console.log(`Deep discovery complete. Total unique pages: ${pages.length}\n`);
    }

    console.log(`Found ${pages.length} pages:\n`);
    for (let i = 0; i < pages.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      console.log(`  ${num}. ${pages[i].title}`);
      console.log(`      ${pages[i].url}`);
    }
    console.log('');

    if (dryRun) {
      console.log('Dry run complete. No files written.\n');
      await browser.close();
      return;
    }

    const outputDir = path.join('./output', outputName);
    fs.mkdirSync(outputDir, { recursive: true });

    const results = new Array(pages.length);

    // Crawl pages with limited concurrency
    const crawlQueue = [...pages.entries()];
    const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (crawlQueue.length > 0) {
        const entry = crawlQueue.shift();
        if (!entry) break;
        const [i, pageInfo] = entry;

        const num = String(i + 1).padStart(2, '0');
        process.stdout.write(`Crawling ${num}/${pages.length}: ${pageInfo.title}... `);

        const slug = sanitizeFilename(pageInfo.title || 'page');
        const fileName = `${num}-${slug}.md`;
        const outPath = path.join(outputDir, fileName);
        if (skipExistingFile && fs.existsSync(outPath)) {
          results[i] = { num, title: pageInfo.title, url: pageInfo.url, fileName, skipped: true };
          console.log('skipped (exists)');
          continue;
        }

        try {
          const crawlPage = await context.newPage();
          const { title, markdown } = await extractPageContent(crawlPage, pageInfo.url, timeout, verbose);
          await crawlPage.close();

          const fullContent = `# ${title || pageInfo.title}\n\nSource: ${pageInfo.url}\n\n---\n\n${markdown}\n`;

          fs.writeFileSync(outPath, fullContent);
          results[i] = { num, title: title || pageInfo.title, url: pageInfo.url, fileName };
          console.log('ok');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`FAILED (${msg})`);
          results[i] = { num, title: pageInfo.title, url: pageInfo.url, fileName: null, error: msg };
        }
      }
    });

    await Promise.all(workers);

    // Write index
    let index = `# Page Export Index\n\nSource: ${hubUrl}\n\nPages exported: ${results.length}\n\n`;
    for (const r of results.filter(Boolean)) {
      if (r.skipped) {
        index += `## ${r.num}. ${r.title} _(skipped: existing file)_\n\n`;
      } else if (r.fileName) {
        index += `## ${r.num}. [${r.title}](./${r.fileName})\n\n`;
      } else {
        index += `## ${r.num}. ${r.title} _(failed)_\n\n`;
      }
      index += `URL: ${r.url}\n\n`;
    }
    fs.writeFileSync(path.join(outputDir, '00-INDEX.md'), index);

    const failed = results.filter(r => r.error).length;
    const skipped = results.filter(r => r.skipped).length;
    const exported = results.length - failed - skipped;
    console.log(`\nCrawl complete. Files written to: output/${outputName}`);
    console.log(`  ${exported} pages exported, ${skipped} skipped, ${failed} failed\n`);

  } finally {
    await browser.close();
  }
}

module.exports = { crawlGuideline, loginAndSaveSession };
