#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  
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
    } else if (args[i] === '--combine') {
      parsed.combine = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Frontify Guideline Export Tool

Usage:
  node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> --domain <DOMAIN> --output <NAME> [--combine]

Options:
  --token      Your Frontify API bearer token (or set FRONTIFY_TOKEN env var)
  --guideline  The guideline ID to export (required)
  --domain     Your Frontify domain, e.g. "weare.frontify.com" (required)
  --output     Name of the output subfolder in ./output/ (required)
  --combine    Also write a single combined.md file (useful for AI skills)
  --help       Show this help message

Example:
  node export-guideline.js --token abc123 --guideline eyJpZGVudGlmaWVyIjo... --domain weare.frontify.com --output appbridge-docs

  This creates: ./output/appbridge-docs/
      `);
      process.exit(0);
    }
  }

  // Fall back to environment variable if token not provided via CLI
  if (!parsed.token && process.env.FRONTIFY_TOKEN) {
    parsed.token = process.env.FRONTIFY_TOKEN;
  }

  if (!parsed.token) {
    console.error('Error: --token is required (or set the FRONTIFY_TOKEN environment variable)');
    process.exit(1);
  }
  if (!parsed.guidelineId) {
    console.error('Error: --guideline is required');
    process.exit(1);
  }
  if (!parsed.domain) {
    console.error('Error: --domain is required (e.g. weare.frontify.com)');
    process.exit(1);
  }
  if (!parsed.outputName) {
    console.error('Error: --output is required (name for the output subfolder)');
    process.exit(1);
  }
  
  // Clean up domain if user includes protocol
  parsed.domain = parsed.domain.replace(/^https?:\/\//, '').replace(/\/graphql$/, '').replace(/\/$/, '');
  
  return parsed;
}

// GraphQL request helper
async function graphqlRequest(domain, token, query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: domain,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-frontify-beta': 'enabled',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            reject(new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`));
          } else {
            resolve(parsed.data);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Fetch all pages from a guideline (handles pagination)
async function fetchAllGuidelinePages(domain, token, guidelineId) {
  const query = `
    query GuidelinePages($guidelineId: ID!, $page: Int!) {
      node(id: $guidelineId) {
        ... on Guideline {
          id
          name
          defaultLanguage {
            name
            code
          }
          url
          pages(page: $page) {
            items {
              id
              title
              url
            }
            hasNextPage
          }
        }
      }
    }
  `;
  
  let allPages = [];
  let guidelineInfo = null;
  let currentPage = 1;
  let hasNextPage = true;
  
  console.log('Fetching guideline pages...');
  
  while (hasNextPage) {
    const data = await graphqlRequest(domain, token, query, { guidelineId, page: currentPage });
    const guideline = data.node;
    
    if (!guideline) {
      throw new Error('Guideline not found');
    }
    
    if (!guidelineInfo) {
      guidelineInfo = {
        id: guideline.id,
        name: guideline.name,
        url: guideline.url,
        defaultLanguage: guideline.defaultLanguage
      };
    }
    
    allPages = allPages.concat(guideline.pages.items);
    hasNextPage = guideline.pages.hasNextPage;
    
    console.log(`  Page ${currentPage}: fetched ${guideline.pages.items.length} pages (total: ${allPages.length})`);
    currentPage++;
  }
  
  return { guidelineInfo, pages: allPages };
}

// Fetch content for a single page (handles section pagination)
async function fetchPageContent(domain, token, pageId, languageCode = null) {
  const query = `
    query GuidelinePageContent($pageId: ID!, $languageCode: LanguageCode, $sectionPage: Int!) {
      guidelinePage(id: $pageId, language: $languageCode) {
        id
        title
        url
        sections(page: $sectionPage) {
          hasNextPage
          total
          page
          items {
            id
            elements {
              items {
                ... on GuidelinePageBlock {
                  id
                  content
                  url
                }
                ... on GuidelinePageHeading {
                  id
                  title
                }
                ... on GuidelinePageBlockReference {
                  block {
                    id
                    content
                    url
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  
  let allSections = [];
  let pageInfo = null;
  let sectionPage = 1;
  let hasNextPage = true;
  
  while (hasNextPage) {
    const data = await graphqlRequest(domain, token, query, { 
      pageId, 
      languageCode, 
      sectionPage 
    });
    
    const page = data.guidelinePage;
    
    if (!page) {
      console.warn(`  Warning: Could not fetch page ${pageId}`);
      return null;
    }
    
    if (!pageInfo) {
      pageInfo = {
        id: page.id,
        title: page.title,
        url: page.url
      };
    }
    
    allSections = allSections.concat(page.sections.items);
    hasNextPage = page.sections.hasNextPage;
    sectionPage++;
  }
  
  return { ...pageInfo, sections: allSections };
}

// Convert page content to Markdown
function pageToMarkdown(pageContent) {
  if (!pageContent) return '';
  
  let md = `## ${pageContent.title}\n\n`;
  md += `URL: ${pageContent.url}\n\n`;
  
  for (const section of pageContent.sections) {
    if (!section.elements?.items) continue;
    
    for (const element of section.elements.items) {
      // Handle headings
      if (element.title !== undefined) {
        md += `### ${element.title}\n\n`;
      }
      // Handle blocks (direct or referenced)
      else if (element.content !== undefined) {
        md += `${element.content}\n\n`;
      }
      // Handle block references
      else if (element.block) {
        md += `${element.block.content}\n\n`;
      }
    }
  }
  
  return md;
}

// Sanitize string for use as filename
function sanitizeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .substring(0, 100);
}

