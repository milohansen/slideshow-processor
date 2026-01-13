/**
 * Image Processor V2 - Core Processing Logic
 * Handles downloading, fingerprinting, resizing, and color extraction
 */

import { Storage } from "@google-cloud/storage";
import { QuantizerCelebi, Score, argbFromRgb } from "@material/material-color-utilities";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { Buffer } from "node:buffer";
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
  orientation: string; // TODO: remove this, it can be derived from width/height
  gap?: number; // gap between images in pair layouts
  layouts?: {
    monotych: true; // single image full screen
    diptych?: boolean; // two images side by side
    triptych?: boolean; // three images side by side
  };
};

type ProcessingOptions = {
  source: Source;
  deviceDimensions: DeviceDimensions[];
  bucketName: string;
  backendApiUrl: string;
  checkBlobExists: (hash: string) => Promise<boolean>;
};

export type ProcessingResult = {
  status: "processed" | "duplicate";
  blobHash?: string;
  blobData?: {
    storage_path: string;
    width: number;
    height: number;
    aspect_ratio: number;
    orientation: "portrait" | "landscape" | "square";
    file_size: number;
    mime_type: string;
    exif_data: string | null;
  };
  colorData?: {
    palette: string;
    source: string;
  };
  variants: Variant[];
};

type LayoutType = "monotych" | "diptych" | "triptych";

type Variant = {
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  layout_type: LayoutType;
  storage_path: string;
  file_size: number;
};

/**
 * Download file from GCS or local path
 */
async function downloadSource(stagingPath: string): Promise<Buffer> {
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
  const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(buffer));
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
 * Returns both the ranked color palette and the raw quantized color data
 */
