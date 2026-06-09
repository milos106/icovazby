#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Build static HTML pages z docs/*.md → public/*.html.
 *
 * Slouží pro Terms / Disclaimer (a budoucí licenci, FAQ, ...). Nezávislé
 * na Alpine — čisté HTML s minimální Tailwind class signaturou.
 *
 * Spouští se z deploy/redeploy.sh nebo ručně:
 *   node scripts/build_static_pages.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS_DIR = join(ROOT, "docs");
const PUBLIC_DIR = join(ROOT, "public");

// Které docs vyrobit jako public stránky a pod jakou cestou.
const PAGES = [
  { src: "TERMS.md", dst: "terms.html", title: "Podmínky služby — icovazby" },
  { src: "DISCLAIMER.md", dst: "disclaimer.html", title: "Omezení odpovědnosti — icovazby" },
  { src: "PRIVACY.md", dst: "privacy.html", title: "Zásady ochrany osobních údajů — icovazby" },
];

marked.setOptions({
  gfm: true,
  breaks: false,
});

function wrap(title, bodyHtml) {
  return `<!doctype html>
<html lang="cs" class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    // Dark mode — sync s hlavním webem (klíč "icovazby:theme") + system preference.
    (function() {
      var stored = null;
      try { stored = localStorage.getItem("icovazby:theme"); } catch (e) {}
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var dark = stored === "dark" || (stored === null && prefersDark);
      if (dark) document.documentElement.classList.add("dark");
    })();
    function toggleTheme() {
      var html = document.documentElement;
      var willBeDark = !html.classList.contains("dark");
      html.classList.toggle("dark", willBeDark);
      try { localStorage.setItem("icovazby:theme", willBeDark ? "dark" : "light"); } catch (e) {}
      var btn = document.getElementById("theme-toggle-btn");
      if (btn) btn.textContent = willBeDark ? "☀️ Světlý" : "🌙 Tmavý";
    }
  </script>
  <style>
    .prose h1 { font-size: 2rem; font-weight: 700; margin-top: 0; margin-bottom: 1rem; }
    .prose h2 { font-size: 1.5rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.75rem; }
    .prose h3 { font-size: 1.125rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .prose p { margin: 0.75rem 0; line-height: 1.6; }
    .prose ul, .prose ol { padding-left: 1.5rem; margin: 0.75rem 0; }
    .prose li { margin: 0.25rem 0; }
    .prose a { color: #059669; text-decoration: underline; }
    .prose code { background: rgba(0,0,0,0.05); padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.9em; }
    .dark .prose code { background: rgba(255,255,255,0.1); }
    .prose table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: 0.9rem; }
    .prose th, .prose td { border: 1px solid rgba(0,0,0,0.15); padding: 0.4rem 0.6rem; text-align: left; }
    .dark .prose th, .dark .prose td { border-color: rgba(255,255,255,0.15); }
    .prose th { background: rgba(0,0,0,0.04); font-weight: 600; }
    .dark .prose th { background: rgba(255,255,255,0.05); }
    .prose hr { border: 0; border-top: 1px solid rgba(0,0,0,0.15); margin: 2rem 0; }
    .dark .prose hr { border-top-color: rgba(255,255,255,0.15); }
    .prose blockquote { border-left: 4px solid #d1d5db; padding-left: 1rem; color: #6b7280; font-style: italic; }
  </style>
</head>
<body class="bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100 min-h-screen">
  <header class="border-b dark:border-slate-700 bg-white dark:bg-slate-800">
    <div class="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
      <a href="/" class="flex items-center gap-2 hover:opacity-80">
        <svg viewBox="0 0 64 64" class="w-7 h-7" xmlns="http://www.w3.org/2000/svg">
          <path d="M 32 18 L 14 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M 32 18 L 32 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M 32 18 L 50 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <rect x="6" y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <rect x="24" y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <rect x="42" y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <circle cx="32" cy="18" r="11" fill="#065f46"/>
          <circle cx="32" cy="18" r="7" fill="#34d399"/>
        </svg>
        <span class="font-semibold tracking-tight">IČO vazby</span>
      </a>
      <span class="text-slate-300 dark:text-slate-600">/</span>
      <span class="text-sm text-slate-600 dark:text-slate-400">${title.replace(" — icovazby", "")}</span>
      <span class="flex-1"></span>
      <button type="button" id="theme-toggle-btn" onclick="toggleTheme()" class="text-sm px-2 py-1 border dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              x-tmpl="theme-label">🌙 Tmavý</button>
      <a href="/" class="text-sm underline text-emerald-700 dark:text-emerald-400">← zpět na hlavní</a>
    </div>
  </header>
  <script>
    // Inicializace textu tlačítka podle aktuálního stavu (provedeno po DOM ready, headerScript běží před body)
    (function() {
      var btn = document.getElementById("theme-toggle-btn");
      if (btn) btn.textContent = document.documentElement.classList.contains("dark") ? "☀️ Světlý" : "🌙 Tmavý";
    })();
  </script>
  <main class="max-w-3xl mx-auto px-4 py-8">
    <article class="prose dark:prose-invert">
      ${bodyHtml}
    </article>
    <footer class="mt-12 pt-6 border-t dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
      <p>icovazby — open-source pod <a href="https://www.gnu.org/licenses/agpl-3.0.html" class="underline">AGPL-3.0-or-later</a>. <a href="/" class="underline">Hlavní web</a> · <a href="/terms.html" class="underline">Podmínky</a> · <a href="/disclaimer.html" class="underline">Omezení odpovědnosti</a> · <a href="/privacy.html" class="underline">Soukromí</a></p>
    </footer>
  </main>
</body>
</html>
`;
}

function build() {
  let built = 0;
  for (const { src, dst, title } of PAGES) {
    const srcPath = join(DOCS_DIR, src);
    const dstPath = join(PUBLIC_DIR, dst);
    const md = readFileSync(srcPath, "utf8");
    const html = marked.parse(md);
    writeFileSync(dstPath, wrap(title, html), "utf8");
    console.log(`  built ${dst} (from ${src}, ${md.length} bytes md → ${wrap(title, html).length} bytes html)`);
    built++;
  }
  console.log(`Done. Built ${built} pages.`);
}

build();
