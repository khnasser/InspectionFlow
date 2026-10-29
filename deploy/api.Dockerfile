# InspectionFlow API image
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine packages/engine
COPY packages/sync-client packages/sync-client
COPY apps/api apps/api
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspaces --include-workspace-root \
 && npm run build -w @inspectionflow/engine \
 && npm run build -w @inspectionflow/api \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/engine packages/engine
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY db db
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
