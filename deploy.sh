#!/bin/bash
export PATH=/usr/bin:/usr/local/bin:/bin
cd ~/webhook-test-bin
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[$(date)] Deploying $REMOTE..."
  git pull origin main --quiet
  .venv/bin/pip install -e . --quiet
  sudo systemctl restart webhook-bin
  echo "[$(date)] Done: $(git rev-parse --short HEAD)"
else
  echo "[$(date)] Up to date ($(git rev-parse --short HEAD))"
fi
