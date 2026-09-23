import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

// One vector source for the web mark, PWA and Apple home-screen icons.
const source = await readFile(new URL('../public/opspulse/mark.svg', import.meta.url));
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await sharp(source).resize(size, size).png().toFile(new URL(`../public/opspulse/${name}`, import.meta.url).pathname);
}
// Keep every part of the mark within the central 80% maskable safe area.
const inner = source.toString().replace(/<svg[^>]*>/, '').replace('</svg>', '');
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111a2f"/><g transform="translate(8 8) scale(.75)">${inner}</g></svg>`;
await sharp(Buffer.from(maskable)).png().toFile(new URL('../public/opspulse/icon-maskable-512.png', import.meta.url).pathname);
console.log('Generated OpsPulse icons from mark.svg');
