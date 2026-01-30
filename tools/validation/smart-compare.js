#!/usr/bin/env node

const sharp = require('sharp');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const fs = require('fs');

async function smartCompare(originalPath, figmaPath, diffPath) {
  console.log('📊 Smart Image Comparison\n');

  // Load images
  const original = await sharp(originalPath).raw().toBuffer({ resolveWithObject: true });
  const figma = await sharp(figmaPath).raw().toBuffer({ resolveWithObject: true });

  console.log(`Original: ${original.info.width}x${original.info.height}`);
  console.log(`Figma:    ${figma.info.width}x${figma.info.height}\n`);

  // Resize figma to match original dimensions for comparison
  const resizedFigma = await sharp(figmaPath)
    .resize(original.info.width, original.info.height, {
      fit: 'contain',
      background: { r: 245, g: 245, b: 245, alpha: 1 }
    })
    .raw()
    .toBuffer();

  // Convert to PNG format for pixelmatch
  const img1 = PNG.sync.read(fs.readFileSync(originalPath));
  const img2 = PNG.sync.read(
    await sharp(resizedFigma, {
      raw: {
        width: original.info.width,
        height: original.info.height,
        channels: 3
      }
    })
    .png()
    .toBuffer()
  );

  const diff = new PNG({ width: img1.width, height: img1.height });

  const diffPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );

  // Save diff
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const diffPercent = (diffPixels / totalPixels) * 100;
  const fidelity = 100 - diffPercent;

  console.log(`Total pixels: ${totalPixels.toLocaleString()}`);
  console.log(`Different pixels: ${diffPixels.toLocaleString()}`);
  console.log(`Difference: ${diffPercent.toFixed(2)}%\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 FIDELITY SCORE: ${fidelity.toFixed(2)}%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (diffPath) {
    console.log(`Diff image saved: ${diffPath}\n`);
  }

  return { fidelity, diffPixels, diffPercent, totalPixels };
}

const [originalPath, figmaPath, diffPath] = process.argv.slice(2);

if (!originalPath || !figmaPath) {
  console.error('Usage: node smart-compare.js <original.png> <figma.png> [diff.png]');
  process.exit(1);
}

smartCompare(originalPath, figmaPath, diffPath || 'diff.png')
  .catch(err => {
    console.error('Comparison failed:', err.message);
    process.exit(1);
  });