// Group pages by their URL path structure, preserving order
function groupPagesBySection(pages) {
  const groups = {};
  const sectionOrder = []; // Track order sections are first seen
  
  for (const page of pages) {
    // Extract section from URL path
    // e.g., https://weare.frontify.com/document/3291#/appbridgetheme/commands
    // -> section = "appbridgetheme"
    const urlMatch = page.url?.match(/#\/([^/]+)/);
    const section = urlMatch ? urlMatch[1] : 'general';
    
    if (!groups[section]) {
      groups[section] = [];
      sectionOrder.push(section); // Track when we first see this section
    }
    groups[section].push(page);
  }
  
  return { groups, sectionOrder };
}

// Main export function
async function exportGuideline(domain, token, guidelineId, outputName, combine = false) {
  console.log('\n🚀 Starting Frontify Guideline Export\n');
  console.log(`   Domain: ${domain}\n`);
  
  // Fetch all pages first to get guideline name
  const { guidelineInfo, pages } = await fetchAllGuidelinePages(domain, token, guidelineId);
  
  // Create output directory: ./output/<outputName>/
  const fullOutputDir = path.join('./output', outputName);
  
  if (!fs.existsSync(fullOutputDir)) {
    fs.mkdirSync(fullOutputDir, { recursive: true });
  }
  
  console.log(`\n📚 Guideline: ${guidelineInfo.name}`);
  console.log(`   URL: ${guidelineInfo.url}`);
  console.log(`   Total pages: ${pages.length}\n`);
  
  // Group pages by section
  const { groups: groupedPages, sectionOrder } = groupPagesBySection(pages);
  
  console.log(`📁 Found ${sectionOrder.length} sections: ${sectionOrder.join(', ')}\n`);
  
  // Process each section in order
  const sectionFiles = [];

  for (let i = 0; i < sectionOrder.length; i++) {
    const sectionName = sectionOrder[i];
    const sectionPages = groupedPages[sectionName];
    const sectionNum = String(i + 1).padStart(2, '0'); // 01, 02, 03...
    
    console.log(`\nProcessing section ${sectionNum}: ${sectionName} (${sectionPages.length} pages)`);
    
    let sectionMarkdown = `# ${guidelineInfo.name} - ${sectionName}\n\n`;
    sectionMarkdown += `Guideline URL: ${guidelineInfo.url}\n\n`;
    sectionMarkdown += `---\n\n`;
    
    let processedCount = 0;
    
    for (const page of sectionPages) {
      process.stdout.write(`  Fetching: ${page.title}... `);
      
      try {
        const pageContent = await fetchPageContent(
          domain,
          token, 
          page.id, 
          guidelineInfo.defaultLanguage?.code
        );
        
        if (pageContent) {
          sectionMarkdown += pageToMarkdown(pageContent);
          sectionMarkdown += `---\n\n`;
          processedCount++;
          console.log('✓');
        } else {
          console.log('⚠ (skipped)');
        }
      } catch (err) {
        console.log(`✗ (${err.message})`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Write section file with numbered prefix
    const filename = `${sectionNum}-${sanitizeFilename(sectionName)}.md`;
    const filepath = path.join(fullOutputDir, filename);
    fs.writeFileSync(filepath, sectionMarkdown);
    sectionFiles.push({ filename, markdown: sectionMarkdown });
    
    console.log(`  ✓ Wrote ${filename} (${processedCount} pages)`);
  }
  
  // Write index file
  const indexMarkdown = generateIndex(guidelineInfo, groupedPages, sectionOrder);
  fs.writeFileSync(path.join(fullOutputDir, '00-INDEX.md'), indexMarkdown);

  // Write combined file if requested (ideal for loading as a single AI skill context)
  if (combine) {
    let combinedMarkdown = indexMarkdown + '\n---\n\n';
    for (const { markdown } of sectionFiles) {
      combinedMarkdown += markdown;
    }
    const combinedPath = path.join(fullOutputDir, 'combined.md');
    fs.writeFileSync(combinedPath, combinedMarkdown);
    console.log(`  ✓ Wrote combined.md (single file for AI skill use)`);
  }
  
  console.log(`\n✅ Export complete! Files written to: ${fullOutputDir}\n`);
}

// Generate index file
function generateIndex(guidelineInfo, groupedPages, sectionOrder) {
  let md = `# ${guidelineInfo.name} - Export Index\n\n`;
  md += `Exported from: ${guidelineInfo.url}\n\n`;
  md += `## Sections\n\n`;
  
  for (let i = 0; i < sectionOrder.length; i++) {
    const sectionName = sectionOrder[i];
    const pages = groupedPages[sectionName];
    const sectionNum = String(i + 1).padStart(2, '0');
    const filename = `${sectionNum}-${sanitizeFilename(sectionName)}.md`;
    
    md += `### ${sectionNum}. [${sectionName}](./${filename})\n\n`;
    
    for (const page of pages) {
      md += `- ${page.title}\n`;
    }
    md += '\n';
  }
  
  return md;
}

// Run
const args = parseArgs();
exportGuideline(args.domain, args.token, args.guidelineId, args.outputName, args.combine)
  .catch(err => {
    console.error('\n❌ Export failed:', err.message);
    process.exit(1);
  });