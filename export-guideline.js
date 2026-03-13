#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const VALID_STRUCTURES = new Set(['flat', 'by-document']);
const VALID_OUTPUT_MODES = new Set(['split', 'combined', 'both']);
const ASSET_PAGE_SIZE = 100;
const LIBRARY_PAGE_SIZE = 100;

function parsePositiveInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    exitWithError(`Error: ${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    structure: 'flat',
    outputMode: 'split',
    probe: false,
    skipDownload: false,
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      parsed.token = args[i + 1];
      i++;
    } else if (args[i] === '--guideline' && args[i + 1]) {
      parsed.guidelineId = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      parsed.outputName = args[i + 1];
      i++;
    } else if (args[i] === '--domain' && args[i + 1]) {
      parsed.domain = args[i + 1];
      i++;
    } else if (args[i] === '--structure' && args[i + 1]) {
      parsed.structure = String(args[i + 1]).toLowerCase();
      i++;
    } else if (args[i] === '--output-mode' && args[i + 1]) {
      parsed.outputMode = String(args[i + 1]).toLowerCase();
      i++;
    } else if (args[i] === '--combine') {
      parsed.outputMode = 'both';
    } else if (args[i] === '--probe') {
      parsed.probe = true;
    } else if (args[i] === '--skip-download') {
      parsed.skipDownload = true;
    } else if (args[i] === '--dry-run') {
      parsed.dryRun = true;
    } else if (args[i] === '--max-libraries' && args[i + 1]) {
      parsed.maxLibraries = parsePositiveInt(args[i + 1], '--max-libraries');
      i++;
    } else if (args[i] === '--max-assets-per-library' && args[i + 1]) {
      parsed.maxAssetsPerLibrary = parsePositiveInt(args[i + 1], '--max-assets-per-library');
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!parsed.token && process.env.FRONTIFY_TOKEN) {
    parsed.token = process.env.FRONTIFY_TOKEN;
  }

  if (!parsed.token) {
    exitWithError('Error: --token is required (or set FRONTIFY_TOKEN environment variable).');
  }
  if (!parsed.guidelineId) {
    exitWithError('Error: --guideline is required.');
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

function printHelp() {
  console.log(`
Frontify Guideline Export Tool

Usage:
  node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> --domain <DOMAIN> --output <NAME> [--structure <flat|by-document>] [--output-mode <split|combined|both>] [--probe] [--skip-download] [--dry-run] [--max-libraries <N>] [--max-assets-per-library <N>]

Options:
  --token        Frontify API bearer token (or set FRONTIFY_TOKEN env var)
  --guideline    Guideline ID to export (required)
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
  node export-guideline.js --guideline <ID> --domain brand.octave.com --output octave-flat
  node export-guideline.js --guideline <ID> --domain brand.octave.com --output octave-docs --structure by-document
  node export-guideline.js --guideline <ID> --domain brand.octave.com --output octave-ai --structure by-document --output-mode both --probe
`);
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

async function probeGraphQLEndpoint(domain, token) {
  console.log('Probing GraphQL endpoint at /graphql...');
  const data = await graphqlRequest(domain, token, 'query Probe { __typename }');
  const typename = data && data.__typename;
  if (!typename) {
    throw new Error('Probe succeeded but __typename was missing in response data.');
  }
  console.log(`GraphQL probe succeeded (root type: ${typename})\n`);
}

async function graphqlRequest(domain, token, query, variables = {}) {
  const payload = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: domain,
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-frontify-beta': 'enabled',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors) {
              reject(new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`));
            } else {
              resolve(parsed.data);
            }
          } catch (_error) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getAssetFragmentFields() {
  return `
    ... on Image {
      filename
      extension
      downloadUrl
      previewUrl
      width
      height
    }
    ... on Video {
      filename
      extension
      downloadUrl
      previewUrl
      width
      height
      duration
    }
    ... on Document {
      filename
      extension
      downloadUrl
      previewUrl
      pageCount
    }
    ... on Audio {
      filename
      extension
      downloadUrl
      previewUrl
    }
    ... on File {
      filename
      extension
      downloadUrl
      previewUrl
    }
  `;
}

