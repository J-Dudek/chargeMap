FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json ./
COPY server ./server
COPY public ./public
# Les sources gardent les droits du dossier copié : sur le NAS ils peuvent être trop restrictifs
# pour l'utilisateur node (EACCES). On force la lecture pour tous.
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1
CMD ["node", "server/index.js"]
