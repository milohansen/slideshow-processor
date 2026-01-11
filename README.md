# Slideshow Processor

Cloud Run Job for high-performance image processing using `sharp` and Material Color Utilities. Processes images in parallel across multiple tasks for the slideshow backend.

## Architecture

This processor is designed to run as a **Cloud Run Job** (not a service) that:

1. **Fetches pending images** from the backend API (up to 50 per execution)
2. **Shards work** across multiple parallel tasks using `CLOUD_RUN_TASK_INDEX` and `CLOUD_RUN_TASK_COUNT`
3. **Processes each image** for all registered device sizes:
   - Downloads original from Google Cloud Storage
   - Resizes using `sharp` with high-quality JPEG output
   - Extracts dominant colors using Material Color Utilities (256px longest-side proxy for better aspect ratio representation)
   - Uploads processed images to GCS
4. **Dual metadata persistence**:
   - Writes JSON sidecars to GCS (`images/metadata/*.json`) with 30-day auto-archive
   - Calls backend API to persist results to SQLite database
5. **Reports failures** back to backend for tracking and retry coordination

### Why Cloud Run Jobs?

- **No idle costs** - Only billed while processing
- **Parallel execution** - Process 50 images across 10 tasks simultaneously
- **Isolated failures** - Each task retries independently (max 3 attempts)
- **Better resources** - 2Gi RAM + 2 vCPU per task vs 512Mi shared in web service

## Key Design Decisions

### 1. Sharp vs ImageMagick

We use `sharp` (Node.js native module) instead of ImageMagick for:

- **Performance**: 4-5x faster resizing with libvips
- **Quality**: Superior Lanczos3 resampling by default
- **Memory efficiency**: Streaming processing, lower memory footprint
- **Deno 2.x support**: Native npm modules with `nodeModulesDir: "auto"`

### 2. Color Extraction Optimization

Colors are extracted from a **256px longest-side proxy** (not cropped):

```typescript
await sharp(buffer)
  .resize(256, 256, { fit: "inside", withoutEnlargement: true })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
```

This preserves aspect ratio better than the original 128x128 crop, providing more representative color sampling for wide/tall images.

### 3. Metadata Sync Strategy

**Dual persistence** for resilience:

- **Primary**: Direct API calls to backend (`POST /api/processed-images`)
- **Backup**: JSON files in GCS polled by backend every 60s
- If API calls fail (network issue, backend restart), metadata sync recovers missing records

## Environment Variables

Required:

- `GCS_BUCKET_NAME` - Google Cloud Storage bucket for images
- `BACKEND_API_URL` - Backend service URL (e.g., `https://backend-xyz.run.app`)
- `BACKEND_AUTH_TOKEN` - Authentication token for processor API endpoints

Cloud Run provides automatically:

- `CLOUD_RUN_TASK_INDEX` - Current task index (0-based)
- `CLOUD_RUN_TASK_COUNT` - Total number of parallel tasks
- `CLOUD_RUN_TASK_ATTEMPT` - Retry attempt number (0-2)

## Local Development

### Prerequisites

- Deno 2.6.4+
- Google Cloud credentials configured (`GOOGLE_APPLICATION_CREDENTIALS`)

### Install dependencies

```bash
deno install
```

### Run locally

```bash
export GCS_BUCKET_NAME="your-bucket"
export BACKEND_API_URL="http://localhost:8080"
export BACKEND_AUTH_TOKEN="your-token"

deno task dev
```

### Testing

Simulate task sharding:

```bash
export CLOUD_RUN_TASK_INDEX=0
export CLOUD_RUN_TASK_COUNT=2
deno task start
```

## Deployment

### 1. Build and deploy via Cloud Build

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_GCS_BUCKET_NAME=your-bucket,_BACKEND_API_URL=https://your-backend.run.app
```

### 2. Manually trigger job execution

```bash
gcloud run jobs execute slideshow-processor --region=us-central1
```

### 3. Backend triggers automatically

The backend service triggers this job when:

- New images are uploaded (batches of up to 50)
- Images have been pending for 30 seconds
- Orphaned processing images are recovered on restart

## Configuration

### Cloud Build Substitutions

Update `cloudbuild.yaml` or pass via `--substitutions`:

- `_GCS_BUCKET_NAME` - Your GCS bucket name
- `_BACKEND_API_URL` - Your backend service URL
- `_BACKEND_AUTH_SECRET` - Secret Manager path to auth token
- `_SERVICE_ACCOUNT` - Service account email (needs `roles/storage.objectAdmin`)

### Job Parameters

Configured in `cloudbuild.yaml`:

- **Tasks**: 10 parallel containers
- **Max Retries**: 3 attempts per task
- **Timeout**: 15 minutes per task
- **CPU**: 2 vCPU (sharp benefits from multi-core)
- **Memory**: 2Gi RAM

### Batch Size

Backend queues up to **50 images per job execution** (configurable in `job-queue.ts`).

## Monitoring

### View job executions

```bash
gcloud run jobs executions list --job=slideshow-processor --region=us-central1
```

### View logs

```bash
gcloud run jobs executions logs <execution-id> --region=us-central1
```

### Check task status

Each task logs:

```
🚀 Task 3/10 starting (attempt 0)
📋 Total pending images: 50
📦 Task 3 processing 5 images
🖼️  Processing abc123 (1/5)
   Attempt 1, targeting 3 devices
   📥 Downloading gs://bucket/images/originals/abc123.jpg
   ✅ Downloaded 2456789 bytes
   🎨 Extracting colors from 256px proxy...
   ✅ Extracted colors: #4A5D23, #8B7355, #D4C4B0
   📐 Resizing for Kitchen Display (1920x1080)
   ✅ Uploaded to gs://bucket/processed/Kitchen Display/abc123.jpg
   💾 Saved metadata to gs://bucket/images/metadata/abc123.json
   ✅ Submitted 3 processed images to backend
   🎉 Completed processing for all 3 devices
   ✅ Success
✨ Task 3 complete: 5 processed, 0 failed
```

## Troubleshooting

### Sharp native binding errors

The Dockerfile pre-caches dependencies in a multi-stage build. If you see binding errors:

```bash
# Rebuild with --no-cache
docker build --no-cache -t processor .
```

### API authentication failures

Verify `PROCESSOR_AUTH_TOKEN` matches backend's expected value:

```bash
# Check secret in backend
kubectl get secret processor-auth-token -o jsonpath='{.data.token}' | base64 -d
```

### GCS permission denied

Ensure service account has `roles/storage.objectAdmin`:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:image-processor@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### Out of memory errors

Increase memory allocation in `cloudbuild.yaml`:

```yaml
- '--memory=4Gi'  # Increase from 2Gi
```

## Migration from Worker Queue

The processor replaces `worker-queue.ts` in the backend:

| Old (Worker Queue)                  | New (Cloud Run Jobs)                  |
| ----------------------------------- | ------------------------------------- |
| Web Workers in backend container    | Separate Cloud Run Job                |
| 4 concurrent workers                | 10 parallel tasks                     |
| ImageMagick CLI (`magick` command)  | sharp (Node.js native module)         |
| 512Mi shared memory                 | 2Gi per task (20Gi total)             |
| Runs in web service (idle billing)  | Job-only (no idle costs)              |
| Single-instance processing          | Distributed across multiple containers|
| 128x128 cropped color proxy         | 256px longest-side preserved ratio    |

### Preserved Features

- **Google Photos API resizing**: Code preserved in `worker-queue.ts` for future use (commented)
- **Layout detection**: Moved to backend (pre-processing)
- **Color palette similarity**: Available in backend for pairing logic

## License

MIT
