FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依赖安装纳入镜像构建
COPY package*.json ./
RUN npm install --omit=dev

# 应用代码
COPY server.js ./
COPY public ./public

# 数据目录（方案 JSON 持久化，可挂载卷），并交由非 root 用户运行
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=3000
EXPOSE 3000

# 启动即完成初始化（数据目录/文件不存在会自动创建）并拉起服务
CMD ["node", "server.js"]
