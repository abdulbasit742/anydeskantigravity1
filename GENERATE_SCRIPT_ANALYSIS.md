# Generate Script Analysis

## Source reviewed

Uploaded file: `generate.js`

## What the original script does

The uploaded script is a bulk code generator. It creates:

- 75 React component files under `src/components/generated/`
- 75 JavaScript utility files under `src/lib/generated/`
- 150 files total

## Issue found

The original path was designed for this location:

```text
.agents/skills/bulk_code_writer/scripts/generate.js
```

Because it used:

```js
path.join(__dirname, '../../../../src')
```

If copied directly into this repository, that relative path could generate files outside the intended folder.

## Fix applied

I added a safer repo-ready version at:

```text
tools/generate-features.mjs
```

This version:

- writes to `<repo>/src/` by default
- supports `FEATURE_COUNT=...`
- supports `--count=...`
- caps generated file count to avoid accidental huge output
- keeps the original 75 + 75 behavior as the default

## Usage

```bash
node tools/generate-features.mjs
```

Custom count:

```bash
node tools/generate-features.mjs --count=25
```

Custom React base path:

```bash
REACT_BASE=./my-react-app/src node tools/generate-features.mjs
```
