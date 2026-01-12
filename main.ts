/**
 * Image Processor Cloud Run Service
 * HTTP server that processes individual images via Cloud Tasks
 */

import { Hono } from "hono";
import { logger } from "hono/logger";
import { processImage } from "./processor.ts";

// Configuration from environment
const PORT = Number(Deno.env.get("PORT")) || 8080;
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
 * Report transient failure to backend (for legacy PATCH endpoint)
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

// Create Hono app
const app = new Hono();

// Add logging middleware
app.use("*", logger());

// Health check endpoint
app.get("/", (c) => {
  return c.json({ 
    status: "healthy", 
    service: "slideshow-processor",
    version: "2.0.0-cloud-tasks",
  });
});

/**
 * POST /process
 * Process a single image from Cloud Tasks
 */
app.post("/process", async (c) => {
  const MAX_RETRIES = 3;
  
  try {
    const body = await c.req.json();
    const { imageId } = body;

    if (!imageId) {
      return c.json({ error: "Missing imageId in request body" }, 400);
    }

    if (!GCS_BUCKET_NAME) {
      return c.json({ error: "GCS_BUCKET_NAME not configured" }, 500);
    }

    if (!BACKEND_API_URL) {
      return c.json({ error: "BACKEND_API_URL not configured" }, 500);
    }

    // Get task attempt from Cloud Tasks header
    const attemptHeader = c.req.header("X-CloudTasks-TaskExecutionCount");
    const attempt = attemptHeader ? parseInt(attemptHeader) + 1 : 1;

    console.log(`\n🖼️  Processing image ${imageId} (attempt ${attempt}/${MAX_RETRIES})`);

    // Fetch image details
    const image = await fetchImageDetails(imageId);
    console.log(`   Found image: ${image.file_path}`);

    // Register attempt and get device list
    const startResponse = await registerAttempt(imageId, attempt);
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
    return c.json({ 
      success: true, 
      imageId,
      devicesProcessed: startResponse.devices.length,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Processing failed: ${errorMessage}`);

    try {
      const body = await c.req.json();
      const { imageId } = body;
      const attemptHeader = c.req.header("X-CloudTasks-TaskExecutionCount");
      const attempt = attemptHeader ? parseInt(attemptHeader) + 1 : 1;

      if (attempt >= MAX_RETRIES) {
        // Max retries reached - record as failed task
        console.log(`   ⚠️  Max retries reached, recording failed task`);
        await reportMaxRetriesFailed(imageId, errorMessage, attempt);
        
        // Return 200 to prevent Cloud Tasks from retrying
        return c.json({ 
          success: false, 
          error: errorMessage,
          maxRetriesReached: true,
        }, 200);
      } else {
        // Transient failure - let Cloud Tasks retry
        await reportTransientFailure(imageId, errorMessage, attempt);
        
        // Return 500 to trigger Cloud Tasks retry
        return c.json({ 
          error: errorMessage,
          willRetry: true,
          attempt,
        }, 500);
      }
    } catch (reportError) {
      console.error(`   ⚠️  Failed to report error:`, reportError);
      // Return 500 to trigger retry if we can't report
      return c.json({ error: errorMessage }, 500);
    }
  }
});

// Start server
console.log(`🚀 Starting Image Processor HTTP Service`);
console.log(`   GCS Bucket: ${GCS_BUCKET_NAME || '(not set)'}`);
console.log(`   Backend API: ${BACKEND_API_URL || '(not set)'}`);
console.log(`   Port: ${PORT}`);

Deno.serve({ 
  port: PORT,
  hostname: "0.0.0.0",
  onListen: ({ hostname, port }) => {
    console.log(`✅ Server running on http://${hostname}:${port}`);
  }
}, app.fetch);