async function extractColors(imageBuffer: Buffer, maxResolution = 256): Promise<{ colors: string[]; quantizedData: Map<number, number> }> {
  // Resize to smaller proxy for performance
  const { data } = await sharp(imageBuffer).resize(maxResolution, maxResolution, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

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
    return {
      colors: ["#4285F4"],
      quantizedData: new Map([[0xff4285f4, 1]]),
    };
  }

  // Quantize and score
  const quantized = QuantizerCelebi.quantize(pixels, 128);
  const rankedColors = Score.score(quantized, {
    desired: 8,
    filter: true,
    fallbackColorARGB: 0xff4285f4,
  });

  // Convert to hex
  const colors = rankedColors.map((argb) => "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase());

  return { colors, quantizedData: quantized };
}

/**
 * Save quantized color data to GCS for later use in paired layouts
 */
async function saveQuantizedColors(blobHash: string, quantizedData: Map<number, number>, bucketName: string): Promise<string> {
  // Convert Map to JSON-serializable object
  const colorData: Record<string, number> = {};
  for (const [argb, count] of quantizedData.entries()) {
    // Store ARGB as hex string for JSON compatibility
    const hex = "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
    colorData[hex] = count;
  }

  const jsonContent = JSON.stringify(
    {
      hash: blobHash,
      timestamp: new Date().toISOString(),
      colorCount: quantizedData.size,
      colors: colorData,
    },
    null,
    2
  );

  const path = `images/quantized/${blobHash}.json`;
  const file = storage.bucket(bucketName).file(path);
  await file.save(jsonContent, {
    metadata: {
      contentType: "application/json",
    },
  });

  return `gs://${bucketName}/${path}`;
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
function calculateCropPercentage(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): number {
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
 * Returns layout configurations with calculated dimensions and crop percentages
 */
function evaluateImageLayouts(imageWidth: number, imageHeight: number, device: DeviceDimensions): Array<{ layoutType: string; width: number; height: number; cropPercentage: number }> {
  const layouts = device.layouts;
  if (!layouts) {
    // Default to monotych (full screen single image)
    return [
      {
        layoutType: "monotych",
        width: device.width,
        height: device.height,
        cropPercentage: calculateCropPercentage(imageWidth, imageHeight, device.width, device.height),
      },
    ];
  }

  const eligible = [];
  const gap = device.gap || 0;

  // Always include monotych (single image full screen)
  if (layouts.monotych) {
    const cropPercentage = calculateCropPercentage(imageWidth, imageHeight, device.width, device.height);
    if (cropPercentage <= 50) {
      eligible.push({
        layoutType: "monotych",
        width: device.width,
        height: device.height,
        cropPercentage,
      });
    }
  }

  // Diptych (two images side by side)
  if (layouts.diptych) {
    let w = device.width;
    let h = device.height;
    if (h > w) {
      h = Math.floor((h - gap) / 2);
    } else {
      w = Math.floor((w - gap) / 2);
    }
    const cropPercentage = calculateCropPercentage(imageWidth, imageHeight, w, h);
    if (cropPercentage <= 50) {
      eligible.push({
        layoutType: "diptych",
        width: w,
        height: h,
        cropPercentage,
      });
    }
  }

  // Triptych (three images side by side)
  if (layouts.triptych) {
    let w = device.width;
    let h = device.height;
    if (h > w) {
      h = Math.floor((h - gap * 2) / 3);
    } else {
      w = Math.floor((w - gap * 2) / 3);
    }
    const cropPercentage = calculateCropPercentage(imageWidth, imageHeight, w, h);
    if (cropPercentage <= 50) {
      eligible.push({
        layoutType: "triptych",
        width: w,
        height: h,
        cropPercentage,
      });
    }
  }

  // Sort by crop percentage (least crop first)
  eligible.sort((a, b) => a.cropPercentage - b.cropPercentage);

  return eligible;
}

/**
 * Process a single source
 */
export async function processSourceV2(options: ProcessingOptions): Promise<ProcessingResult> {
  const { source, deviceDimensions, bucketName } = options;

  // Step 1: Download original
  console.log(`  📥 Downloading from ${source.staging_path}`);
  const originalBuffer = await downloadSource(source.staging_path);

  // Step 2: Calculate hash (fingerprint)
  const blobHash = await calculateHash(originalBuffer);
  console.log(`  🔑 Hash: ${blobHash}`);

  // // Step 3: Check for duplicate
  // const exists = await checkBlobExists(blobHash);
  // if (exists) {
  //   console.log(`  ♻️  Duplicate detected, skipping processing`);
  //   return {
  //     status: "duplicate",
  //     blobHash,
  //     variants: [],
  //   };
  // }

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
  const { colors, quantizedData } = await extractColors(originalBuffer);
  const colorPalette = JSON.stringify(colors);
  const colorSource = colors[0];

  // Step 6b: Save quantized color data for future paired layout combinations
  const quantizedUri = await saveQuantizedColors(blobHash, quantizedData, bucketName);
  console.log(`  💾 Saved quantized colors: ${quantizedUri}`);

  // Step 6c: Generate thumbnail (200x200 for UI preview)
  console.log(`  🖼️  Generating thumbnail...`);
  const thumbnailBuffer = await sharp(originalBuffer)
    .resize(200, 200, {
      fit: "cover",
      position: "entropy",
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const thumbnailPath = `processed/thumbnails/${blobHash}`;
  await uploadToGCS(thumbnailBuffer, thumbnailPath, bucketName);
  console.log(`  ✅ Thumbnail uploaded: ${thumbnailPath}`);

  // Step 7: Generate device variants
  console.log(`  🖼️  Generating variants for ${deviceDimensions.length} device(s)...`);
  const variants: Variant[] = [];

  for (const device of deviceDimensions) {
    const eligibleLayouts = evaluateImageLayouts(width, height, device);

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

        const resizedOutsideBuffer = await sharp(originalBuffer)
          .resize(layout.width, layout.height, {
            fit: "outside",
          })
          .jpeg({ quality: 90 })
          .toBuffer();

        // Upload variant
        const variantOutsidePath = `processed/${layout.layoutType}/${layout.width}x${layout.height}_outside/${blobHash}.jpg`;
        const _variantOutsideGcsUri = await uploadToGCS(resizedOutsideBuffer, variantOutsidePath, bucketName);

        variants.push({
          width: layout.width,
          height: layout.height,
          orientation: determineOrientation(layout.width, layout.height),
          layout_type: layout.layoutType as LayoutType,
          storage_path: variantGcsUri,
          file_size: resizedBuffer.length,
        });

        console.log(`      ✓ ${layout.layoutType}: ${layout.width}x${layout.height} (crop: ${layout.cropPercentage.toFixed(1)}%)`);
      } catch (error) {
        console.error(`      ✗ ${layout.layoutType} ${layout.width}x${layout.height}: ${error instanceof Error ? error.message : String(error)}`);
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
