# Apify base image with Node + Playwright + Chromium preinstalled.
FROM apify/actor-node-playwright-chrome:20

# Install dependencies (production only). package*.json copied first for caching.
COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --no-optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --all || true)

# Copy the rest of the source.
COPY --chown=myuser:myuser . ./

CMD ["npm", "start", "--silent"]
