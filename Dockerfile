FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV REPOLENS_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["npx", "tsx", "src/cli.ts", "serve"]
