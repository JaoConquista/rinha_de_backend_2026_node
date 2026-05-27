FROM node:20-alpine

WORKDIR /app

COPY api/package*.json ./
RUN npm install --omit=dev

COPY api/src ./src
COPY resources ./resources
COPY api/bin_data ./bin_data


ENV PORT=3000
ENV RESOURCES_DIR=/app/resources
ENV CACHE_DIR=/app/bin_data

EXPOSE 3000

CMD ["node", "src/index.js"]
