FROM --platform=linux/amd64 node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY preprocess.js .
CMD ["node", "preprocess.js"]