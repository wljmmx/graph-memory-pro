# Graph Memory Pro — 开发/测试镜像
#
# 用途：本地或 CI 环境一键启动 Neo4j + 本插件，用于集成测试与 benchmark。
# 本插件作为 OpenClaw 宿主的 plugin 运行，生产部署请直接在 OpenClaw 镜像中安装本包。
#
# 构建：
#   docker build -t graph-memory-pro:dev .
# 运行：
#   docker run -p 7687:7687 -p 7800:7800 -e GM_NEO4J_PASSWORD=yourpass graph-memory-pro:dev
# 评测：
#   docker exec -it <cid> npm run benchmark -- --max-cases=10

FROM node:20-alpine

# 安装 Neo4j 5.x（alpine 兼容性有限，CI 场景建议用外置 Neo4j 容器）
# 此处仅安装 JDK 17 供 Neo4j 嵌入版使用；生产推荐 docker-compose 编排独立 Neo4j 容器
RUN apk add --no-cache openjdk17-jdk bash curl \
    && addgroup -S neo4j && adduser -S -G neo4j -h /var/lib/neo4j neo4j

WORKDIR /app

# 先复制 package 元数据以利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional || npm install

# 复制源码
COPY . .

# 构建
RUN npm run build

# 默认环境变量
ENV GM_NEO4J_URI=bolt://localhost:7687 \
    GM_NEO4J_USER=neo4j \
    GM_NEO4J_PASSWORD=neo4j \
    NODE_ENV=production

# 暴露 MCP 端口（Neo4j 由外部容器提供时通常不在此镜像内暴露）
EXPOSE 7800

# 默认入口：等待 Neo4j 后运行测试
CMD ["sh", "-c", "npm test"]
