# Frontify Guideline Export Tool

Exports all content from a Frontify Brand Guideline into organized Markdown files for use as LLM context.

## Usage

```bash
node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> --domain <DOMAIN> --output <NAME>
```

### Options

| Option | Required | Description |
|--------|----------|-------------|
| `--token` | Yes | Your Frontify API bearer token |
| `--guideline` | Yes | The guideline ID to export (base64 encoded ID from Frontify) |
| `--domain` | Yes | Your Frontify domain (e.g., `weare.frontify.com`, `demo.frontify.com`) |
| `--output` | Yes | Name of the subfolder in `./output/` to store the export |
| `--help` | No | Show help message |

### Example

```bash
node export-guideline.js \
  --token "your-bearer-token" \
  --guideline "eyJpZGVudGlmaWVyIjozMjkxLCJ0eXBlIjoiZ3VpZGVsaW5lIn0=" \
  --domain "weare.frontify.com" \
  --output "appbridge-docs"
```

This creates: `./output/appbridge-docs/`

## Output Structure

The tool creates a subfolder in `./output/` with numbered section files that preserve the original navigation order:

```
output/                           # Hardcoded root (gitignored)
└── appbridge-docs/               # Your --output name
    ├── 00-INDEX.md               # Overview with links to all sections
    ├── 01-getting-started.md     # First section (in navigation order)
    ├── 02-building-a-theme.md    # Second section
    ├── 03-appbridgetheme.md      # Third section
    └── 04-commands.md            # etc.
```

Pages within each section file are also preserved in their original order.

Each section file contains:

```markdown
# Guideline Name - Section Name

Guideline URL: https://...

---

## Page Title

URL: https://...

### Heading

Block content here...

*Source: https://...*

---

## Next Page Title
...
```

## Using with LLMs

The output is designed for selective context loading:

1. **Quick reference**: Load `INDEX.md` to see available sections
2. **Targeted context**: Load only the section file relevant to your current task
3. **Full context**: Concatenate all files if you need comprehensive coverage

### Example: Loading into Claude

```bash
# For a specific section (in order)
cat output/appbridge-docs/02-building-a-theme.md | pbcopy
# Then paste into Claude conversation

# For all content from one export (in order)
cat output/appbridge-docs/*.md > full-context.md
```

## Notes

- The tool handles pagination automatically for both pages and sections
- A small delay (100ms) is added between requests to avoid rate limiting
- Pages are grouped by the first path segment in their URL hash
- Content is preserved as-is (plain text from Frontify's API)



# Frontify Guideline Export Tool TWOOOO (two seperate files - don't judge - trying to move quick)

Exports all content from a Frontify Brand Guideline into organized Markdown files for use as LLM context.

## Usage

```bash
node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> --domain <DOMAIN> --output <NAME>
```

### Options

| Option | Required | Description |
|--------|----------|-------------|
| `--token` | Yes | Your Frontify API bearer token |
| `--guideline` | Yes | The guideline ID to export (base64 encoded ID from Frontify) |
| `--domain` | Yes | Your Frontify domain (e.g., `weare.frontify.com`, `demo.frontify.com`) |
| `--output` | Yes | Name of the subfolder in `./output/` to store the export |
| `--help` | No | Show help message |

### Example

```bash
node export-guideline.js \
  --token "your-bearer-token" \
  --guideline "eyJpZGVudGlmaWVyIjozMjkxLCJ0eXBlIjoiZ3VpZGVsaW5lIn0=" \
  --domain "weare.frontify.com" \
  --output "appbridge-docs"
```

This creates: `./output/appbridge-docs/`

## Output Structure

The tool creates a subfolder in `./output/` organized by document ID, with numbered section files that preserve the original navigation order:

```
output/                              # Hardcoded root (gitignored)
└── appbridge-docs/                  # Your --output name
    ├── 00-INDEX.md                  # Overview with links to all documents/sections
    ├── 2582/                        # Document ID (from /document/2582 in URL)
    │   ├── 01-tutorials.md
    │   └── 02-guides.md
    ├── 3291/                        # Another document ID
    │   ├── 01-building-a-theme.md
    │   ├── 02-appbridgetheme.md
    │   └── 03-commands.md
    └── root/                        # Pages without a document ID (e.g., hub pages)
        └── 01-overview.md
```

Pages within each section file are preserved in their original navigation order.

Each section file contains:

```markdown
# Guideline Name - Section Name

Guideline URL: https://...

---

## Page Title

URL: https://...

### Heading

Block content here...

*Source: https://...*

---

## Next Page Title
...
```

## Using with LLMs

The output is designed for selective context loading:

1. **Quick reference**: Load `INDEX.md` to see available sections
2. **Targeted context**: Load only the section file relevant to your current task
3. **Full context**: Concatenate all files if you need comprehensive coverage

### Example: Loading into Claude

```bash
# For a specific section from a specific document
cat output/appbridge-docs/3291/02-appbridgetheme.md | pbcopy

# For all content from one document
cat output/appbridge-docs/3291/*.md > doc-3291-context.md

# For all content from the entire export
cat output/appbridge-docs/**/*.md > full-context.md
```

## Notes

- The tool handles pagination automatically for both pages and sections
- A small delay (100ms) is added between requests to avoid rate limiting
- Pages are grouped by the first path segment in their URL hash
- Content is preserved as-is (plain text from Frontify's API)