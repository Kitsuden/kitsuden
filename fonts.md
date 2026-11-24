# Fonts

Which typefaces Kitsuden ships and where each one goes. Decided 2026-11-23.

| Surface                                                     | Headings    | Body and UI | Code, IDs, logs |
| ----------------------------------------------------------- | ----------- | ----------- | --------------- |
| Product panels opened to users (CRM, CMS, bot builder)      | Inter Tight | Inter       | JetBrains Mono  |
| Kitsuden (the core admin)                                   | Geist       | Geist       | Geist Mono      |
| A fresh CMS instance (the starter blog and its sample post) | Urbanist    | Lora        | JetBrains Mono  |

- **Inter** is built for screens at 12–14 px: tall x-height, tabular figures,
  slashed zero and alternates that tell `I`, `l` and `1` apart.
- **Inter Tight** is Inter with tighter spacing, for large headings and
  headline figures only.
- **JetBrains Mono** for code, IDs, tokens and logs next to Inter.
- **Geist + Geist Mono** are one family designed as a pair, with a technical,
  developer-tool feel.
- **Urbanist** gives a freshly installed site a friendly face of its own.
  Headings only: at paragraph sizes a text face reads better.
- **Lora** is a serif made for long reading on screens, for the body of posts.

## Landings and docs

| Landing                                                 | Headings | Body                                     |
| ------------------------------------------------------- | -------- | ---------------------------------------- |
| Kitsuden (the backend for agents)                       | Geist    | Geist (Geist Mono for code and commands) |
| Kitsuden kons (module catalog)                          | Geist    | Inter                                    |
| Inti, tallao, CMS (products for building and designing) | Urbanist | Lora in long texts                       |

- **Kitsuden** uses the same face as its admin: whoever goes from the landing to
  the panel sees one identity.
- **The kons catalog** is cards and data: Inter in the card text, Geist in the
  headlines.
- **Inti, tallao and the CMS** are for people who build things: the friendly
  geometric face gives them more personality than a neutral sans.
- **The docs and GitHub Pages of tallao and Inti** both go in Inter (with
  JetBrains Mono for code), self-hosted on the site.

## Licenses

All seven are under the **SIL Open Font License 1.1 (OFL)**. They can be
committed to the public repository, bundled in the starter and in the CMS, and
shipped inside paid products.

| Font           | License | Source                                                          |
| -------------- | ------- | --------------------------------------------------------------- |
| Inter          | OFL 1.1 | rsms.me/inter, Google Fonts, `@fontsource-variable/inter`       |
| Inter Tight    | OFL 1.1 | Google Fonts, `@fontsource-variable/inter-tight`                |
| JetBrains Mono | OFL 1.1 | jetbrains.com/lp/mono, `@fontsource-variable/jetbrains-mono`    |
| Geist          | OFL 1.1 | vercel.com/font, npm `geist`, `@fontsource-variable/geist`      |
| Geist Mono     | OFL 1.1 | vercel.com/font, npm `geist`, `@fontsource-variable/geist-mono` |
| Urbanist       | OFL 1.1 | Google Fonts, `@fontsource-variable/urbanist`                   |
| Lora           | OFL 1.1 | Google Fonts, `@fontsource-variable/lora`                       |

What the OFL asks:

- Ship the license text (`OFL.txt`) next to the font files.
- Do not sell the fonts on their own; inside a product is fine.
- A modified font that declares a Reserved Font Name cannot keep that name.
  Using the files as published, including @fontsource's per-script subsets, is
  normal use.

## Rules

- **Self-host.** Serve the files from our own origin; never load them from
  Google Fonts or another CDN (no third-party requests, no IP sent to Google).
- **Variable files**: one file per style, normal and italic, at most two files
  per family, with `font-display: swap`.
- **Preload only what the first screen needs**: the body face and the heading
  face, latin subset.
