## Output contract

Create exactly one file, at this exact path:

    OUTPUT_PATH

Every numbered rule is mandatory. Check the finished file against each one
before you report.

1. It is an HTML fragment, not a complete document. Do NOT include `<!doctype>`,
   `<html>`, `<head>`, or `<body>`.
2. Its only top-level element is:
   `<section class="kingdom" id="kingdom-SLUG" data-kingdom="SLUG">`
3. The section contains a `<style>` block. EVERY CSS selector is prefixed with
   `#kingdom-SLUG` so styles cannot leak into other chapters.
4. Use no JavaScript. Native `<details>`, anchors, SVG and CSS are allowed.
5. Use no external URLs, images, fonts, libraries, or encoded binary data.
6. Include EXACTLY TWO inline SVGs: one emblem and one labeled regional map.
   Each SVG needs a `<title>` and `role="img"`.
7. Include an `h2` with the canonical realm name. Do not use `h1`.
8. Include clearly labeled passages covering society, government, landscape,
   crisis, both canonical borders, eclipse theory, hidden secret, and adventure
   hooks.
9. Incorporate the locked theme, all three motifs, and the tonal rule without
   quoting the charter verbatim as an explanation.
10. Include three short adventure hooks and one quotation attributed to an
    in-world speaker.
11. Write between 1,100 and 1,400 words of prose. Aim for 1,250. Under 900 is a
    failure. Keep the complete file below 45 KB.
12. Do not use placeholder text, TODOs, markdown fences, or explanatory text
    outside the HTML. Your entire output is the file's contents.
13. Do not edit shared files, `dist/`, or another worker's directory.
