// Fabrique les icônes du site à partir du logo J6N : le sigle en blanc dans un repère de carte, sur fond marine.
//   node tools/make-icons.mjs            → écrit public/icon.svg et les SVG intermédiaires dans tools/out/
// Les PNG de public/icons/ (192, 512, 512 « maskable », 180 pour iOS) sont des captures de ces SVG, par exemple :
//   google-chrome --headless --default-background-color=00000000 --screenshot=icon-512.png --window-size=512,512 page.html
import fs from 'node:fs';

const here = new URL('.', import.meta.url);
const src = fs.readFileSync(new URL('j6n-logo.svg', here), 'utf8');
const shapes = [...src.matchAll(/<(path|circle)[^>]*\/>/g)].map((m) => m[0].replace(/\s*class="st0"/, ''));
const NAVY = '#0f1b2d';
const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0b8276"/><stop offset="1" stop-color="#2bbf8a"/></linearGradient></defs>';

// Emprise du sigle dans son repère 160 × 160 : x de 22,9 à 137,4, y de 47 à 104,7
function mark(cx, cy, width, fill) {
  const k = width / 114.5;
  return `<g fill="${fill}" transform="translate(${cx - 80.15 * k} ${cy - 75.85 * k}) scale(${k})">${shapes.join('')}</g>`;
}

function pin(cx, cy, r) {
  return `<path fill="url(#g)" d="M${cx} ${cy + r * 1.55} C${cx - r * 0.35} ${cy + r * 1.1} ${cx - r} ${cy + r * 0.62} ${cx - r} ${cy} A${r} ${r} 0 1 1 ${cx + r} ${cy} C${cx + r} ${cy + r * 0.62} ${cx + r * 0.35} ${cy + r * 1.1} ${cx} ${cy + r * 1.55} Z"/>`;
}

/** radius : arrondi du fond ; r : rayon du repère. */
function icon({ radius, r }) {
  const cy = 256 - r * 0.27;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${GRADIENT}<rect width="512" height="512" rx="${radius}" fill="${NAVY}"/>${pin(256, cy, r)}${mark(256, cy, r * 1.5, '#fff')}</svg>`;
}

const out = new URL('out/', here);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(new URL('../public/icon.svg', here), icon({ radius: 112, r: 160 }));
fs.writeFileSync(new URL('icon-full.svg', out), icon({ radius: 0, r: 160 })); // iOS arrondit lui-même
fs.writeFileSync(new URL('icon-maskable.svg', out), icon({ radius: 0, r: 128 })); // tout doit tenir dans les 80 % centraux
console.log('Icônes SVG écrites : public/icon.svg, tools/out/');
