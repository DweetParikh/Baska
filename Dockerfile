# Baska backend (API + price updater + keeper) in one container. The web app is deployed on Vercel.
FROM node:22-slim
WORKDIR /srv
# Prisma's engines need OpenSSL, which the slim image doesn't ship.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The services load the IDL from target/idl (gitignored). Use the committed copy the frontend uses.
RUN mkdir -p target/idl \
 && cp app/src/generated/baska_vault.json target/idl/baska_vault.json \
 && npm run api:generate

ENV NODE_ENV=production CLUSTER=devnet
CMD ["bash", "scripts/start-cloud.sh"]