async function fetchGuidelineLibraries(domain, token, guidelineId, maxLibraries) {
  const query = `
    query GuidelineLibraries($guidelineId: ID!, $page: Int!, $limit: Int!) {
      node(id: $guidelineId) {
        ... on Guideline {
          id
          name
          url
          defaultLanguage {
            name
            code
          }
          libraryPages(limit: $limit, page: $page) {
            total
            hasNextPage
            items {
              id
              title
              type
              assets(limit: 1, page: 1) {
                total
              }
            }
          }
        }
      }
    }
  `;

  let page = 1;
  let hasNextPage = true;
  let guidelineInfo = null;
  const libraries = [];

  while (hasNextPage && (!maxLibraries || libraries.length < maxLibraries)) {
    const data = await graphqlRequest(domain, token, query, {
      guidelineId,
      page,
      limit: LIBRARY_PAGE_SIZE
    });
    const guideline = data.node;

    if (!guideline) {
      throw new Error('Guideline not found');
    }

    if (!guidelineInfo) {
      guidelineInfo = {
        id: guideline.id,
        name: guideline.name,
        url: guideline.url,
        defaultLanguage: guideline.defaultLanguage,
        libraryTotal: guideline.libraryPages.total
      };
    }

    const mapped = (guideline.libraryPages.items || []).map((item) => ({
      id: item.id,
      title: item.title || 'Untitled Library',
      type: item.type || 'UNKNOWN',
      assetTotal: item.assets && typeof item.assets.total === 'number' ? item.assets.total : 0
    }));
    libraries.push(...mapped);

    hasNextPage = Boolean(guideline.libraryPages.hasNextPage);
    page++;
  }

  if (maxLibraries && libraries.length > maxLibraries) {
    libraries.length = maxLibraries;
  }

  return {
    guidelineInfo,
    libraries
  };
}

async function fetchLibraryAssets(domain, token, libraryId, maxAssetsPerLibrary) {
  const query = `
    query LibraryAssets($libraryId: ID!, $page: Int!, $limit: Int!) {
      node(id: $libraryId) {
        __typename
        ... on LibraryPage {
          id
          title
          type
          assets(page: $page, limit: $limit) {
            total
            page
            limit
            hasNextPage
            items {
              __typename
              id
              title
              ${getAssetFragmentFields()}
              attachments {
                id
                filename
                extension
                size
                downloadUrl
              }
            }
          }
        }
      }
    }
  `;

  let page = 1;
  let hasNextPage = true;
  let assets = [];
  let libraryMeta = null;

  while (hasNextPage && (!maxAssetsPerLibrary || assets.length < maxAssetsPerLibrary)) {
    const data = await graphqlRequest(domain, token, query, {
      libraryId,
      page,
      limit: ASSET_PAGE_SIZE
    });

    const node = data.node;
    if (!node || node.__typename !== 'LibraryPage') {
      throw new Error(`Node ${libraryId} is not a LibraryPage`);
    }

    if (!libraryMeta) {
      libraryMeta = {
        id: node.id,
        title: node.title,
        type: node.type
      };
    }

    assets = assets.concat(node.assets.items || []);
    if (maxAssetsPerLibrary && assets.length >= maxAssetsPerLibrary) {
      assets = assets.slice(0, maxAssetsPerLibrary);
      hasNextPage = false;
      break;
    }
    hasNextPage = Boolean(node.assets.hasNextPage);
    page++;
  }

  return { libraryMeta, assets };
}

function sanitizeFilename(str) {
  return String(str)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 120) || 'item';
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function pickAssetFileCandidates(asset) {
  const candidates = [];

  if (asset.downloadUrl) {
    candidates.push({
      kind: 'primary',
      url: asset.downloadUrl,
      filename: asset.filename || `${asset.title || asset.id}.${asset.extension || 'bin'}`
    });
  }

  const attachments = Array.isArray(asset.attachments) ? asset.attachments : [];
  for (const attachment of attachments) {
    if (!attachment || !attachment.downloadUrl) continue;
    candidates.push({
      kind: 'attachment',
      url: attachment.downloadUrl,
      filename: attachment.filename || `${attachment.id}.${attachment.extension || 'bin'}`,
      size: attachment.size
    });
  }

  return candidates;
}

