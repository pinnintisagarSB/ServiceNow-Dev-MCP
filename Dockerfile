FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY src ./src

# Run as non-root for security
USER node

EXPOSE 3000

ENV MCP_MODE=http
ENV MCP_PORT=${PORT:-3000}
ENV NODE_ENV=production

CMD ["node", "src/mcp-server.js"]
