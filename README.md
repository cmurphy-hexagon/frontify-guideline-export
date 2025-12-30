# Frontify Guideline Export Tool

Exports all content from a Frontify Brand Guideline into organized Markdown files for use as LLM context.

## Usage

```bash
node export-guideline.js --token <TOKEN> --guideline <GUIDELINE_ID> [--output <DIR>]
```

### Options

| Option | Required | Description |
|--------|----------|-------------|
| `--token` | Yes | Your Frontify API bearer token |
| `--guideline` | Yes | The guideline ID to export (base64 encoded ID from Frontify) |
| `--output` | No | Output directory (default: `./guideline-export-output`) |
| `--help` | No | Show help message |

### Example

```bash
node export-guideline.js \
  --token "your-bearer-token" \
  --guideline "eyJpZGVudGlmaWVyIjozMjkxLCJ0eXBlIjoiZ3VpZGVsaW5lIn0=" \
  --output "./appbridge-docs"
```

## Output Structure

The tool creates one Markdown file per section (based on URL path structure):

```
output-dir/
├── INDEX.md              # Overview with links to all sections
├── appbridgetheme.md     # All pages under /appbridgetheme/...
├── getting-started.md    # All pages under /getting-started/...
└── general.md            # Pages without clear section
```

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
# For a specific section
cat appbridge-docs/appbridgetheme.md | pbcopy
# Then paste into Claude conversation

# For all content
cat appbridge-docs/*.md > full-context.md
```

## Notes

- The tool handles pagination automatically for both pages and sections
- A small delay (100ms) is added between requests to avoid rate limiting
- Pages are grouped by the first path segment in their URL hash
- Content is preserved as-is (plain text from Frontify's API)
