# Frontify Guideline Export Tool

Exports Frontify guideline library content and assets into Markdown plus downloaded files for AI and archival workflows.

## What it exports

- Guideline metadata (`name`, `url`)
- Library pages from `Guideline.libraryPages`
- All assets from each library with pagination
- Optional local downloads of each asset and its attachments

## Prerequisites

- Node.js 18+
- Frontify API bearer token
- A way to identify the guideline: its numeric identifier (`--guideline-n`), its name (`--guideline-name`), or the raw base64 ID (`--guideline`)

Set your token as an environment variable:

```bash
export FRONTIFY_TOKEN="your-token"
```

PowerShell:

```powershell
$env:FRONTIFY_TOKEN = "your-token"
```

## Usage

```bash
node export-guideline.js \
  (--guideline-n <N> | --guideline-name "<name>" | --guideline <ID>) \
  --domain <DOMAIN> \
  --output <NAME> \
  [--token <TOKEN>] \
  [--structure <flat|by-document>] \
  [--output-mode <split|combined|both>] \
  [--probe] \
  [--dry-run] \
  [--skip-download] \
  [--max-libraries <N>] \
  [--max-assets-per-library <N>]
```

## Options

- `--guideline-n` Numeric identifier only (e.g. `6`); constructs the base64 ID automatically. _(one of the three is required)_
- `--guideline-name` Guideline display name (e.g. `"Octave"`); enumerates identifiers 1–200 to locate it. _(one of the three is required)_
- `--guideline` Full base64 node ID, for explicit overrides or CI pipelines. _(one of the three is required)_
- `--domain` Required. Frontify domain, for example `brand.octave.com`.
- `--output` Required. Output folder name under `./output/`.
- `--token` Optional if `FRONTIFY_TOKEN` is set.
- `--structure` Optional. `flat` or `by-document` (default `flat`).
- `--output-mode` Optional. `split`, `combined`, or `both` (default `split`).
- `--combine` Alias for `--output-mode both`.
- `--probe` Optional. Validates GraphQL endpoint/auth before export.
- `--dry-run` Optional. Print a summary only (no files, no downloads).
- `--skip-download` Optional. Export metadata markdown only.
- `--max-libraries` Optional. Limit exported libraries (debug/smoke helper).
- `--max-assets-per-library` Optional. Limit assets per library (debug/smoke helper).

## Examples

```bash
node export-guideline.js \
  --guideline-n 6 \
  --domain "brand.octave.com" \
  --output "octave-full" \
  --structure flat \
  --output-mode both \
  --probe
```

```bash
node export-guideline.js \
  --guideline-name "Octave" \
  --domain "brand.octave.com" \
  --output "octave-metadata" \
  --output-mode combined \
  --skip-download
```

```bash
node export-guideline.js \
  --guideline-n 6 \
  --domain "brand.octave.com" \
  --output "octave-dryrun" \
  --dry-run \
  --probe
```

```bash
node export-guideline.js \
  --guideline-n 6 \
  --domain "brand.octave.com" \
  --output "octave-smoke" \
  --probe \
  --skip-download \
  --max-libraries 1 \
  --max-assets-per-library 5
```

## Output layout

Flat example:

```text
output/
  octave-full/
    00-INDEX.md
    01-logo-library.md
    02-icon-library.md
    combined.md
    assets/
      logo-library/
      icon-library/
      ...
```

By-document example:

```text
output/
  octave-full/
    00-INDEX.md
    01-logo-library/
      01-logo-library.md
    02-icon-library/
      02-icon-library.md
    combined.md
    assets/
      ...
```

## Notes

- The script uses Frontify GraphQL `libraryPages` and paginated `assets(page, limit)`.
- Attachments are downloaded in addition to primary asset files.
- Existing files are not overwritten; duplicate names are suffixed automatically.
- If `--skip-download` is used, markdown still includes remote download URLs.
