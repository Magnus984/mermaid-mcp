# Build stage
FROM node:lts-bookworm-slim AS build

WORKDIR /app

# Install deps for building without running lifecycle scripts (avoids husky/prepare)
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --ignore-scripts

# Copy source and build TypeScript
COPY . .

RUN npm run build

# Runtime stage
FROM node:lts-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Ensure husky and other prepare hooks are disabled in runtime install
ENV HUSKY=0

# Install only production deps, skipping lifecycle scripts
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# Install Playwright Chromium with system dependencies
RUN npx --yes playwright install --with-deps chromium

# Copy built artifacts
COPY --from=build /app/build ./build

EXPOSE 3033

CMD ["npm", "run", "start:streamable"]