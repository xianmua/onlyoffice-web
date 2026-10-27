# 多阶段构建 - 前端构建 + OnlyOffice 一体化镜像

# 阶段 1: 构建前端
FROM node:18-alpine AS frontend-builder

WORKDIR /app

# 复制前端文件
COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# 阶段 2: OnlyOffice 运行时（版本锁定 9.4.0：DS 升级可能破坏 web-apps 补丁锚点与插件行为，勿随意变更）
FROM onlyoffice/documentserver:9.4.0

# 前端产物 + 项目根 plugins/（Docker 无 node 后端，App.vue 走内置 fallback 列表）
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY plugins /usr/share/nginx/html/plugins

# 添加前端 Nginx 配置（监听 8090，不影响 OnlyOffice 的 80）
RUN echo 'server { \n\
    listen 8090; \n\
    server_name localhost; \n\
    root /usr/share/nginx/html; \n\
    index index.html; \n\
    location /plugins/ { \n\
        add_header Cache-Control "no-store"; \n\
        try_files $uri $uri/ =404; \n\
    } \n\
    location / { \n\
        try_files $uri $uri/ /index.html; \n\
    } \n\
}' > /etc/nginx/conf.d/frontend.conf

# 禁用 JWT
ENV JWT_ENABLED=false

# DS 补丁与插件清理脚本（容器首次启动时自动执行，均幂等）
COPY scripts /app/scripts
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh /app/scripts/*.sh

# 暴露端口：8090=前端，80=OnlyOffice（映射到 8089）
EXPOSE 8090 80

CMD ["/app/docker-entrypoint.sh"]
