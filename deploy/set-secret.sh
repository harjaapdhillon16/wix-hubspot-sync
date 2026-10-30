#!/bin/bash
# Prompts for secret values (hidden input) and stores them in deploy/secrets.env (mode 600, git-ignored).
# Usage: deploy/set-secret.sh NAME [NAME ...]
cd "$(dirname "$0")"
umask 077
touch secrets.env
for name in "$@"; do
  read -r -s -p "Paste $name and press Enter: " value; echo
  if [ -z "$value" ]; then echo "  skipped $name (empty)"; continue; fi
  grep -v "^$name=" secrets.env > secrets.env.tmp || true
  printf '%s=%s\n' "$name" "$value" >> secrets.env.tmp
  mv secrets.env.tmp secrets.env
  echo "  saved $name (${#value} chars)"
done
