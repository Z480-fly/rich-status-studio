export const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // 20 MB straight off the camera roll
const MAX_EDGE = 1024; // Discord never renders these bigger than ~512px
const TARGET_QUALITY = 0.85;

export const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

export function isAcceptedImage(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Reads a file from the iPhone photo picker and shrinks it to something that
 * uploads quickly, returning a base64 data URL.
 */
export async function fileToResizedDataUrl(file: File): Promise<string> {
  if (!isAcceptedImage(file)) {
    throw new Error("That file isn't an image. Pick a photo instead.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("That photo is larger than 20 MB. Try a smaller one.");
  }

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser couldn't process that photo.");
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", TARGET_QUALITY);
  if (!dataUrl.startsWith("data:image/jpeg")) {
    throw new Error("That photo format isn't supported. Try a JPEG or PNG.");
  }
  return dataUrl;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* HEIC and some Safari builds fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That photo couldn't be opened."));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
