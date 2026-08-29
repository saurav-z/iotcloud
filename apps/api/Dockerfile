FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace apps/api --include-workspace-root
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN npm run build --workspace apps/api
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm install --workspace apps/api --omit=dev --include-workspace-root
COPY --from=build /app/apps/api/dist apps/api/dist
ENV NODE_ENV=production
CMD ["node","apps/api/dist/server.js"]
