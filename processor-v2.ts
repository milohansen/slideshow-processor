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

type Source = {
  id: string;
  staging_path: string;
  origin: string;
  external_id?: string;
};

type DeviceDimensions = {
  width: number;
  height: number;
  orientation: string;
  layouts?: {
    type: "single" | "pair-vertical" | "pair-horizontal";
    width: number;
    height: number;
    divider?: number;
    preferredAspectRatios?: string[];
    minAspectRatio?: number;
    maxAspectRatio?: number;
  }[];
};

type ProcessingOptions = {
  source: Source;
  deviceDimensions: DeviceDimensions[];
  bucketName: string;
  backendApiUrl: string;
  checkBlobExists: (hash: string) => Promise<boolean>;
};

type ProcessingResult = {
  status: "processed" | "duplicate";
  blobHash?: string;
  blobData?: unknown;
  colorData?: unknown;
  variants: unknown[];
};

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
 * Calculate crop percentage when fitting an image to target dimensions
 */
function calculateCropPercentage(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): number {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  
  if (Math.abs(sourceRatio - targetRatio) < 0.001) {
    return 0; // Perfect match, no crop
  }
  
  if (sourceRatio > targetRatio) {
    // Source is wider - will crop width
    const usedWidth = targetHeight * sourceRatio;
    const croppedWidth = usedWidth - targetWidth;
    return (croppedWidth / usedWidth) * 100;
  } else {
    // Source is taller - will crop height
    const usedHeight = targetWidth / sourceRatio;
    const croppedHeight = usedHeight - targetHeight;
    return (croppedHeight / usedHeight) * 100;
  }
}

/**
 * Evaluate which layouts an image is eligible for
 */
function evaluateImageLayouts(
  imageWidth: number,
  imageHeight: number,
  layouts: DeviceDimensions["layouts"]
): Array<{ layoutType: string; width: number; height: number; cropPercentage: number }> {
  if (!layouts || layouts.length === 0) {
    return [];
  }

  const imageRatio = imageWidth / imageHeight;
  const imageOrientation = determineOrientation(imageWidth, imageHeight);
  const eligible = [];

  for (const layout of layouts) {
    // Check aspect ratio constraints
    if (layout.minAspectRatio !== undefined && imageRatio < layout.minAspectRatio) {
      continue;
    }
    if (layout.maxAspectRatio !== undefined && imageRatio > layout.maxAspectRatio) {
      continue;
    }

    // Calculate crop percentage
    const cropPercentage = calculateCropPercentage(
      imageWidth,
      imageHeight,
      layout.width,
      layout.height
    );

    eligible.push({
      layoutType: layout.type,
      width: layout.width,
      height: layout.height,
      cropPercentage,
    });
  }

  // Sort by crop percentage (least crop first)
  eligible.sort((a, b) => a.cropPercentage - b.cropPercentage);
  
  return eligible;
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
  console.log(`  🖼️  Generating variants for ${deviceDimensions.length} device(s)...`);
  const variants = [];

  for (const device of deviceDimensions) {
    // If device has layouts, generate variants for each eligible layout
    if (device.layouts && device.layouts.length > 0) {
      const eligibleLayouts = evaluateImageLayouts(width, height, device.layouts);
      
      console.log(`    Device ${device.width}x${device.height}: ${eligibleLayouts.length} eligible layout(s)`);
      
      for (const layout of eligibleLayouts) {
        try {
          // Resize for this layout
          const resizedBuffer = await sharp(originalBuffer)
            .resize(layout.width, layout.height, {
              fit: "cover",
              position: "entropy", // Smart crop
            })
            .jpeg({ quality: 90 })
            .toBuffer();

          // Upload variant
          const variantPath = `processed/${layout.layoutType}/${layout.width}x${layout.height}/${blobHash}.jpg`;
          const variantGcsUri = await uploadToGCS(resizedBuffer, variantPath, bucketName);

          variants.push({
            width: layout.width,
            height: layout.height,
            orientation: determineOrientation(layout.width, layout.height),
            layout_type: layout.layoutType,
            storage_path: variantGcsUri,
            file_size: resizedBuffer.length,
          });

          console.log(`      ✓ ${layout.layoutType}: ${layout.width}x${layout.height} (crop: ${layout.cropPercentage.toFixed(1)}%)`);
        } catch (error) {
          console.error(`      ✗ ${layout.layoutType} ${layout.width}x${layout.height}: ${error.message}`);
        }
      }
    } else {
      // Legacy: No layouts defined, generate single variant for device dimensions
      try {
        const resizedBuffer = await sharp(originalBuffer)
          .resize(device.width, device.height, {
            fit: "cover",
            position: "entropy",
          })
          .jpeg({ quality: 90 })
          .toBuffer();

        const variantPath = `processed/${device.width}x${device.height}/${blobHash}.jpg`;
        const variantGcsUri = await uploadToGCS(resizedBuffer, variantPath, bucketName);

        variants.push({
          width: device.width,
          height: device.height,
          orientation: device.orientation,
          layout_type: "single",
          storage_path: variantGcsUri,
          file_size: resizedBuffer.length,
        });

        console.log(`    ✓ ${device.width}x${device.height} (legacy single)`);
      } catch (error) {
        console.error(`    ✗ ${device.width}x${device.height}: ${error.message}`);
      }
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