function ensureUniquePath(targetPath, takenPaths) {
  let finalPath = targetPath;
  let counter = 1;
  const parsed = path.parse(targetPath);

  while (takenPaths.has(finalPath) || fs.existsSync(finalPath)) {
    finalPath = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter++;
  }

  takenPaths.add(finalPath);
  return finalPath;
}

async function downloadToFile(url, targetPath) {
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadToFile(response.headers.location, targetPath).then(resolve).catch(reject);
        return;
      }

      const file = fs.createWriteStream(targetPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (error) => {
        file.close(() => reject(error));
      });
    });

    request.on('error', reject);
  });
}

function buildLibraryMarkdown(guidelineInfo, library, includeLocalLinks, baseAssetDir) {
  let md = `# ${guidelineInfo.name} - ${library.title}\n\n`;
  md += `Guideline URL: ${guidelineInfo.url}\n\n`;
  md += `Library Type: ${library.type}\n\n`;
  md += `Total Assets: ${library.assets.length}\n\n`;

  if (library.assets.length === 0) {
    md += '_No assets found._\n';
    return md;
  }

  for (let i = 0; i < library.assets.length; i++) {
    const asset = library.assets[i];
    md += `## ${String(i + 1).padStart(3, '0')} - ${asset.title || 'Untitled'}\n\n`;
    md += `- Type: ${asset.__typename || 'Unknown'}\n`;
    md += `- ID: ${asset.id}\n`;
    if (asset.filename) md += `- Filename: ${asset.filename}\n`;
    if (asset.extension) md += `- Extension: ${asset.extension}\n`;
    if (asset.downloadUrl) md += `- Download URL: ${asset.downloadUrl}\n`;
    if (asset.previewUrl) md += `- Preview URL: ${asset.previewUrl}\n`;
    if (Number.isFinite(asset.width) && Number.isFinite(asset.height)) {
      md += `- Dimensions: ${asset.width}x${asset.height}\n`;
    }
    if (Number.isFinite(asset.duration)) {
      md += `- Duration: ${asset.duration}s\n`;
    }
    if (Number.isFinite(asset.pageCount)) {
      md += `- Page Count: ${asset.pageCount}\n`;
    }

    if (includeLocalLinks) {
      const files = Array.isArray(asset.localFiles) ? asset.localFiles : [];
      if (files.length > 0) {
        md += '- Local Files:\n';
        for (const file of files) {
          const relPath = path.join(baseAssetDir, file.relativePath).replace(/\\/g, '/');
          const sizeText = file.size ? ` (${formatBytes(file.size)})` : '';
          md += `  - ${relPath}${sizeText}\n`;
        }
      }
    }

    const attachments = Array.isArray(asset.attachments) ? asset.attachments : [];
    if (attachments.length > 0) {
      md += '- Attachments:\n';
      for (const attachment of attachments) {
        const sizeText = attachment.size ? ` (${formatBytes(attachment.size)})` : '';
        md += `  - ${attachment.filename || attachment.id}${sizeText}: ${attachment.downloadUrl || 'n/a'}\n`;
      }
    }

    md += '\n';
  }

  return md;
}

function buildGlobalIndex(guidelineInfo, libraries, includeLinks, byDocument) {
  let md = `# ${guidelineInfo.name} - Export Index\n\n`;
  md += `Exported from: ${guidelineInfo.url}\n\n`;
  md += `Libraries discovered: ${libraries.length}\n\n`;

  for (let i = 0; i < libraries.length; i++) {
    const library = libraries[i];
    const num = String(i + 1).padStart(2, '0');
    const slug = sanitizeFilename(library.title);
    const fileName = `${num}-${slug}.md`;
    const linkPath = byDocument ? `./${library.folderName}/${fileName}` : `./${fileName}`;

    if (includeLinks) {
      md += `## ${num}. [${library.title}](${linkPath})\n\n`;
    } else {
      md += `## ${num}. ${library.title}\n\n`;
    }
    md += `- Type: ${library.type}\n`;
    md += `- Assets: ${library.assets.length}\n\n`;
  }

  return md;
}

