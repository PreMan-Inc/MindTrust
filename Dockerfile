FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY tests ./tests
COPY sdk ./sdk
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production MINDTRUST_HOST=0.0.0.0 PORT=4310 MINDTRUST_DB=/app/data/mindtrust.sqlite MINDTRUST_SEED=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p data && chown node:node data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
USER node
EXPOSE 4310
CMD ["npm", "start"]
