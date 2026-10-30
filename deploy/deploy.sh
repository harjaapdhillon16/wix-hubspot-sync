#!/bin/bash
# Compile locally, ship the bundle + config to the VM, build the runtime image there, restart.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=kosh-512621 ZONE=us-central1-a VM=wix-hubspot-vm
npm run build >/dev/null
tar czf /tmp/wix-hubspot-bundle.tgz package.json package-lock.json dist public -C deploy Dockerfile.runtime docker-compose.yml Caddyfile public.env secrets.env
gcloud compute scp --quiet --project=$PROJECT --zone=$ZONE /tmp/wix-hubspot-bundle.tgz $VM:/tmp/
rm -f /tmp/wix-hubspot-bundle.tgz
gcloud compute ssh $VM --quiet --project=$PROJECT --zone=$ZONE --command='set -e
sudo mkdir -p /opt/wix-hubspot/build /opt/wix-hubspot/data && sudo chown -R 1000:1000 /opt/wix-hubspot/data
sudo rm -rf /opt/wix-hubspot/build/* && sudo tar xzf /tmp/wix-hubspot-bundle.tgz -C /opt/wix-hubspot/build && rm /tmp/wix-hubspot-bundle.tgz
cd /opt/wix-hubspot && sudo mv build/docker-compose.yml build/Caddyfile build/public.env build/secrets.env . && sudo chmod 600 secrets.env
sudo docker build -q -f build/Dockerfile.runtime -t wix-hubspot-sync:latest build
sudo docker compose up -d --remove-orphans && sudo docker compose ps --format "table {{.Service}}\t{{.Status}}"'
