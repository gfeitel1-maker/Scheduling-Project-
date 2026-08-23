import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const BRAND_DIR = path.resolve('src/assets/brand');
const OUT_DIR = path.resolve('src/assets/brand/icons');

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function writePng(png, file) {
  fs.writeFileSync(file, PNG.sync.write(png));
}

// Crop an exact rectangle (rounding to nearest pixel), feather the crop's own
// edges with a radial alpha falloff so no hard seam shows against a neighbor
// cell's differently-blurred background.
function cropFeathered(src, x, y, w, h, featherPx = 6) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rw = Math.round(w);
  const rh = Math.round(h);
  const out = new PNG({ width: rw, height: rh });

  const cx = rw / 2;
  const cy = rh / 2;

  for (let row = 0; row < rh; row++) {
    for (let col = 0; col < rw; col++) {
      const srcIdx = ((ry + row) * src.width + (rx + col)) << 2;
      const dstIdx = (row * rw + col) << 2;

      out.data[dstIdx] = src.data[srcIdx];
      out.data[dstIdx + 1] = src.data[srcIdx + 1];
      out.data[dstIdx + 2] = src.data[srcIdx + 2];

      // distance to nearest edge in px
      const distLeft = col;
      const distRight = rw - 1 - col;
      const distTop = row;
      const distBottom = rh - 1 - row;
      const distEdge = Math.min(distLeft, distRight, distTop, distBottom);

      let alphaMul = 1;
      if (distEdge < featherPx) {
        alphaMul = distEdge / featherPx;
      }

      const srcAlpha = src.data[srcIdx + 3];
      out.data[dstIdx + 3] = Math.round(srcAlpha * alphaMul);
    }
  }

  return out;
}

// Crop a tight rectangle with no feathering (used for decorative icons whose
// own vignette already frames them).
function cropTight(src, x, y, w, h) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rw = Math.round(w);
  const rh = Math.round(h);
  const out = new PNG({ width: rw, height: rh });

  for (let row = 0; row < rh; row++) {
    for (let col = 0; col < rw; col++) {
      const srcIdx = ((ry + row) * src.width + (rx + col)) << 2;
      const dstIdx = (row * rw + col) << 2;
      out.data[dstIdx] = src.data[srcIdx];
      out.data[dstIdx + 1] = src.data[srcIdx + 1];
      out.data[dstIdx + 2] = src.data[srcIdx + 2];
      out.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }

  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- 1a. icons-ui.png — 5x4 grid, cell 307.2 x 256 ---
const UI_NAMES = [
  'home', 'calendar', 'people', 'clipboard', 'map-pin',
  'document', 'bell', 'magnifier', 'gear', 'chart',
  'sync', 'upload', 'download', 'link', 'clock',
  'warning', 'info', 'check', 'pencil', 'trash',
];

const uiSheet = readPng(path.join(BRAND_DIR, 'icons-ui.png'));
const CELL_W = 307.2;
const CELL_H = 256;

UI_NAMES.forEach((name, i) => {
  const row = Math.floor(i / 5);
  const col = i % 5;
  const x = col * CELL_W;
  const y = row * CELL_H;
  const tile = cropFeathered(uiSheet, x, y, CELL_W, CELL_H, 6);
  writePng(tile, path.join(OUT_DIR, `ui-${name}.png`));
  console.log(`ui-${name}.png  <- (${x.toFixed(1)}, ${y}, ${CELL_W}, ${CELL_H})`);
});

// --- 1b. icons-decorative.png — irregular per-icon regions ---
const DECORATIVE_REGIONS = [
  { name: 'magnifier', x: 0, y: 0, w: 384, h: 512 },
  { name: 'checklist', x: 384, y: 0, w: 384, h: 512 },
  { name: 'tree-book', x: 768, y: 0, w: 384, h: 512 },
  { name: 'hourglass', x: 1152, y: 0, w: 384, h: 512 },
  { name: 'shovel', x: 0, y: 512, w: 307.2, h: 512 },
  { name: 'sprout', x: 307.2, y: 512, w: 307.2, h: 512 },
  { name: 'quill-scroll', x: 614.4, y: 512, w: 307.2, h: 512 },
  { name: 'bundled-scrolls', x: 921.6, y: 512, w: 307.2, h: 512 },
  { name: 'tree-teardrop', x: 1228.8, y: 512, w: 307.2, h: 512 },
];

const decoSheet = readPng(path.join(BRAND_DIR, 'icons-decorative.png'));

DECORATIVE_REGIONS.forEach(({ name, x, y, w, h }) => {
  const tile = cropTight(decoSheet, x, y, w, h);
  writePng(tile, path.join(OUT_DIR, `decorative-${name}.png`));
  console.log(`decorative-${name}.png  <- (${x}, ${y}, ${w}, ${h})`);
});

console.log('done');
