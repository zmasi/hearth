FROM node:22-alpine
WORKDIR /app
COPY origin/server.mjs origin/package.json ./
ENV HEARTH_DATA=/data/hearth.json
EXPOSE 8787
CMD ["node", "server.mjs"]
