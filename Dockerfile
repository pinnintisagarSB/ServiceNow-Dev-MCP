FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY src ./src

EXPOSE 3000

ENV MCP_MODE=http
ENV MCP_PORT=3000
ENV NODE_ENV=production

CMD ["node", "src/mcp-server.js"]
