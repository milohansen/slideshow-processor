/**
 * Image processor using sharp for high-performance resizing
 * and Material Color Utilities for color extraction
 */

import sharp from "sharp";
import { QuantizerCelebi, Score, argbFromRgb } from "@material/material-color-utilities";
import { Storage } from "@google-cloud/storage";
import { Buffer } from "node:buffer";

interface Device {
  name: string;
  width: number;
  height: number;
  orientation: string;
}

interface ProcessImageOptions {
  imageId: string;
  sourcePath: string; // GCS URI like gs://bucket/images/originals/abc123.jpg
  sourceWidth: number;
  sourceHeight: number;
  sourceOrientation: string;
  devices: Device[];
  bucketName: string;
  backendApiUrl: string;
  // authToken: string;
}

interface ColorPalette {
  primary: string;
  secondary: string;
  tertiary: string;
  sourceColor: string;
  allColors: string[];
}

interface ProcessedImageResult {
  imageId: string;
  deviceSize: string;
  width: number;
  height: number;
  filePath: string; // GCS URI
  colorPalette: ColorPalette;
}

let storage: Storage | null = null;

/**
 * Initialize GCS client
 */
function getStorage(): Storage {
  if (!storage) {
    storage = new Storage();
  }
  return storage;
}

/**
 * Download image from GCS to buffer
 */
async function downloadImageFromGCS(gcsUri: string, bucketName: string): Promise<Buffer> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  
  // Extract path from gs://bucket/path format
  const pathMatch = gcsUri.match(/^gs:\/\/[^\/]+\/(.+)$/);
  if (!pathMatch) {
    throw new Error(`Invalid GCS URI format: ${gcsUri}`);
  }
  
  const filePath = pathMatch[1];
  const file = bucket.file(filePath);
  
  const [buffer] = await file.download();
  return buffer;
}

/**
 * Upload buffer to GCS
 */
async function uploadBufferToGCS(
  buffer: Buffer,
  gcsPath: string,
  bucketName: string,
  contentType: string = "image/jpeg"
): Promise<string> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsPath);
  
  await file.save(buffer, {
    contentType,
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });
  
  return `gs://${bucketName}/${gcsPath}`;
}

/**
 * Extract dominant colors from image buffer using Material Color Utilities
 * Uses 256px longest-side proxy for better aspect ratio representation
 */
async function extractColors(buffer: Buffer, numColors = 8): Promise<ColorPalette> {
  // Resize to 256px on longest side, preserving aspect ratio
  const { data: rawPixels, info } = await sharp(buffer)
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert RGBA (Uint8) to ARGB (Int32) for Material utilities
  const pixels: number[] = [];
  for (let i = 0; i < rawPixels.length; i += 4) {
    const r = rawPixels[i];
    const g = rawPixels[i + 1];
    const b = rawPixels[i + 2];
    const a = rawPixels[i + 3];
    
    // Skip fully transparent pixels
    if (a < 255) continue;
    
    const argb = argbFromRgb(r, g, b);
    pixels.push(argb);
  }

  if (pixels.length === 0) {
    throw new Error("No valid pixels found in image");
  }

  // Quantize to get color histogram
  const quantized = QuantizerCelebi.quantize(pixels, 128);

  // Score colors using Material Design principles
  const rankedColors = Score.score(quantized, {
    desired: numColors,
    filter: true,
    fallbackColorARGB: 0xff4285f4, // Google Blue as fallback
  });

  // Convert ARGB integers to hex strings
  const colors: string[] = [];
  for (const argb of rankedColors) {
    const hex = "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
    colors.push(hex);
  }

  // Ensure we have enough colors
  while (colors.length < numColors && colors.length > 0) {
    colors.push(colors[0]);
  }

  return {
    primary: colors[0] || "#4285F4",
    secondary: colors[1] || colors[0] || "#4285F4",
    tertiary: colors[2] || colors[0] || "#4285F4",
    sourceColor: colors[0] || "#4285F4",
    allColors: colors,
  };
}

