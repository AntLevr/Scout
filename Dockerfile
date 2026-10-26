FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码与静态资源
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
