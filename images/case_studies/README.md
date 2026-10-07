# Case-study photographs

One image per case study. Drop files in here with these exact names:

| Case study                    | File                        |
|-------------------------------|-----------------------------|
| Thacker Pass / Peehee Mu'huh  | `thacker-pass.jpg`          |
| Salar de Atacama              | `salar-de-atacama.jpg`      |
| Argentina Puna                | `argentina-puna.jpg`        |
| Jadar                         | `jadar.jpg`                 |
| Covas do Barroso              | `covas-do-barroso.jpg`      |
| Zimbabwe                      | `zimbabwe.jpg`              |

The filenames are set per study by `CASE_STUDY_PLACES` in `src/config.js`
(the `image` key), so rename them there if you prefer something else. A study
with no file simply renders without a picture — nothing breaks, and the
browser console names the file it looked for.

`.jpg`, `.png` and `.webp` all work; put the extension in the config entry.

Landscape crops around 1200 x 800 are ideal: they are shown as a wide band on
the rolodex card and as a hero image at the top of the case-study panel.
