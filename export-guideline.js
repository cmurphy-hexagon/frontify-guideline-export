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
      parsed.outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Frontify Guideline Export Tool

Usage:
  node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> [--output <DIR>]

Options:
  --token      Your Frontify API bearer token (required)
  --guideline  The guideline ID to export (required)
  --output     Output directory (default: ./guideline-export-output)
  --help       Show this help message

Example:
  node export-guideline.js --token abc123 --guideline eyJpZGVudGlmaWVyIjo...
      `);
      process.exit(0);
    }
  }
  
  if (!parsed.token) {
    console.error('Error: --token is required');
    process.exit(1);
  }
  if (!parsed.guidelineId) {
    console.error('Error: --guideline is required');
    process.exit(1);
  }
  
  parsed.outputDir = parsed.outputDir || './guideline-export-output';
  return parsed;
}

// GraphQL request helper
async function graphqlRequest(token, query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.frontify.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
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
async function fetchAllGuidelinePages(token, guidelineId) {
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
    const data = await graphqlRequest(token, query, { guidelineId, page: currentPage });
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
async function fetchPageContent(token, pageId, languageCode = null) {
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
    const data = await graphqlRequest(token, query, { 
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
        if (element.url) {
          md += `*Source: ${element.url}*\n\n`;
        }
      }
      // Handle block references
      else if (element.block) {
        md += `${element.block.content}\n\n`;
        if (element.block.url) {
          md += `*Source: ${element.block.url}*\n\n`;
        }
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

// Group pages by their URL path structure
function groupPagesBySection(pages) {
  const groups = {};
  
  for (const page of pages) {
    // Extract section from URL path
    // e.g., https://weare.frontify.com/document/3291#/appbridgetheme/commands
    // -> section = "appbridgetheme"
    const urlMatch = page.url?.match(/#\/([^/]+)/);
    const section = urlMatch ? urlMatch[1] : 'general';
    
    if (!groups[section]) {
      groups[section] = [];
    }
    groups[section].push(page);
  }
  
  return groups;
}

// Main export function
async function exportGuideline(token, guidelineId, outputDir) {
  console.log('\n🚀 Starting Frontify Guideline Export\n');
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Fetch all pages
  const { guidelineInfo, pages } = await fetchAllGuidelinePages(token, guidelineId);
  
  console.log(`\n📚 Guideline: ${guidelineInfo.name}`);
  console.log(`   URL: ${guidelineInfo.url}`);
  console.log(`   Total pages: ${pages.length}\n`);
  
  // Group pages by section
  const groupedPages = groupPagesBySection(pages);
  const sections = Object.keys(groupedPages);
  
  console.log(`📁 Found ${sections.length} sections: ${sections.join(', ')}\n`);
  
  // Process each section
  for (const sectionName of sections) {
    const sectionPages = groupedPages[sectionName];
    console.log(`\nProcessing section: ${sectionName} (${sectionPages.length} pages)`);
    
    let sectionMarkdown = `# ${guidelineInfo.name} - ${sectionName}\n\n`;
    sectionMarkdown += `Guideline URL: ${guidelineInfo.url}\n\n`;
    sectionMarkdown += `---\n\n`;
    
    let processedCount = 0;
    
    for (const page of sectionPages) {
      process.stdout.write(`  Fetching: ${page.title}... `);
      
      try {
        const pageContent = await fetchPageContent(
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
    
    // Write section file
    const filename = `${sanitizeFilename(sectionName)}.md`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, sectionMarkdown);
    
    console.log(`  ✓ Wrote ${filename} (${processedCount} pages)`);
  }
  
  // Write index file
  const indexMarkdown = generateIndex(guidelineInfo, groupedPages, outputDir);
  fs.writeFileSync(path.join(outputDir, 'INDEX.md'), indexMarkdown);
  
  console.log(`\n✅ Export complete! Files written to: ${outputDir}\n`);
}

// Generate index file
function generateIndex(guidelineInfo, groupedPages, outputDir) {
  let md = `# ${guidelineInfo.name} - Export Index\n\n`;
  md += `Exported from: ${guidelineInfo.url}\n\n`;
  md += `## Sections\n\n`;
  
  for (const [sectionName, pages] of Object.entries(groupedPages)) {
    const filename = `${sanitizeFilename(sectionName)}.md`;
    md += `### [${sectionName}](./${filename})\n\n`;
    
    for (const page of pages) {
      md += `- ${page.title}\n`;
    }
    md += '\n';
  }
  
  return md;
}

// Run
const args = parseArgs();
exportGuideline(args.token, args.guidelineId, args.outputDir)
  .catch(err => {
    console.error('\n❌ Export failed:', err.message);
    process.exit(1);
  });