function printDryRunSummary(guidelineInfo, libraries, maxAssetsPerLibrary) {
  const totalAssets = libraries.reduce((sum, lib) => sum + (lib.assetTotal || 0), 0);

  console.log('\nDry run summary');
  console.log(`  Guideline: ${guidelineInfo.name}`);
  console.log(`  URL: ${guidelineInfo.url}`);
  console.log(`  Libraries listed: ${libraries.length}`);
  console.log(`  Assets (reported total): ${totalAssets}`);
  if (maxAssetsPerLibrary) {
    console.log(`  Max assets per library (normal run): ${maxAssetsPerLibrary}`);
  }
  console.log('');

  for (let i = 0; i < libraries.length; i++) {
    const lib = libraries[i];
    const num = String(i + 1).padStart(2, '0');
    let line = `  ${num}. ${lib.title} [${lib.type}] - assets: ${lib.assetTotal}`;
    if (maxAssetsPerLibrary) {
      line += ` (would fetch up to ${Math.min(lib.assetTotal, maxAssetsPerLibrary)})`;
    }
    console.log(line);
  }
  console.log('');
}

async function downloadLibraryAssets(library, assetsRootDir) {
  const safeLibrary = sanitizeFilename(library.title);
  const libraryFolder = path.join(assetsRootDir, safeLibrary);
  fs.mkdirSync(libraryFolder, { recursive: true });

  const takenPaths = new Set();
  let success = 0;
  let failed = 0;

  for (const asset of library.assets) {
    const assetFolder = path.join(libraryFolder, sanitizeFilename(asset.title || asset.id));
    fs.mkdirSync(assetFolder, { recursive: true });

    const files = pickAssetFileCandidates(asset);
    asset.localFiles = [];

    for (const file of files) {
      const safeName = sanitizeFilename(path.parse(file.filename).name);
      const ext = path.extname(file.filename) || (asset.extension ? `.${asset.extension}` : '.bin');
      const targetPath = ensureUniquePath(path.join(assetFolder, `${safeName}${ext}`), takenPaths);
      try {
        await downloadToFile(file.url, targetPath);
        const stat = fs.statSync(targetPath);
        asset.localFiles.push({
          kind: file.kind,
          relativePath: path.relative(assetsRootDir, targetPath),
          size: stat.size
        });
        success++;
      } catch (_error) {
        failed++;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  return { success, failed };
}

async function exportGuideline(config) {
  const {
    domain,
    token,
    guidelineId,
    outputName,
    structure,
    outputMode,
    probe,
    skipDownload,
    dryRun,
    maxLibraries,
    maxAssetsPerLibrary
  } = config;

  console.log('\nStarting Frontify Guideline Export\n');
  console.log(`  Domain: ${domain}`);
  console.log(`  Structure: ${structure}`);
  console.log(`  Output mode: ${outputMode}`);
  console.log(`  Download assets: ${skipDownload ? 'no' : 'yes'}\n`);
  if (dryRun) {
    console.log('  Dry run: yes\n');
  }
  if (maxLibraries) {
    console.log(`  Max libraries: ${maxLibraries}`);
  }
  if (maxAssetsPerLibrary) {
    console.log(`  Max assets per library: ${maxAssetsPerLibrary}`);
  }
  if (maxLibraries || maxAssetsPerLibrary) {
    console.log('');
  }

  if (probe) {
    await probeGraphQLEndpoint(domain, token);
  }

  const { guidelineInfo, libraries: bareLibraries } = await fetchGuidelineLibraries(
    domain,
    token,
    guidelineId,
    maxLibraries
  );

  if (dryRun) {
    printDryRunSummary(guidelineInfo, bareLibraries, maxAssetsPerLibrary);
    console.log('Dry run complete. No files were written and no assets were downloaded.\n');
    return;
  }

  console.log(`Guideline: ${guidelineInfo.name}`);
  console.log(`URL: ${guidelineInfo.url}`);
  console.log(`Library pages: ${bareLibraries.length}\n`);

  const libraries = [];
  for (let i = 0; i < bareLibraries.length; i++) {
    const base = bareLibraries[i];
    const num = String(i + 1).padStart(2, '0');
    process.stdout.write(`Fetching assets for library ${num}: ${base.title}... `);
    const { assets } = await fetchLibraryAssets(domain, token, base.id, maxAssetsPerLibrary);
    libraries.push({
      ...base,
      assets,
      folderName: `${num}-${sanitizeFilename(base.title)}`
    });
    console.log(`${assets.length} assets`);
  }

  const fullOutputDir = path.join('./output', outputName);
  fs.mkdirSync(fullOutputDir, { recursive: true });

  const shouldWriteSplit = outputMode === 'split' || outputMode === 'both';
  const shouldWriteCombined = outputMode === 'combined' || outputMode === 'both';

  const assetsRootDir = path.join(fullOutputDir, 'assets');
  let totalDownloadSuccess = 0;
  let totalDownloadFailed = 0;

  if (!skipDownload) {
    fs.mkdirSync(assetsRootDir, { recursive: true });
    console.log('\nDownloading assets...');
    for (const library of libraries) {
      process.stdout.write(`  ${library.title}... `);
      const stats = await downloadLibraryAssets(library, assetsRootDir);
      totalDownloadSuccess += stats.success;
      totalDownloadFailed += stats.failed;
      console.log(`ok (${stats.success} files, ${stats.failed} failed)`);
    }
  }

  const sectionArtifacts = [];

  if (structure === 'flat') {
    for (let i = 0; i < libraries.length; i++) {
      const library = libraries[i];
      const num = String(i + 1).padStart(2, '0');
      const fileName = `${num}-${sanitizeFilename(library.title)}.md`;
      const markdown = buildLibraryMarkdown(guidelineInfo, library, !skipDownload, 'assets');
      sectionArtifacts.push({ title: library.title, markdown, fileName, folderName: library.folderName });

      if (shouldWriteSplit) {
        fs.writeFileSync(path.join(fullOutputDir, fileName), markdown);
      }
    }
  } else {
    for (let i = 0; i < libraries.length; i++) {
      const library = libraries[i];
      const num = String(i + 1).padStart(2, '0');
      const folderPath = path.join(fullOutputDir, library.folderName);
      const fileName = `${num}-${sanitizeFilename(library.title)}.md`;
      const markdown = buildLibraryMarkdown(guidelineInfo, library, !skipDownload, '../assets');
      sectionArtifacts.push({ title: library.title, markdown, fileName, folderName: library.folderName });

      if (shouldWriteSplit) {
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(path.join(folderPath, fileName), markdown);
      }
    }
  }

  const indexMarkdown = buildGlobalIndex(guidelineInfo, libraries, shouldWriteSplit, structure === 'by-document');
  fs.writeFileSync(path.join(fullOutputDir, '00-INDEX.md'), indexMarkdown);

  if (shouldWriteCombined) {
    let combined = `# ${guidelineInfo.name} - Combined Export\n\n`;
    combined += `Exported from: ${guidelineInfo.url}\n\n`;
    combined += `${indexMarkdown}\n---\n\n`;
    for (const artifact of sectionArtifacts) {
      combined += artifact.markdown;
      combined += '\n---\n\n';
    }
    fs.writeFileSync(path.join(fullOutputDir, 'combined.md'), combined);
  }

  console.log(`\nExport complete. Files written to: ${fullOutputDir}`);
  if (!skipDownload) {
    console.log(`Downloaded files: ${totalDownloadSuccess} successful, ${totalDownloadFailed} failed`);
  }
  console.log('');
}

const args = parseArgs();
exportGuideline(args).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nExport failed: ${message}`);
  process.exit(1);
});

