# Primary source documents

Drop files here, then register each one in `DOCUMENTS` in `src/config.js`.
Nothing in this folder appears in the visualisation until it is registered —
the mapping is what gives a file its case study and its display name.

```js
export const DOCUMENTS = [
  { study: 'Jadar', file: 'jadar-eia-2021.pdf', label: 'Environmental impact assessment, 2021' },
];
```

* **study** — the case study's `name` exactly as `data/case_study_data.csv`
  spells it. Rename a study there and this has to be renamed too, or the
  document is dropped with a console warning.
* **file** — the filename inside this folder. Subfolders are fine:
  `serbia/jadar-eia.pdf`.
* **label** — what the reader sees. Write it for a reader, not a filesystem:
  "Environmental impact assessment, 2021", not "jadar_eia_v3_FINAL.pdf".

## What previews, and what does not

| | |
| --- | --- |
| `.pdf` | previews inline |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` `.avif` | previews inline |
| `.txt` `.md` `.csv` | previews inline as plain text |
| `.html` | previews inline |
| anything else | offers a download instead — browsers cannot render `.docx` or `.xlsx` without a converter |

Scanned documents are usually the largest thing on the page. A PDF over a few
MB is worth running through a compressor first; the preview loads the whole
file before it shows anything.
