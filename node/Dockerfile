# Brain Node agent. Mock mode needs nothing else; vLLM mode needs the NVIDIA container toolkit on
# the host and the Docker socket mounted so the agent can launch the pinned vLLM image.
FROM node:22-alpine
WORKDIR /app/node
COPY node/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY node/ ./
ENV BRAIN_NODE_HOME=/data
VOLUME ["/data"]
CMD ["npx", "tsx", "src/main.ts"]
