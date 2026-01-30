type WebpResolve = (value: Uint8Array) => void;
type WebpReject = (reason?: any) => void;

const webpResolvers = new Map<
  string,
  {
    resolve: WebpResolve;
    reject: WebpReject;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

type ImageTranscodeResolve = (value: Uint8Array) => void;
type ImageTranscodeReject = (reason?: any) => void;

const imageTranscodeResolvers = new Map<
  string,
  {
    resolve: ImageTranscodeResolve;
    reject: ImageTranscodeReject;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Request a WebP → PNG transcode from the plugin UI (which can use a canvas).
 * Falls back to rejecting if the UI is not available.
 */
export function requestWebpTranscode(base64: string): Promise<Uint8Array> {
  if (!figma.ui) {
    return Promise.reject(
      new Error("Figma UI not available for WebP transcode"),
    );
  }

  const id = `webp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => {
      webpResolvers.delete(id);
      reject(new Error("WebP transcode timed out"));
    }, 15000);

    webpResolvers.set(id, { resolve, reject, timeout });

    figma.ui.postMessage({
      type: "transcode-webp",
      id,
      base64,
    });
  });
}

/**
 * Request an arbitrary raster image → PNG transcode from the plugin UI (supports AVIF/WebP/etc).
 * `base64` may be a raw base64 payload or a full data URL.
 */
export function requestImageTranscode(
  base64: string,
  mimeType: string,
  targetWidth?: number,
  targetHeight?: number,
): Promise<Uint8Array> {
  if (!figma.ui) {
    return Promise.reject(
      new Error("Figma UI not available for image transcode"),
    );
  }

  const id = `imgtx-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => {
      imageTranscodeResolvers.delete(id);
      reject(new Error("Image transcode timed out"));
    }, 20000);

    imageTranscodeResolvers.set(id, { resolve, reject, timeout });

    figma.ui.postMessage({
      type: "transcode-image",
      id,
      base64,
      mimeType,
      targetWidth,
      targetHeight,
    });
  });
}

/**
 * Handle the response from the UI with the PNG data.
 */
export function handleWebpTranscodeResult(msg: any): void {
  const { id, pngBase64, error } = msg;
  const entry = webpResolvers.get(id);
  if (!entry) return;

  clearTimeout(entry.timeout);
  webpResolvers.delete(id);

  if (error) {
    entry.reject(new Error(error));
    return;
  }

  try {
    const normalized = pngBase64.includes(",")
      ? pngBase64.split(",")[1]
      : pngBase64;
    let bytes: Uint8Array;
    if (
      typeof figma !== "undefined" &&
      typeof figma.base64Decode === "function"
    ) {
      bytes = figma.base64Decode(normalized);
    } else if (typeof atob === "function") {
      const bin = atob(normalized);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    } else {
      throw new Error("No base64 decoder available");
    }
    entry.resolve(bytes);
  } catch (decodeError) {
    entry.reject(decodeError);
  }
}

/**
 * Handle the response from the UI for arbitrary image transcodes.
 */
export function handleImageTranscodeResult(msg: any): void {
  const { id, pngBase64, error } = msg;
  const entry = imageTranscodeResolvers.get(id);
  if (!entry) return;

  clearTimeout(entry.timeout);
  imageTranscodeResolvers.delete(id);

  if (error) {
    entry.reject(new Error(error));
    return;
  }

  try {
    const normalized = pngBase64.includes(",")
      ? pngBase64.split(",")[1]
      : pngBase64;
    let bytes: Uint8Array;
    if (
      typeof figma !== "undefined" &&
      typeof (figma as any).base64Decode === "function"
    ) {
      bytes = (figma as any).base64Decode(normalized);
    } else if (typeof atob === "function") {
      const bin = atob(normalized);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    } else {
      throw new Error("No base64 decoder available");
    }
    entry.resolve(bytes);
  } catch (decodeError) {
    entry.reject(decodeError);
  }
}
