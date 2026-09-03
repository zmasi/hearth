FROM node:22-alpine
WORKDIR /app
COPY server.mjs package.json ./
ENV PORT=8787
ENV HEARTH_DATA=/data/hearth.json
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server.mjs"]
