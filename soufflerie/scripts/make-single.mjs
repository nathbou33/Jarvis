// Construit une version autonome en un seul fichier HTML (dist-single/soufflerie.html),
// pratique pour un partage direct : tout le code est intégré, aucune dépendance locale.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+\.css)"[^>]*>/g, (_, f) => `<style>\n${readFileSync(resolve(dist, 'assets', f), 'utf8')}\n</style>`);
html = html.replace(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)"><\/script>/g, (_, f) => {
  const js = readFileSync(resolve(dist, 'assets', f), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">\n${js}\n</script>`;
});
// préchargements de modules restants (découpage éventuel)
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
// fichiers annexes non disponibles en mode fichier unique
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
html = html.replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '');
const svg = readFileSync(resolve(root, 'public/icons/icon.svg'), 'utf8');
html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" type="image/svg+xml">`);

const full = html;
// Variante « fragment » (sans doctype/html/head/body) pour l'hébergement en page Artifact
const head = full.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = full.match(/<body>([\s\S]*?)<\/body>/)[1];
const keepHead = head
  .replace(/<meta charset[^>]*>\n?/, '')
  .replace(/<meta name="viewport"[^>]*>\n?/, '');
const fragment = `${keepHead}\n${body}`;

mkdirSync(resolve(root, 'dist-single'), { recursive: true });
writeFileSync(resolve(root, 'dist-single/soufflerie.html'), full);
writeFileSync(resolve(root, 'dist-single/soufflerie-fragment.html'), fragment);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
console.log(`dist-single/soufflerie.html ${kb(full)} Ko · fragment ${kb(fragment)} Ko`);
if (readdirSync(resolve(dist, 'assets')).filter((f) => f.endsWith('.js')).length > 1) console.warn('Attention : plusieurs fichiers JS générés.');
