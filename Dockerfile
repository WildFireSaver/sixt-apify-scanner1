# Apify base image with Node + Playwright + Chromium preinstalled.
FROM apify/actor-node-playwright-chrome:20

# Extra packages for the interactive "save-session" Live View (manual login):
# a virtual display, a VNC server, noVNC web client, and a minimal WM.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      openbox \
 && rm -rf /var/lib/apt/lists/*
USER myuser

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --no-optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --all || true)

COPY --chown=myuser:myuser . ./

CMD ["npm", "start", "--silent"]
