#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

async function captureOriginal(testPagePath, outputPath) {
  console.log('📸 Capturing original screenshot...');

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewport({ width: 1440, height: 900 });

  const url = testPagePath.startsWith('http')
    ? testPagePath
    : `file://${path.resolve(testPagePath)}`;

  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise(resolve => setTimeout(resolve, 1000));

  const screenshot = await page.screenshot({ fullPage: true });
  await fs.writeFile(outputPath, screenshot);

  await browser.close();

  console.log(`✅ Original saved: ${outputPath}`);
}

const testPage = process.argv[2] || 'test/fidelity-pages/simple-layout.html';
const outputPath = process.argv[3] || 'test/fidelity-results/simple-layout/original.png';

captureOriginal(testPage, outputPath).catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
