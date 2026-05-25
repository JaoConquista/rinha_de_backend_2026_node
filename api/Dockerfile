FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
#COPY resources ./resources

ENV PORT=3000
ENV RESOURCES_DIR=/app/resources
ENV CACHE_DIR=/app/api/cache

EXPOSE 3000

CMD ["node", "src/index.js"]
