# Multi-stage build for efficient caching
FROM denoland/deno:2.6.4 AS deps

WORKDIR /app

# Copy package files and lock file
COPY deno.json deno.lock ./

# Enable node_modules directory for npm packages (sharp needs native bindings)
ENV DENO_NODE_MODULES_DIR=auto

# Pre-cache dependencies including source files for proper resolution
COPY main.ts processor.ts ./

# Cache dependencies with lock file
RUN deno cache --frozen main.ts processor.ts

# Final stage
FROM denoland/deno:2.6.4

WORKDIR /app

# Copy cached dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /deno-dir /deno-dir

# Enable node_modules directory
ENV DENO_NODE_MODULES_DIR=auto
ENV DENO_DIR=/deno-dir

# Copy source files
COPY deno.json deno.lock ./
COPY main.ts ./
COPY processor.ts ./

# Set production environment
ENV DENO_ENV=production

# Run the job
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "main.ts"]
