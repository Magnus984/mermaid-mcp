FROM node:lts-bookworm-slim

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Install Playwright with system dependencies
RUN npx playwright install --with-deps chromium

# Clean up to reduce image size
RUN apt-get clean \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/* \
    && rm -rf ~/.npm

# Expose port (adjust port number as needed)
EXPOSE 3033

# Start the application at runtime
CMD ["npm", "run", "start:unified"]