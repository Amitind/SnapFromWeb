import { getCachedScreenshotPath, getScreenshotPath, saveScreenshot } from '@/lib/storage';

import type { Browser, LaunchOptions } from 'patchright';
import { getBrowser, getUserAgent, takeScreenshot } from '@/lib/browser';
import 'dotenv/config'

const {HEADLESS_BROWSER, MAX_CONCURRENCY, PAGE_LOAD_TIMEOUT, RETRY_LIMIT} = process.env;
export interface ScreenshotResult {
  url: string;
  success: boolean;
  path?: string;
  error?: string;
  cached?: boolean;
}

// One shared browser, a new isolated context per task (same model as
// puppeteer-cluster's CONCURRENCY_CONTEXT).
const defaultClusterOptions = {
  maxConcurrency: Number(MAX_CONCURRENCY) || 10,
  timeout: Number(PAGE_LOAD_TIMEOUT) || 30000,
  retryLimit: Number(RETRY_LIMIT) || 2,
};

const defaultPuppeteerOptions: LaunchOptions = {
  headless: HEADLESS_BROWSER === 'true' || HEADLESS_BROWSER === '1',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    // '--disable-gpu'
  ]
};

export type ClusterOptions = Partial<typeof defaultClusterOptions>;
export type PuppeteerOptions = Partial<LaunchOptions>;

// Shared browser, relaunched on the next task if it disconnects or crashes
let browserPromise: Promise<Browser> | null = null;

function getSharedBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = getBrowser(defaultPuppeteerOptions).then((browser) => {
      browser.on('disconnected', () => {
        if (browserPromise === launching) browserPromise = null;
      });
      return browser;
    });
    launching.catch(() => {
      if (browserPromise === launching) browserPromise = null;
    });
    browserPromise = launching;
  }
  return browserPromise;
}

// Patchright's own SIGTERM handler closes the browser but keeps Node alive,
// so close the browser and exit here
process.once('SIGTERM', () => {
  closeCluster().finally(() => process.exit(0));
});

// Promise-based concurrency limiter capped at maxConcurrency
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= defaultClusterOptions.maxConcurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot to the next task
    else active--;
  }
}

class HttpError extends Error {}

/**
 * Load the page in a fresh context and save the screenshot to outputPath.
 */
async function capture(url: string, outputPath: string): Promise<void> {
  const browser = await getSharedBrowser();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: defaultPuppeteerOptions.headless ? getUserAgent(browser) : undefined,
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: defaultClusterOptions.timeout,
    });

    // Check for HTTP errors - don't screenshot error pages
    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new HttpError(`HTTP ${status}: Server returned error status`);
    }

    // Playwright has no networkidle2; wait for load and network idle, but don't
    // fail on sites that never settle (analytics, polling, slow ads)
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Extra wait for any lazy-loaded content or animations to settle
    await page.waitForTimeout(500);

    const screenshot = await takeScreenshot(page);
    await saveScreenshot(screenshot, outputPath);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Screenshot task function - processes a single URL
 */
async function screenshotTask(url: string): Promise<ScreenshotResult> {
  try {
    // Check if screenshot already exists for this hour
    const cachedPath = await getCachedScreenshotPath(url);

    if (cachedPath) {
      return {
        url,
        success: true,
        path: cachedPath,
        cached: true
      };
    }

    // Get the new path (includes current date-hour)
    const outputPath = await getScreenshotPath(url);

    for (let attempt = 0; ; attempt++) {
      try {
        await withSlot(() => capture(url, outputPath));
        break;
      } catch (error) {
        // HTTP error pages won't change on retry
        if (error instanceof HttpError || attempt >= defaultClusterOptions.retryLimit) throw error;
        console.error(`Retrying ${url} (${attempt + 1}/${defaultClusterOptions.retryLimit}):`, error instanceof Error ? error.message : error);
      }
    }

    return {
      url,
      success: true,
      path: outputPath
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to screenshot ${url}:`, message);
    return {
      url,
      success: false,
      error: message
    };
  }
}

/**
 * Take screenshots of one or more URLs.
 * Uses the shared browser - it stays open between requests.
 */
export async function takeScreenshots(urls: string[]): Promise<ScreenshotResult[]> {
  return Promise.all(urls.map(url => screenshotTask(url)));
}

/**
 * Take a screenshot of a single URL.
 */
export async function takeScreenshotOfUrl(url: string): Promise<ScreenshotResult> {
  return screenshotTask(url);
}

/**
 * Close the shared browser.
 * Call this during graceful shutdown.
 */
export async function closeCluster(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close();
  }
}
