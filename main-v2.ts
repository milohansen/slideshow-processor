/**
 * Image Processor V2 - Batch Manifest Processing
 * Entry point that processes sources from batch manifest
 */

import { processSourceV2 } from "./processor-v2.ts";

// Cloud Run Jobs environment variables
const TASK_INDEX = parseInt(Deno.env.get("CLOUD_RUN_TASK_INDEX") || "0");
const TASK_COUNT = parseInt(Deno.env.get("CLOUD_RUN_TASK_COUNT") || "1");
const TASK_ATTEMPT = parseInt(Deno.env.get("CLOUD_RUN_TASK_ATTEMPT") || "0");

// Batch configuration from environment
const BATCH_ID = Deno.env.get("BATCH_ID");
const SOURCE_IDS_JSON = Deno.env.get("SOURCE_IDS");
const BACKEND_API_URL = Deno.env.get("BACKEND_API_URL");
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME");

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

/**
 * Fetch sources from batch manifest or backend
 */
async function fetchSourcesToProcess(): Promise<Source[]> {
  // If SOURCE_IDS provided, fetch those specific sources
  if (SOURCE_IDS_JSON) {
    const sourceIds: string[] = JSON.parse(SOURCE_IDS_JSON);
    console.log(`📋 Processing ${sourceIds.length} sources from batch manifest`);
    
    // Fetch source details from backend
    const response = await fetch(`${BACKEND_API_URL}/api/processing/staged?limit=1000`, {
      headers: {
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch sources: ${response.statusText}`);
    }
    
    const { sources } = await response.json();
    return sources.filter((s: Source) => sourceIds.includes(s.id));
  }
  
  // Otherwise fetch all staged sources
  console.log(`📋 Fetching all staged sources from backend`);
  const response = await fetch(`${BACKEND_API_URL}/api/processing/staged?limit=100`, {
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch staged sources: ${response.statusText}`);
  }
  
  const { sources } = await response.json();
  return sources;
}

/**
 * Fetch device dimensions from backend
 */
async function fetchDeviceDimensions(): Promise<DeviceDimensions[]> {
  const response = await fetch(`${BACKEND_API_URL}/api/processing/device-dimensions`, {
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch device dimensions: ${response.statusText}`);
  }
  
  const { devices } = await response.json();
  return devices;
}

/**
 * Check if blob hash exists (duplicate detection)
 */
async function checkBlobExists(hash: string): Promise<boolean> {
  const response = await fetch(`${BACKEND_API_URL}/api/processing/check-hash/${hash}`, {
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
    },
  });
  
  if (!response.ok) {
    return false;
  }
  
  const { exists } = await response.json();
  return exists;
}

/**
 * Report processing completion
 */
async function finalizeProcessing(data: {
  sourceId: string;
  blobHash: string;
  blobData: any;
  colorData: any;
  variants: any[];
}): Promise<void> {
  const response = await fetch(`${BACKEND_API_URL}/api/processing/finalize`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to finalize: ${error}`);
  }
}

/**
 * Report processing failure
 */
async function reportFailure(sourceId: string, error: string): Promise<void> {
  await fetch(`${BACKEND_API_URL}/api/processing/fail`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourceId, error }),
  });
}

/**
 * Main entry point
 */
async function main() {
  console.log(`🚀 Processor V2 - Task ${TASK_INDEX}/${TASK_COUNT} (attempt ${TASK_ATTEMPT})`);
  console.log(`📦 Batch ID: ${BATCH_ID || "auto"}`);

  // Validate environment
  if (!BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL environment variable required");
  }
  if (!GCS_BUCKET_NAME) {
    throw new Error("GCS_BUCKET_NAME environment variable required");
  }

  try {
    // Fetch sources and device dimensions
    const [allSources, deviceDimensions] = await Promise.all([
      fetchSourcesToProcess(),
      fetchDeviceDimensions(),
    ]);
    
    console.log(`📋 Total sources: ${allSources.length}`);
    console.log(`📱 Device dimensions: ${deviceDimensions.length}`);

    // Shard: Each task processes its assigned subset
    const mySources = allSources.filter((_, index) => index % TASK_COUNT === TASK_INDEX);
    console.log(`📦 Task ${TASK_INDEX} processing ${mySources.length} sources`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const source of mySources) {
      try {
        console.log(`\n🖼️  Processing source ${source.id} (${processed + skipped + 1}/${mySources.length})`);
        
        const result = await processSourceV2({
          source,
          deviceDimensions,
          bucketName: GCS_BUCKET_NAME,
          backendApiUrl: BACKEND_API_URL,
          checkBlobExists,
        });

        if (result.status === "duplicate") {
          skipped++;
          console.log(`   ⏭️  Skipped (duplicate): ${result.blobHash}`);
          
          // Still finalize to link source to existing blob
          await finalizeProcessing({
            sourceId: source.id,
            blobHash: result.blobHash!,
            blobData: null,
            colorData: null,
            variants: [],
          });
        } else {
          // Report results to backend
          await finalizeProcessing({
            sourceId: source.id,
            blobHash: result.blobHash!,
            blobData: result.blobData,
            colorData: result.colorData,
            variants: result.variants,
          });
          
          processed++;
          console.log(`   ✅ Success: ${result.variants.length} variants created`);
        }
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`   ❌ Failed: ${errorMessage}`);
        
        try {
          await reportFailure(source.id, errorMessage);
        } catch (reportError) {
          console.error(`   ⚠️  Failed to report error:`, reportError);
        }
      }
    }

    console.log(`\n✨ Task ${TASK_INDEX} complete: ${processed} processed, ${skipped} skipped, ${failed} failed`);
    
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
