# Licenses and third-party notices

The supplied Agentaus app bundles third-party components. Their embedded
notices are retained in the app source, and the notice texts are provided in
this folder. Retain both when redistributing the bundle.

## Component map

| Component | License | Notice file in this folder |
| --- | --- | --- |
| fflate | MIT — Copyright (c) 2019 Andrew Dillon | `THIRD-PARTY-NOTICES.txt` |
| PDF-LIB | MIT — Copyright (c) 2014-present Devon Govett | `THIRD-PARTY-NOTICES.txt` |
| fontkit | MIT — Copyright (c) 2014-present Devon Govett | `THIRD-PARTY-NOTICES.txt` |
| Noto fonts | SIL Open Font License, Version 1.1 — Copyright Google Inc. 2010, 2012-2020; Google LLC 2015-2020 | `THIRD-PARTY-NOTICES.txt`, `NOTO_FONT_LICENSE.txt` |
| DejaVu fonts and Debian packaging | GPL-3+ — Jonas Smedegaard, Purism SPC, Vasudev Kamath | `THIRD-PARTY-NOTICES.txt`, `GPL-3.txt` |
| PDF.js | Apache License, Version 2.0 (mozilla/pdf.js) | `Apache-2.0.txt` |
| TypeScript compiler banner in the bundled PDF-LIB code | Apache License, Version 2.0 — Copyright (c) Microsoft Corporation | `Apache-2.0.txt` |

## Files

- `THIRD-PARTY-NOTICES.txt` — a verbatim copy of the "Bundled third-party
  notices and font licenses" block embedded in `app.js` (the fflate and PDF-LIB
  MIT licenses, the Noto and Debian font notices, and the complete OFL-1.1 text).
- `NOTO_FONT_LICENSE.txt` — the Noto portion of that block (Debian
  copyright-format header and the OFL-1.1 text). The app source's Noto Sans
  notice points to a file of this name.
- `Apache-2.0.txt` — the full text of the Apache License, Version 2.0,
  January 2004. Applies to PDF.js and to the TypeScript banner printed inside
  the bundled PDF-LIB code.
- `GPL-3.txt` — the full text of the GNU General Public License, version 3.
  Referenced by the GPL-3+ notices for the Debian font packaging in the
  embedded notice block.

Nothing in this folder modifies the upstream license terms; these are the
notice texts the bundled components carry.