/**
 * Resize image for device using sharp
 */
async function resizeImageForDevice(
  buffer: Buffer,
  device: Device
): Promise<Buffer> {
  return await sharp(buffer)
    .resize(device.width, device.height, {
      fit: "cover",
      position: "center",
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Save metadata JSON to GCS
 */
async function saveMetadataToGCS(
  imageId: string,
  bucketName: string,
  results: ProcessedImageResult[]
): Promise<void> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  
  const metadata = {
    imageId,
    processedAt: new Date().toISOString(),
    results: results.map(r => ({
      deviceSize: r.deviceSize,
      width: r.width,
      height: r.height,
      filePath: r.filePath,
      colors: r.colorPalette.allColors,
      primary: r.colorPalette.primary,
      secondary: r.colorPalette.secondary,
      tertiary: r.colorPalette.tertiary,
    })),
  };
  
  const metadataPath = `images/metadata/${imageId}.json`;
  const file = bucket.file(metadataPath);
  
  await file.save(JSON.stringify(metadata, null, 2), {
    contentType: "application/json",
  });
  
  console.log(`   💾 Saved metadata to gs://${bucketName}/${metadataPath}`);
}

/**
 * Submit processed images to backend API
 */
async function submitProcessedImages(
  results: ProcessedImageResult[],
  backendApiUrl: string,
  // authToken: string
): Promise<void> {
  const response = await fetch(`${backendApiUrl}/api/processed-images`, {
    method: "POST",
    headers: {
      // "Authorization": `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ images: results }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit processed images: ${response.statusText} - ${text}`);
  }

  console.log(`   ✅ Submitted ${results.length} processed images to backend`);
}

/**
 * Process a single image for all devices
 */
export async function processImage(options: ProcessImageOptions): Promise<void> {
  const {
    imageId,
    sourcePath,
    devices,
    bucketName,
    backendApiUrl,
    // authToken,
  } = options;

  // Download original image
  console.log(`   📥 Downloading ${sourcePath}`);
  const sourceBuffer = await downloadImageFromGCS(sourcePath, bucketName);
  console.log(`   ✅ Downloaded ${sourceBuffer.length} bytes`);

  // Extract colors once from original
  console.log(`   🎨 Extracting colors from 256px proxy...`);
  const colorPalette = await extractColors(sourceBuffer);
  console.log(`   ✅ Extracted colors: ${colorPalette.allColors.slice(0, 3).join(", ")}`);

  // Generate thumbnail (200x200 for UI preview)
  console.log(`   🖼️  Generating thumbnail...`);
  const thumbnailBuffer = await sharp(sourceBuffer)
    .resize(200, 200, {
      fit: "cover",
      position: "center",
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  
  const thumbnailPath = `processed/thumbnails/${imageId}.jpg`;
  const thumbnailUri = await uploadBufferToGCS(thumbnailBuffer, thumbnailPath, bucketName, "image/jpeg");
  console.log(`   ✅ Thumbnail uploaded: ${thumbnailUri}`);

  const results: ProcessedImageResult[] = [];

  // Process for each device
  for (const device of devices) {
    console.log(`   📐 Resizing for ${device.name} (${device.width}x${device.height})`);
    
    const resizedBuffer = await resizeImageForDevice(sourceBuffer, device);
    
    // Upload to GCS
    const gcsPath = `processed/${device.name}/${imageId}.jpg`;
    const gcsUri = await uploadBufferToGCS(resizedBuffer, gcsPath, bucketName, "image/jpeg");
    console.log(`   ✅ Uploaded to ${gcsUri}`);

    results.push({
      imageId,
      deviceSize: device.name,
      width: device.width,
      height: device.height,
      filePath: gcsUri,
      colorPalette,
    });
  }

  // Save metadata JSON sidecar to GCS
  await saveMetadataToGCS(imageId, bucketName, results);

  // Submit results to backend API
  await submitProcessedImages(results, backendApiUrl /*, authToken*/);
  
  console.log(`   🎉 Completed processing for all ${devices.length} devices`);
}
