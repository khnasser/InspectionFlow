# InspectionFlow back-office web (static build served by nginx)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine packages/engine
COPY apps/web apps/web
COPY apps/api/package.json apps/api/package.json
COPY packages/sync-client/package.json packages/sync-client/package.json
RUN npm ci --workspaces --include-workspace-root && npm run build -w @inspectionflow/web

FROM nginx:1.27-alpine
ENV API_UPSTREAM=http://api:3000
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
