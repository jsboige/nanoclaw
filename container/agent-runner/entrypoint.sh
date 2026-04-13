#!/bin/bash
set -e

# Configure git identity if provided (bot needs to commit/push)
if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

# GH_TOKEN is auto-detected by gh CLI — primary identity.
# Multi-identity: export the list of available tokens so the agent can
# select an identity by running e.g. `GH_TOKEN=$GH_TOKEN_JSBOIGEECE gh ...`.
# Documents which vars exist without exposing the values.
cat > /home/node/.gh-identities 2>/dev/null <<EOF || true
Available GitHub identities (env vars to override GH_TOKEN):
  GH_TOKEN             - primary (jsboige)
  GH_TOKEN_JSBOIGE     - jsboige (same as primary)
  GH_TOKEN_JSBOIGEECE  - jsboigeECE
  GH_TOKEN_JSBOIGEEPITA- jsboigeEpita
  GH_TOKEN_JSBOIGEEPF  - jsboigeEPF

Usage: GH_TOKEN="\$GH_TOKEN_JSBOIGEECE" gh repo view ece-org/some-repo
EOF

# Compile agent-runner src (mounted RO from host's per-group cache)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read ContainerInput from stdin, feed to the agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
