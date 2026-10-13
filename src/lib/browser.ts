import { chromium, type Browser, type LaunchOptions, type Page, type PageScreenshotOptions } from 'patchright';

// Stealth is built into Patchright. Keep launch options minimal (no custom headers),
// as the Patchright README recommends.
export async function getBrowser(options: LaunchOptions = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ],
    ...options
  });
  return browser;
}

// Headless Chromium reports "HeadlessChrome" in its user agent. Replace it with a normal
// Chrome user agent (what puppeteer-extra-plugin-anonymize-ua did).
export function getUserAgent(browser: Browser) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
}

export async function getPage(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
  return page;
}

export async function takeScreenshot(page: Page, options: PageScreenshotOptions = { type: 'png' }) {
  const screenshot = await page.screenshot(options);
  return screenshot;
}

export async function closeBrowser(browser: Browser) {
  await browser.close();
}
