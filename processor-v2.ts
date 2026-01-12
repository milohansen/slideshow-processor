/**
 * Image Processor V2 - Core Processing Logic
 * Handles downloading, fingerprinting, resizing, and color extraction
 */

import { Storage } from "@google-cloud/storage";
import { QuantizerCelebi, Score, argbFromRgb } from "@material/material-color-utilities";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import sharp from "sharp";

const storage = new Storage();

interface Source {
  id: string;
  staging_path: string;
  origin: string;
  external_id?: string;
}

interface DeviceDimensions {
  width: number;
  height: number;
  orientation: string;
}

interface ProcessingOptions {
  source: Source;
  deviceDimensions: DeviceDimensions[];
  bucketName: string;
  backendApiUrl: string;
  checkBlobExists: (hash: string) => Promise<boolean>;
}

interface ProcessingResult {
  status: "processed" | "duplicate";
  blobHash?: string;
  blobData?: any;
  colorData?: any;
  variants: any[];
}

/**
 * Download file from GCS or local path
 */
async function downloadSource(stagingPath: string, bucketName: string): Promise<Buffer> {
  if (stagingPath.startsWith("gs://")) {
    // Parse GCS URI
    const match = stagingPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid GCS URI: ${stagingPath}`);
    }
    
    const [, bucket, path] = match;
    const file = storage.bucket(bucket).file(path);
    const [contents] = await file.download();
    return Buffer.from(contents);
  } else {
    // Local file
    const data = await Deno.readFile(stagingPath);
    return Buffer.from(data);
  }
}

/**
 * Calculate SHA-256 hash of buffer
 */
async function calculateHash(buffer: Buffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return encodeHex(new Uint8Array(hashBuffer));
}

/**
 * Upload buffer to GCS
 */
async function uploadToGCS(buffer: Buffer, path: string, bucketName: string): Promise<string> {
  const file = storage.bucket(bucketName).file(path);
  await file.save(buffer, {
    metadata: {
      contentType: "image/jpeg",
    },
  });
  return `gs://${bucketName}/${path}`;
}

/**
 * Extract colors from image buffer
 */
async function extractColors(imageBuffer: Buffer, maxResolution = 256): Promise<string[]> {
  // Resize to smaller proxy for performance
  const { data, info } = await sharp(imageBuffer)
    .resize(maxResolution, maxResolution, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelData = new Uint8Array(data);
  const pixels: number[] = [];

  // Convert RGBA to ARGB
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const a = pixelData[i + 3];

    if (a < 255) continue;

    const argb = argbFromRgb(r, g, b);
    pixels.push(argb);
  }

  if (pixels.length === 0) {
    return ["#4285F4"]; // Fallback
  }

  // Quantize and score
  const quantized = QuantizerCelebi.quantize(pixels, 128);
  const rankedColors = Score.score(quantized, {
    desired: 8,
    filter: true,
    fallbackColorARGB: 0xff4285f4,
  });

  // Convert to hex
  return rankedColors.map(argb => 
    "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase()
  );
}

/**
 * Determine orientation from dimensions
 */
function determineOrientation(width: number, height: number): "portrait" | "landscape" | "square" {
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.05) return "square";
  return width > height ? "landscape" : "portrait";
}

/**
 * Process a single source
 */
export async function processSourceV2(options: ProcessingOptions): Promise<ProcessingResult> {
  const { source, deviceDimensions, bucketName, checkBlobExists } = options;

  // Step 1: Download original
  console.log(`  📥 Downloading from ${source.staging_path}`);
  const originalBuffer = await downloadSource(source.staging_path, bucketName);

  // Step 2: Calculate hash (fingerprint)
  const blobHash = await calculateHash(originalBuffer);
  console.log(`  🔑 Hash: ${blobHash}`);

  // Step 3: Check for duplicate
  const exists = await checkBlobExists(blobHash);
  if (exists) {
    console.log(`  ♻️  Duplicate detected, skipping processing`);
    return {
      status: "duplicate",
      blobHash,
      variants: [],
    };
  }

  // Step 4: Extract metadata
  const metadata = await sharp(originalBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to extract image dimensions");
  }

  const width = metadata.width;
  const height = metadata.height;
  const aspectRatio = parseFloat((width / height).toFixed(5));
  const orientation = determineOrientation(width, height);

  console.log(`  📐 Dimensions: ${width}x${height} (${orientation})`);

  // Step 5: Upload original to permanent storage
  const ext = metadata.format || "jpg";
  const originalPath = `images/originals/${blobHash}.${ext}`;
  const originalGcsUri = await uploadToGCS(originalBuffer, originalPath, bucketName);
  console.log(`  ☁️  Uploaded original: ${originalPath}`);

  // Step 6: Extract colors
  console.log(`  🎨 Extracting colors...`);
  const colors = await extractColors(originalBuffer);
  const colorPalette = JSON.stringify(colors);
  const colorSource = colors[0];

  // Step 7: Generate device variants
  console.log(`  🖼️  Generating ${deviceDimensions.length} variants...`);
  const variants = [];

  for (const device of deviceDimensions) {
    try {
      // Resize for device
      const resizedBuffer = await sharp(originalBuffer)
        .resize(device.width, device.height, {
          fit: "cover",
          position: "entropy", // Smart crop
        })
        .jpeg({ quality: 90 })
        .toBuffer();

      // Upload variant
      const variantPath = `processed/${device.width}x${device.height}/${blobHash}.jpg`;
      const variantGcsUri = await uploadToGCS(resizedBuffer, variantPath, bucketName);

      variants.push({
        width: device.width,
        height: device.height,
        orientation: device.orientation,
        storage_path: variantGcsUri,
        file_size: resizedBuffer.length,
      });

      console.log(`    ✓ ${device.width}x${device.height}`);
    } catch (error) {
      console.error(`    ✗ ${device.width}x${device.height}: ${error.message}`);
    }
  }

  // Step 8: Return results
  return {
    status: "processed",
    blobHash,
    blobData: {
      storage_path: originalGcsUri,
      width,
      height,
      aspect_ratio: aspectRatio,
      orientation,
      file_size: originalBuffer.length,
      mime_type: `image/${metadata.format || "jpeg"}`,
      exif_data: metadata.exif ? JSON.stringify(metadata.exif) : null,
    },
    colorData: {
      palette: colorPalette,
      source: colorSource,
    },
    variants,
  };
}
