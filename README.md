# Frontify Guideline Export Tool

Exports all content from a Frontify Brand Guideline into organized Markdown files, designed to be used as context for AI tools such as GitHub Copilot.

## Which Script Should I Use?

| Script | Output structure | Best for |
|--------|-----------------|----------|
| `export-guideline.js` ✅ **recommended** | Flat — one `.md` per section | Most guidelines; supports `--combine` for a single AI-ready file |
| `export-guideline-2.js` | Hierarchical — sections nested under document-ID folders | Guidelines that span multiple Frontify documents |

If you're not sure, start with `export-guideline.js`. The `--combine` flag it provides produces a single `combined.md` file that is ideal for loading as a GitHub Copilot AI skill.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v12 or later (no additional packages required)
- A Frontify API bearer token ([how to get one](https://developer.frontify.com/document/1006#/getting-started/authentication))
- The Guideline ID you want to export (base64-encoded ID from the Frontify URL)

### Setting your token (recommended)

Store your token in an environment variable so it never appears in shell history or process listings:

```bash
export FRONTIFY_TOKEN="your-bearer-token"
```

You can also pass it with `--token` directly, but the environment variable approach is more secure.

---

## Usage — `export-guideline.js`

```bash
node export-guideline.js \
  --guideline <GUIDELINE_ID> \
  --domain    <DOMAIN> \
  --output    <NAME> \
  [--token    <TOKEN>] \
  [--combine]
```

### Options

| Option | Required | Description |
|--------|----------|-------------|
| `--guideline` | Yes | The guideline ID to export (base64-encoded ID from Frontify) |
| `--domain` | Yes | Your Frontify domain (e.g. `weare.frontify.com`) |
| `--output` | Yes | Name of the subfolder in `./output/` to store the export |
| `--token` | No* | Frontify API bearer token (*use `FRONTIFY_TOKEN` env var instead) |
| `--combine` | No | Also write a single `combined.md` for use as an AI skill |
| `--help` | No | Show help message |

### Example

```bash
# With token in environment variable (recommended)
export FRONTIFY_TOKEN="your-bearer-token"

node export-guideline.js \
  --guideline "eyJpZGVudGlmaWVyIjozMjkxLCJ0eXBlIjoiZ3VpZGVsaW5lIn0=" \
  --domain    "weare.frontify.com" \
  --output    "my-brand" \
  --combine
```

---

## Output Structure

```
output/
└── my-brand/
    ├── 00-INDEX.md           # Table of contents with links to all sections
    ├── 01-getting-started.md # First section (in navigation order)
    ├── 02-brand-voice.md     # Second section
    ├── 03-visual-identity.md # Third section
    └── combined.md           # Single file containing all sections (with --combine)
```

Each section file looks like this:

```markdown
# Brand Name - Section Name

Guideline URL: https://...

---

## Page Title

URL: https://...

### Heading

Content here...

---

## Next Page Title
...
```

---

## Using the Output as a GitHub Copilot AI Skill

The `--combine` flag produces a single `combined.md` file that contains your entire brand guideline. This is the easiest way to load the guidelines as context in GitHub Copilot.

### Option 1 — GitHub Copilot Custom Instructions (simplest)

1. Run the export with `--combine`
2. Copy `combined.md` into your repository (e.g. `.github/brand-guidelines.md`)
3. Reference it in `.github/copilot-instructions.md`:

```markdown
# Copilot Instructions

When writing copy, code comments, or UI text, follow the brand guidelines in
@.github/brand-guidelines.md
```

### Option 2 — GitHub Copilot Workspace Context

Attach the relevant section file (or `combined.md`) directly in the Copilot Chat window using the **Attach context** button, or reference it with `#file:output/my-brand/combined.md` in a prompt.

### Option 3 — Load specific sections per task

```bash
# Review the index to find the relevant section
cat output/my-brand/00-INDEX.md

# Load a targeted section for a focused task
cat output/my-brand/03-visual-identity.md
# Then paste or attach it in your Copilot Chat
```

---

## Usage — `export-guideline-2.js`

Use this script when your Frontify portal has multiple documents under one guideline. The output is nested by document ID.

```bash
node export-guideline-2.js \
  --guideline <GUIDELINE_ID> \
  --domain    <DOMAIN> \
  --output    <NAME> \
  [--token    <TOKEN>]
```

Options are the same as `export-guideline.js` except `--combine` is not available.

### Output structure

```
output/
└── my-brand/
    ├── 00-INDEX.md
    ├── 2582/               # Document ID (from /document/2582 in the URL)
    │   ├── 01-tutorials.md
    │   └── 02-guides.md
    ├── 3291/
    │   ├── 01-building-a-theme.md
    │   └── 02-commands.md
    └── root/               # Pages that are not inside a specific document
        └── 01-overview.md
```

---

## Notes

- Both scripts handle pagination automatically (for pages and page sections)
- A small delay (100ms) is added between API requests to avoid rate limiting
- Pages are grouped by the first path segment in their URL hash (e.g. `#/getting-started/overview` → `getting-started`)
- Content is exported as plain text from the Frontify API
