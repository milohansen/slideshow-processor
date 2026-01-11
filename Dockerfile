# Multi-stage build for efficient caching
FROM denoland/deno:2.6.4 AS deps

WORKDIR /app

# Copy package files
COPY deno.json ./

# Enable node_modules directory for npm packages (sharp needs native bindings)
ENV DENO_NODE_MODULES_DIR=auto

# Pre-cache dependencies (this will download sharp and build native bindings)
RUN deno install --entrypoint main.ts || echo "Pre-caching dependencies"

# Final stage
FROM denoland/deno:2.6.4

WORKDIR /app

# Copy cached dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /root/.cache/deno /root/.cache/deno

# Enable node_modules directory
ENV DENO_NODE_MODULES_DIR=auto

# Copy source files
COPY deno.json ./
COPY main.ts ./
COPY processor.ts ./

# Set production environment
ENV DENO_ENV=production

# Run the job
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "main.ts"]
