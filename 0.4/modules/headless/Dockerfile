ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS runtime
USER root
ENV NODE_ENV=production \
    QQ_AGENT_HOST=0.0.0.0 \
    QQ_AGENT_PORT=3210 \
    QQ_AGENT_DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir -p data plugins skills \
    && chown -R node:node /app
COPY --chown=node:node src ./src
COPY --chown=node:node ui ./ui
COPY --chown=node:node modules/headless ./modules/headless
USER node
EXPOSE 3210
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "modules/headless/server.js"]

FROM runtime AS test
ENV NODE_ENV=test
COPY --chown=node:node test/headless-transport.test.mjs test/headless-runtime.test.mjs ./test/
CMD ["node", "--test", "test/headless-transport.test.mjs", "test/headless-runtime.test.mjs"]
