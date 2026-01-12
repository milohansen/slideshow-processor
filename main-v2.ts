/**
 * Image Processor Cloud Run Job v2
 * Processes a single image specified by TARGET_FILE_ID environment variable
 * Triggered by Cloud Workflow via Cloud Tasks
 */

import { Storage } from "@google-cloud/storage";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { processSourceV2 } from "./processor-v2.ts";

const storage = new Storage();

// Cloud Run Jobs environment variables
const TARGET_FILE_ID = Deno.env.get("TARGET_FILE_ID");
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME");
const BACKEND_API_URL = Deno.env.get("BACKEND_API_URL");

type ProcessingStartResponse = {
  attempt: number;
  devices: Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;
}

type ImageDetails = {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
  processing_status: string;
}

/**
 * Check if original image exists in GCS and get its metadata
 */
async function findOriginalInGCS(imageId: string, bucketName: string): Promise<{ exists: boolean; hash?: string; buffer?: Buffer; width?: number; height?: number; orientation?: string }> {
  try {
    const bucket = storage.bucket(bucketName);
    
    // Check for any file in images/originals/ that starts with imageId
    // Format: images/originals/{hash}.{ext}
    const [files] = await bucket.getFiles({
      prefix: `images/originals/${imageId}`,
      maxResults: 1,
    });
    
    if (files.length === 0) {
      return { exists: false };
    }
    
    const file = files[0];
    const fileName = file.name.split('/').pop() || '';
    const hash = fileName.split('.')[0];
    
    // Download file to get dimensions
    const [contents] = await file.download();
    const buffer = Buffer.from(contents);
    
    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const orientation = width > height ? 'landscape' : (height > width ? 'portrait' : 'square');
    
    return {
      exists: true,
      hash,
      buffer,
      width,
      height,
      orientation,
    };
  } catch (error) {
    console.error(`Failed to check GCS for ${imageId}:`, error);
    return { exists: false };
  }
}

/**
 * Fetch image details from backend
 */
async function fetchImageDetails(imageId: string): Promise<ImageDetails | null> {
  if (!BACKEND_API_URL) {
    return null;
  }

  try {
    const response = await fetch(`${BACKEND_API_URL}/api/processing/pending?limit=50`);
    
    if (!response.ok) {
      return null;
    }

    const images = await response.json() as ImageDetails[];
    return images.find(img => img.id === imageId) || null;
  } catch (error) {
    console.warn(`Could not fetch image details from backend:`, error);
    return null;
  }
}

/**
 * Register processing attempt with backend
 * Creates image record if it doesn't exist
 */
async function registerAttempt(imageId: string, attempt: number, imageInfo?: { width: number; height: number; orientation: string; filePath: string }): Promise<ProcessingStartResponse | null> {
  if (!BACKEND_API_URL) {
    return null;
  }

  try {
    const response = await fetch(`${BACKEND_API_URL}/api/processing/${imageId}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        attempt,
        ...(imageInfo && { imageInfo }),
      }),
    });

    if (!response.ok) {
      console.warn(`Failed to register attempt: ${response.statusText}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(`Could not register attempt with backend:`, error);
    return null;
  }
}

/**
 * Report task failure after max retries to backend
 */
async function reportMaxRetriesFailed(imageId: string, error: string, attemptCount: number): Promise<void> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  await fetch(`${BACKEND_API_URL}/api/processing/${imageId}/failed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ 
      error_message: error,
      attempt_count: attemptCount,
    }),
  });
}

/**
 * Report transient failure to backend
 */
async function reportTransientFailure(imageId: string, error: string, attempt: number): Promise<void> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  await fetch(`${BACKEND_API_URL}/api/images/${imageId}/failed`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ error, attempt }),
  });
}

/**
 * Main entry point
 */
async function main() {
  const MAX_RETRIES = 3;
  const TASK_ATTEMPT = parseInt(Deno.env.get("CLOUD_RUN_TASK_ATTEMPT") || "0") + 1;

  console.log(`🚀 Image Processor v2 starting (attempt ${TASK_ATTEMPT}/${MAX_RETRIES})`);

  if (!TARGET_FILE_ID) {
    throw new Error("TARGET_FILE_ID environment variable required");
  }

  if (!GCS_BUCKET_NAME) {
    throw new Error("GCS_BUCKET_NAME environment variable required");
  }

  const imageId = TARGET_FILE_ID;

  try {
    console.log(`\n🖼️  Processing image ${imageId}`);

    // Step 1: Check if original exists in GCS
    console.log(`   Checking GCS for original...`);
    const gcsResult = await findOriginalInGCS(imageId, GCS_BUCKET_NAME);
    
    if (!gcsResult.exists) {
      throw new Error(`Original image not found in GCS for ${imageId}`);
    }
    
    console.log(`   Found original: ${gcsResult.hash} (${gcsResult.width}x${gcsResult.height})`);

    // Step 2: Try to fetch image details from backend (optional)
    const backendImage = await fetchImageDetails(imageId);
    
    // Step 3: Register attempt with backend (creates record if needed)
    const imageInfo = {
      width: gcsResult.width!,
      height: gcsResult.height!,
      orientation: gcsResult.orientation!,
      filePath: `gs://${GCS_BUCKET_NAME}/images/originals/${gcsResult.hash}`,
    };
    
    const startResponse = await registerAttempt(imageId, TASK_ATTEMPT, imageInfo);
    const devices = startResponse?.devices || [];
    
    if (devices.length === 0) {
      console.warn(`   No devices available, skipping processing`);
      return;
    }
    
    console.log(`   Targeting ${devices.length} devices`);

    // Step 4: Check if blob already exists
    const checkBlobExists = async (hash: string): Promise<boolean> => {
      if (!BACKEND_API_URL) return false;
      try {
        const response = await fetch(`${BACKEND_API_URL}/api/blobs/${hash}`);
        return response.ok;
      } catch {
        return false;
      }
    };

    // Step 5: Process image
    await processSourceV2({
      source: {
        id: imageId,
        staging_path: `gs://${GCS_BUCKET_NAME}/images/originals/${gcsResult.hash}`,
        origin: "gcs",
      },
      deviceDimensions: devices.map(d => ({
        width: d.width,
        height: d.height,
        orientation: d.orientation,
        layouts: { monotych: true },
      })),
      bucketName: GCS_BUCKET_NAME,
      backendApiUrl: BACKEND_API_URL || "",
      checkBlobExists,
    });

    console.log(`   ✅ Successfully processed ${imageId}`);
    console.log(`\n✨ Job complete`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Processing failed: ${errorMessage}`);

    try {
      if (TASK_ATTEMPT >= MAX_RETRIES) {
        // Max retries reached - record as failed task
        console.log(`   ⚠️  Max retries reached, recording failed task`);
        await reportMaxRetriesFailed(imageId, errorMessage, TASK_ATTEMPT);
      } else {
        // Transient failure - will be retried by Cloud Run Jobs
        await reportTransientFailure(imageId, errorMessage, TASK_ATTEMPT);
      }
    } catch (reportError) {
      console.error(`   ⚠️  Failed to report error to backend:`, reportError);
    }

    console.error(`\n💥 Job failed: ${errorMessage}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
