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
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Frontify Guideline Export Tool

Usage:
  node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> --domain <DOMAIN> --output <NAME>

Options:
  --token      Your Frontify API bearer token (required)
  --guideline  The guideline ID to export (required)
  --domain     Your Frontify domain, e.g. "weare.frontify.com" (required)
  --output     Name of the output subfolder in ./output/ (required)
  --help       Show this help message

Example:
  node export-guideline.js --token abc123 --guideline eyJpZGVudGlmaWVyIjo... --domain weare.frontify.com --output appbridge-docs

  This creates: ./output/appbridge-docs/
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

// Group pages by document ID and section, preserving order
function groupPages(pages) {
  const documents = {};
  const documentOrder = []; // Track order documents are first seen
  
  for (const page of pages) {
    // Extract document ID from URL (e.g., /document/2582#/...)
    const docMatch = page.url?.match(/\/document\/(\d+)/);
    const docId = docMatch ? docMatch[1] : 'root';
    
    // Extract section from URL path (e.g., #/tutorials/overview -> tutorials)
    const sectionMatch = page.url?.match(/#\/([^/]+)/);
    const section = sectionMatch ? sectionMatch[1] : 'general';
    
    // Initialize document group if needed
    if (!documents[docId]) {
      documents[docId] = {
        sections: {},
        sectionOrder: []
      };
      documentOrder.push(docId);
    }
    
    // Initialize section within document if needed
    if (!documents[docId].sections[section]) {
      documents[docId].sections[section] = [];
      documents[docId].sectionOrder.push(section);
    }
    
    documents[docId].sections[section].push(page);
  }
  
  return { documents, documentOrder };
}

// Main export function
async function exportGuideline(domain, token, guidelineId, outputName) {
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
  
  // Group pages by document and section
  const { documents, documentOrder } = groupPages(pages);
  
  console.log(`📁 Found ${documentOrder.length} documents: ${documentOrder.join(', ')}\n`);
  
  // Process each document
  for (const docId of documentOrder) {
    const doc = documents[docId];
    
    // Create document folder
    const docFolder = path.join(fullOutputDir, docId);
    if (!fs.existsSync(docFolder)) {
      fs.mkdirSync(docFolder, { recursive: true });
    }
    
    console.log(`\n📄 Document: ${docId}`);
    
    // Process each section within this document
    for (let i = 0; i < doc.sectionOrder.length; i++) {
      const sectionName = doc.sectionOrder[i];
      const sectionPages = doc.sections[sectionName];
      const sectionNum = String(i + 1).padStart(2, '0');
      
      console.log(`  Processing section ${sectionNum}: ${sectionName} (${sectionPages.length} pages)`);
      
      let sectionMarkdown = `# ${guidelineInfo.name} - ${sectionName}\n\n`;
      sectionMarkdown += `Document: ${docId}\n`;
      sectionMarkdown += `Guideline URL: ${guidelineInfo.url}\n\n`;
      sectionMarkdown += `---\n\n`;
      
      let processedCount = 0;
      
      for (const page of sectionPages) {
        process.stdout.write(`    Fetching: ${page.title}... `);
        
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
      const filepath = path.join(docFolder, filename);
      fs.writeFileSync(filepath, sectionMarkdown);
      
      console.log(`    ✓ Wrote ${docId}/${filename} (${processedCount} pages)`);
    }
  }
  
  // Write index file
  const indexMarkdown = generateIndex(guidelineInfo, documents, documentOrder);
  fs.writeFileSync(path.join(fullOutputDir, '00-INDEX.md'), indexMarkdown);
  
  console.log(`\n✅ Export complete! Files written to: ${fullOutputDir}\n`);
}

// Generate index file
function generateIndex(guidelineInfo, documents, documentOrder) {
  let md = `# ${guidelineInfo.name} - Export Index\n\n`;
  md += `Exported from: ${guidelineInfo.url}\n\n`;
  md += `## Documents\n\n`;
  
  for (const docId of documentOrder) {
    const doc = documents[docId];
    md += `### 📄 [${docId}](./${docId}/)\n\n`;
    
    for (let i = 0; i < doc.sectionOrder.length; i++) {
      const sectionName = doc.sectionOrder[i];
      const pages = doc.sections[sectionName];
      const sectionNum = String(i + 1).padStart(2, '0');
      const filename = `${sectionNum}-${sanitizeFilename(sectionName)}.md`;
      
      md += `#### ${sectionNum}. [${sectionName}](./${docId}/${filename})\n\n`;
      
      for (const page of pages) {
        md += `- ${page.title}\n`;
      }
      md += '\n';
    }
  }
  
  return md;
}

// Run
const args = parseArgs();
exportGuideline(args.domain, args.token, args.guidelineId, args.outputName)
  .catch(err => {
    console.error('\n❌ Export failed:', err.message);
    process.exit(1);
  });