/**
 * Image Processor Cloud Run Job v2
 * Processes a single image specified by TARGET_FILE_ID environment variable
 * Triggered by Cloud Workflow via Cloud Tasks
 */

import { processImage } from "./processor.ts";

// Cloud Run Jobs environment variables
const TARGET_FILE_ID = Deno.env.get("TARGET_FILE_ID");
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME");
const BACKEND_API_URL = Deno.env.get("BACKEND_API_URL");

interface ProcessingStartResponse {
  attempt: number;
  devices: Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;
}

interface ImageDetails {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
  processing_status: string;
}

/**
 * Fetch image details from backend
 */
async function fetchImageDetails(imageId: string): Promise<ImageDetails> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  const response = await fetch(`${BACKEND_API_URL}/api/processing/pending?limit=50`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch image details: ${response.statusText}`);
  }

  const images = await response.json() as ImageDetails[];
  const image = images.find(img => img.id === imageId);
  
  if (!image) {
    throw new Error(`Image ${imageId} not found or not pending`);
  }
  
  return image;
}

/**
 * Register processing attempt with backend
 */
async function registerAttempt(imageId: string, attempt: number): Promise<ProcessingStartResponse> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  const response = await fetch(`${BACKEND_API_URL}/api/processing/${imageId}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attempt }),
  });

  if (!response.ok) {
    throw new Error(`Failed to register attempt for ${imageId}: ${response.statusText}`);
  }

  return await response.json();
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

  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  const imageId = TARGET_FILE_ID;

  try {
    console.log(`\n🖼️  Processing image ${imageId}`);

    // Fetch image details
    const image = await fetchImageDetails(imageId);
    console.log(`   Found image: ${image.file_path}`);

    // Register attempt and get device list
    const startResponse = await registerAttempt(imageId, TASK_ATTEMPT);
    console.log(`   Targeting ${startResponse.devices.length} devices`);

    // Process image for all devices
    await processImage({
      imageId: image.id,
      sourcePath: image.file_path,
      sourceWidth: image.width,
      sourceHeight: image.height,
      sourceOrientation: image.orientation,
      devices: startResponse.devices,
      bucketName: GCS_BUCKET_NAME,
      backendApiUrl: BACKEND_API_URL,
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
