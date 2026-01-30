/**
 * Utility for fetching assets via the handoff server proxy.
 * This is used by the Figma plugin to bypass sandbox restrictions and CORS.
 */

export interface ProxyFetchResult {
  bytes: Uint8Array;
  contentType?: string;
  error?: string;
}

/**
 * Fetch a URL via the handoff server proxy.
 * Automatically tries common local server addresses.
 */
export async function fetchWithProxy(
  url: string,
  timeoutMs = 8000,
): Promise<ProxyFetchResult> {
  const handoffBases = ["http://127.0.0.1:4411", "http://localhost:4411"];

  for (const base of handoffBases) {
    try {
      const proxyUrl = `${base}/api/proxy?url=${encodeURIComponent(url)}`;

      let signal: AbortSignal | undefined;
      let timeoutId: any;
      if (typeof AbortController !== "undefined") {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        signal = controller.signal;
      }

      const fetchOptions: any = {
        headers: {
          Accept: "application/json",
        },
      };
      if (signal) {
        fetchOptions.signal = signal;
      }

      const response = await fetch(proxyUrl, fetchOptions);
      if (timeoutId) clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as {
          ok?: boolean;
          data?: string;
          contentType?: string;
          error?: string;
        };

        if (data.ok && data.data) {
          // data.data is a data URL like "data:image/png;base64,..."
          const base64Match = data.data.match(/^data:([^;]+);base64,(.+)$/);
          if (base64Match) {
            const detectedMime = base64Match[1];
            const base64 = base64Match[2];

            // Manual base64 to Uint8Array conversion (robust for sandbox)
            const bin = atob(base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
              bytes[i] = bin.charCodeAt(i);
            }

            return {
              bytes,
              contentType: data.contentType || detectedMime,
            };
          }
        }
      }
    } catch (e) {
      // Try next base
      continue;
    }
  }

  throw new Error(`Failed to fetch via proxy: ${url}`);
}
