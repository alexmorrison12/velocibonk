// Bundles src/ into a single self-contained HTML file.
//   dist/artifact.html  content-only page for a Claude Artifact (the host adds doctype/head/body)
//   dist/index.html     full standalone document (double-click to play)
//   docs/index.html     the same standalone document, served by GitHub Pages (--min builds only)
// Usage: node build.mjs [--min]
import * as esbuild from 'esbuild';
import fs from 'fs';

const SITE = 'https://alexmorrison12.github.io/velocibonk/';
const t0 = Date.now();
const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: process.argv.includes('--min'),
  format: 'iife',
  write: false,
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'warning',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.existsSync('src/ui.css') ? fs.readFileSync('src/ui.css', 'utf8') : '';
const page = fs.readFileSync('src/index.html', 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/artifact.html', page);

// Standalone document: <title> and <style> belong in <head>, markup + script in <body>.
const split = page.indexOf('</style>') + '</style>'.length;
const headPart = page.slice(0, split), bodyPart = page.slice(split);
const desc = 'A 3D survivors roguelite where speed is damage. Bhop, slide and slam across a procedural island while your auto-weapons shred the horde. New island every day.';
const meta = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<meta name="description" content="${desc}">`,
  '<meta name="theme-color" content="#140f2e">',
  '<meta property="og:type" content="website">',
  '<meta property="og:title" content="VELOCIBONK — speed is damage">',
  `<meta property="og:description" content="${desc}">`,
  `<meta property="og:url" content="${SITE}">`,
  fs.existsSync('docs/og.jpg') ? `<meta property="og:image" content="${SITE}og.jpg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">` : '',
  '<meta name="twitter:card" content="summary_large_image">',
].filter(Boolean).join('\n');
const doc = `<!doctype html>\n<html lang="en">\n<head>\n${meta}\n${headPart}\n</head>\n<body>\n${bodyPart}\n</body>\n</html>\n`;
fs.writeFileSync('dist/index.html', doc);
if (process.argv.includes('--min')) { // only production builds update the Pages site
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/index.html', doc);
  fs.writeFileSync('docs/.nojekyll', '');
}
console.log(`built in ${Date.now() - t0}ms, ${(page.length / 1024).toFixed(0)} KB`);
