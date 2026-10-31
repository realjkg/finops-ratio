# Bundled PDF fonts: provenance

Server-only assets for the engagement report PDF (`src/reports/pdfFonts.ts`). Read from this
directory at render time; never fetched. Not served to browsers (`npm run check:bundle` rule 6).
All files are the unmodified upstream files: react-pdf embeds only the glyphs a PDF uses
(a subset inside the generated document; the files here are never changed).

| File | Bytes | sha256 | Source (pinned) | Version |
|---|---|---|---|---|
| NotoSans-Regular.ttf | 431364 | f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/412a7edb2c8c535d1066157e5b17e661fd5591fe/fonts/NotoSans/unhinted/ttf/NotoSans-Regular.ttf | 2.015 |
| NotoSans-Bold.ttf | 432376 | 87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/412a7edb2c8c535d1066157e5b17e661fd5591fe/fonts/NotoSans/unhinted/ttf/NotoSans-Bold.ttf | 2.015 |
| NotoSansCJKsc-Regular.otf | 16437364 | 2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b | https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf (tag Sans2.004; identical bytes at commit f8d157532fbfaeda587e826d4cd5b21a49186f7c) | 2.004 |
| OFL.txt | 4374 | f2095b08bed08b23a6fe26112fcd679a2bee3f002eef077eb05d215ed1051bd8 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/412a7edb2c8c535d1066157e5b17e661fd5591fe/fonts/LICENSE | OFL 1.1 |

License: SIL Open Font License 1.1 (`OFL.txt`; the Noto CJK license file at
`https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE`, sha256
6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2, is the same OFL 1.1 text without a
copyright line). Copyright notices (from each font's name table):

- Noto Sans: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
- Noto Sans CJK SC: © 2014-2021 Adobe (http://www.adobe.com/).

Notices for redistribution: `docs/THIRD_PARTY_NOTICES.md`.

Why these files: Noto Sans covers the Latin, Greek and Cyrillic scripts (regular and bold).
The full (not the regional subset) Noto Sans CJK SC face is one 16.4 MB file that covers
Simplified Chinese, Japanese (kana and kanji) and Korean (Hangul); the three
regional subset faces (SC 8.3 MB, JP 4.5 MB, KR 4.6 MB, 17.4 MB together) cover the same
languages in three files for no saving. One regular CJK weight only (bold would add 16.9 MB):
CJK text in headings prints at the regular weight. Han characters take the Simplified
Chinese glyph forms in every cell (a cell carries no language tag).

Update procedure: download the new pinned file, record its source, size and sha256 here and in
`PDF_FONTS` (`src/reports/pdfFonts.ts`); the tests compare all three.
