# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Copy source and config
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript to JS
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy built files and node_modules (only production if needed, but keeping it simple)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Environment variable for port
ENV PORT=8888

EXPOSE 8888

CMD ["node", "dist/index.js"]
