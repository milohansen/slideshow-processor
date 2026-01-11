/**
 * Image Processor Cloud Run Job
 * Entry point that handles task sharding and batch coordination
 */

import { processImage } from "./processor.ts";

// Cloud Run Jobs environment variables for task sharding
const TASK_INDEX = parseInt(Deno.env.get("CLOUD_RUN_TASK_INDEX") || "0");
const TASK_COUNT = parseInt(Deno.env.get("CLOUD_RUN_TASK_COUNT") || "1");
const TASK_ATTEMPT = parseInt(Deno.env.get("CLOUD_RUN_TASK_ATTEMPT") || "0");

// Configuration from environment
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME");
const BACKEND_API_URL = Deno.env.get("BACKEND_API_URL");
// const BACKEND_AUTH_TOKEN = Deno.env.get("BACKEND_AUTH_TOKEN");

interface PendingImage {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
}

interface ProcessingStartResponse {
  attempt: number;
  devices: Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;
}

/**
 * Fetch pending images from backend
 */
async function fetchPendingImages(): Promise<PendingImage[]> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  const response = await fetch(`${BACKEND_API_URL}/api/processing/pending?limit=50`, {
    headers: {
      // "Authorization": `Bearer ${BACKEND_AUTH_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch pending images: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Register processing attempt with backend
 */
async function registerAttempt(imageId: string): Promise<ProcessingStartResponse> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  const response = await fetch(`${BACKEND_API_URL}/api/processing-attempts/${imageId}/start`, {
    method: "POST",
    headers: {
      // "Authorization": `Bearer ${BACKEND_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attempt: TASK_ATTEMPT }),
  });

  if (!response.ok) {
    throw new Error(`Failed to register attempt for ${imageId}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Report processing failure to backend
 */
async function reportFailure(imageId: string, error: string): Promise<void> {
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  await fetch(`${BACKEND_API_URL}/api/images/${imageId}/failed`, {
    method: "PATCH",
    headers: {
      // "Authorization": `Bearer ${BACKEND_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ error, attempt: TASK_ATTEMPT }),
  });
}

/**
 * Main entry point
 */
async function main() {
  console.log(`🚀 Task ${TASK_INDEX}/${TASK_COUNT} starting (attempt ${TASK_ATTEMPT})`);

  if (!GCS_BUCKET_NAME) {
    throw new Error("GCS_BUCKET_NAME environment variable required");
  }

  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }

  // if (!BACKEND_AUTH_TOKEN) {
  //   throw new Error("BACKEND_AUTH_TOKEN environment variable required");
  // }

  try {
    // Fetch all pending images
    const allImages = await fetchPendingImages();
    console.log(`📋 Total pending images: ${allImages.length}`);

    // Shard: Each task only processes its assigned subset
    const myImages = allImages.filter((_, index) => index % TASK_COUNT === TASK_INDEX);
    console.log(`📦 Task ${TASK_INDEX} processing ${myImages.length} images`);

    let processed = 0;
    let failed = 0;

    for (const image of myImages) {
      try {
        console.log(`\n🖼️  Processing ${image.id} (${processed + 1}/${myImages.length})`);
        
        // Register attempt and get device list
        const startResponse = await registerAttempt(image.id);
        console.log(`   Attempt ${startResponse.attempt}, targeting ${startResponse.devices.length} devices`);

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
          // authToken: BACKEND_AUTH_TOKEN,
        });

        processed++;
        console.log(`   ✅ Success`);
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`   ❌ Failed: ${errorMessage}`);
        
        // Report failure to backend
        try {
          await reportFailure(image.id, errorMessage);
        } catch (reportError) {
          console.error(`   ⚠️  Failed to report error to backend:`, reportError);
        }
      }
    }

    console.log(`\n✨ Task ${TASK_INDEX} complete: ${processed} processed, ${failed} failed`);
    
    // Exit with error code if any failures
    if (failed > 0) {
      Deno.exit(1);
    }
  } catch (error) {
    console.error(`💥 Task ${TASK_INDEX} fatal error:`, error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
