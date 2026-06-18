FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional --omit=dev --no-audit --no-fund

COPY src ./src

USER node

EXPOSE 3000

ENV MCP_MODE=http
ENV NODE_ENV=production

CMD ["node", "src/mcp-server.js"]
