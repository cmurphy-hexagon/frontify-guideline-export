const https = require('https');
const fs = require('fs');
const path = require('path');

const { HTTP_TIMEOUT_MS } = require('./constants');
const {
  probeGraphQLEndpoint,
  fetchGuidelineLibraries,
  fetchLibraryAssets,
  resolveGuidelineIdByName
} = require('./frontify-api');
const { guidelineIdFromN } = require('./guideline-id');

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

async function downloadToFile(url, targetPath, redirectCount = 0) {
  const MAX_REDIRECTS = 10;

  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`Too many redirects while downloading: ${url}`);
  }

  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectedUrl = new URL(response.headers.location, url).toString();
        response.resume();
        downloadToFile(redirectedUrl, targetPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      const file = fs.createWriteStream(targetPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (error) => {
        file.close(() => {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          reject(error);
        });
      });
    });

    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download timeout after ${HTTP_TIMEOUT_MS}ms`));
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

function normalizeLibraryTypeFilter(value) {
  const v = String(value || '').trim().toLowerCase();
  const aliases = {
    logo: 'logo_library',
    logos: 'logo_library',
    icon: 'icon_library',
    icons: 'icon_library',
    photo: 'media_library',
    photos: 'media_library',
    media: 'media_library',
    template: 'document_library',
    templates: 'document_library',
    document: 'document_library',
    documents: 'document_library',
  };
  return aliases[v] || v;
}

async function downloadLibraryAssets(library, assetsRootDir, skipExistingAsset = false) {
  const safeLibrary = sanitizeFilename(library.title);
  const libraryFolder = path.join(assetsRootDir, safeLibrary);
  fs.mkdirSync(libraryFolder, { recursive: true });

  const takenPaths = new Set();
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const asset of library.assets) {
    const assetFolder = path.join(libraryFolder, sanitizeFilename(asset.title || asset.id));
    fs.mkdirSync(assetFolder, { recursive: true });

    const files = pickAssetFileCandidates(asset);
    asset.localFiles = [];

    for (const file of files) {
      const safeName = sanitizeFilename(path.parse(file.filename).name);
      const ext = path.extname(file.filename) || (asset.extension ? `.${asset.extension}` : '.bin');
      const preferredPath = path.join(assetFolder, `${safeName}${ext}`);
      if (skipExistingAsset && fs.existsSync(preferredPath)) {
        const stat = fs.statSync(preferredPath);
        asset.localFiles.push({
          kind: file.kind,
          relativePath: path.relative(assetsRootDir, preferredPath),
          size: stat.size
        });
        skipped++;
        takenPaths.add(preferredPath);
        continue;
      }

      const targetPath = ensureUniquePath(preferredPath, takenPaths);
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

  return { success, failed, skipped };
}

async function exportGuideline(config) {
  const {
    domain,
    token,
    guidelineId: rawGuidelineId,
    guidelineN,
    guidelineName,
    outputName,
    structure,
    outputMode,
    probe,
    skipDownload,
    skipExistingAsset = false,
    dryRun,
    maxLibraries,
    maxAssetsPerLibrary,
    assetTypes = [],
    libraryTypes = []
  } = config;

  console.log('\nStarting Frontify Guideline Export\n');
  console.log(`  Domain: ${domain}`);
  console.log(`  Structure: ${structure}`);
  console.log(`  Output mode: ${outputMode}`);
  console.log(`  Download assets: ${dryRun || skipDownload ? 'no' : 'yes'}\n`);
  if (dryRun) {
    console.log('  Dry run: yes\n');
  }
  if (maxLibraries) {
    console.log(`  Max libraries: ${maxLibraries}`);
  }
  if (maxAssetsPerLibrary) {
    console.log(`  Max assets per library: ${maxAssetsPerLibrary}`);
  }
  if (assetTypes.length > 0) {
    console.log(`  Asset type filter: ${assetTypes.join(', ')}`);
  }
  if (libraryTypes.length > 0) {
    console.log(`  Library type filter: ${libraryTypes.join(', ')}`);
  }
  if (maxLibraries || maxAssetsPerLibrary || assetTypes.length > 0 || libraryTypes.length > 0) {
    console.log('');
  }

  if (probe) {
    await probeGraphQLEndpoint(domain, token);
  }

  let guidelineId = rawGuidelineId;
  if (!guidelineId && guidelineN !== undefined) {
    guidelineId = guidelineIdFromN(guidelineN);
  } else if (!guidelineId) {
    guidelineId = await resolveGuidelineIdByName(domain, token, guidelineName);
  }

  const { guidelineInfo, libraries: allLibraries } = await fetchGuidelineLibraries(
    domain,
    token,
    guidelineId,
    maxLibraries
  );

  const normalizedLibraryFilters = libraryTypes.map(normalizeLibraryTypeFilter);
  const bareLibraries = normalizedLibraryFilters.length === 0
    ? allLibraries
    : allLibraries.filter((lib) => {
      const type = String(lib.type || '').toLowerCase();
      const title = String(lib.title || '').toLowerCase();
      return normalizedLibraryFilters.some((f) => type === f || type.includes(f) || title.includes(f));
    });

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
    const filteredAssets = assetTypes.length === 0
      ? assets
      : assets.filter((asset) => {
        const candidateTypes = [asset.__typename, asset.type]
          .filter(Boolean)
          .map((v) => String(v).toLowerCase());
        return candidateTypes.some((t) => assetTypes.includes(t));
      });
    libraries.push({
      ...base,
      assets: filteredAssets,
      folderName: `${num}-${sanitizeFilename(base.title)}`
    });
    if (assetTypes.length > 0) {
      console.log(`${filteredAssets.length}/${assets.length} assets kept`);
    } else {
      console.log(`${filteredAssets.length} assets`);
    }
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
      const stats = await downloadLibraryAssets(library, assetsRootDir, skipExistingAsset);
      totalDownloadSuccess += stats.success;
      totalDownloadFailed += stats.failed;
      console.log(`ok (${stats.success} files, ${stats.skipped} skipped, ${stats.failed} failed)`);
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

module.exports = {
  exportGuideline
};
