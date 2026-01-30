/**
 * Stylesheet Preprocessor Client
 *
 * Handles server-side stylesheet preprocessing with caching,
 * retries, and strict validation.
 */

const HANDOFF_SERVER = "http://localhost:4411";
const PREPROCESS_TIMEOUT = 45000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PreprocessResult {
  ok: boolean;
  error?: string;
  html: string;
  stats: {
    externalStylesheets: number;
    inlinedStylesheets: number;
    importRulesResolved: number;
    fontFacesInlined: number;
    errors: string[];
  };
  url: string;
}

interface CacheEntry {
  html: string;
  stats: PreprocessResult["stats"];
  timestamp: number;
}

class StylesheetPreprocessor {
  private cache: Map<string, CacheEntry> = new Map();
  private inFlightRequests: Map<string, Promise<PreprocessResult>> = new Map();
  private enabled: boolean = true;

  constructor() {
    this.loadConfig();
    this.startCacheCleanup();
  }

  /**
   * Load configuration from chrome.storage
   */
  private async loadConfig(): Promise<void> {
    try {
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Storage load timed out")), 2000),
      );

      // Race storage get against timeout
      const result = (await Promise.race([
        chrome.storage.local.get([
          "preprocessStylesheets",
          "preprocessServerUrl",
        ]),
        timeoutPromise,
      ])) as { preprocessStylesheets?: boolean };

      this.enabled = result.preprocessStylesheets !== false;
    } catch (error) {
      console.warn(
        "[PREPROCESS] Failed to load config (using default=true):",
        error,
      );
      this.enabled = true; // Default to enabled on failure
    }
  }

  /**
   * Check if preprocessing is enabled
   */
  async isEnabled(): Promise<boolean> {
    await this.loadConfig();
    return this.enabled;
  }

  /**
   * Set preprocessing enabled/disabled
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await chrome.storage.local.set({ preprocessStylesheets: enabled });
  }

  /**
   * Get cached entry if valid
   */
  private getCached(url: string): CacheEntry | null {
    const entry = this.cache.get(url);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > CACHE_TTL_MS) {
      this.cache.delete(url);
      return null;
    }

    return entry;
  }

  /**
   * Start periodic cache cleanup
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [url, entry] of this.cache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
          this.cache.delete(url);
        }
      }
    }, 60000); // Clean every minute
  }

  /**
   * Preprocess a webpage's stylesheets
   */
  async preprocess(url: string): Promise<PreprocessResult> {
    // Check cache first
    const cached = this.getCached(url);
    if (cached) {
      console.log("[PREPROCESS] Using cached result for:", url);
      return {
        ok: true,
        html: cached.html,
        stats: cached.stats,
        url,
      };
    }

    // Check if already in flight
    const inFlight = this.inFlightRequests.get(url);
    if (inFlight) {
      console.log("[PREPROCESS] Waiting for in-flight request:", url);
      return inFlight;
    }

    // Create new request
    const requestPromise = this.preprocessWithRetry(url);
    this.inFlightRequests.set(url, requestPromise);

    try {
      const result = await requestPromise;

      // Cache the result
      this.cache.set(url, {
        html: result.html,
        stats: result.stats,
        timestamp: Date.now(),
      });

      return result;
    } finally {
      this.inFlightRequests.delete(url);
    }
  }

  /**
   * Preprocess with retry logic
   */
  private async preprocessWithRetry(url: string): Promise<PreprocessResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.preprocessOnce(url);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[PREPROCESS] Attempt ${attempt}/${MAX_RETRIES} failed:`,
          lastError.message,
        );

        if (attempt < MAX_RETRIES) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Preprocessing failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Single preprocessing attempt
   */
  private async preprocessOnce(url: string): Promise<PreprocessResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREPROCESS_TIMEOUT);

    try {
      const response = await fetch(`${HANDOFF_SERVER}/api/preprocess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          error: `HTTP ${response.status}`,
        }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result: PreprocessResult = await response.json();

      if (!result.ok) {
        throw new Error(result.error || "Preprocessing failed");
      }

      // VALIDATION FIX: Ensure HTML is actually a string
      if (typeof result.html !== "string") {
        throw new Error(
          "Invalid response: 'html' field is missing or not a string",
        );
      }

      console.log("[PREPROCESS] Success:", {
        url,
        stylesheets: result.stats.inlinedStylesheets,
        imports: result.stats.importRulesResolved,
        fonts: result.stats.fontFacesInlined,
        errors: result.stats.errors.length,
      });

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    console.log("[PREPROCESS] Cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    urls: string[];
    totalSizeKB: number;
  } {
    let totalSize = 0;
    const urls: string[] = [];

    for (const [url, entry] of this.cache.entries()) {
      urls.push(url);
      totalSize += entry.html.length;
    }

    return {
      size: this.cache.size,
      urls,
      totalSizeKB: Math.round(totalSize / 1024),
    };
  }

  /**
   * Check if server is available
   */
  async checkServerHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${HANDOFF_SERVER}/api/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
export const stylesheetPreprocessor = new StylesheetPreprocessor();
