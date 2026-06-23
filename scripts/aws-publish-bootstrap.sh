#!/usr/bin/env bash
# aws-publish-bootstrap.sh
#
# Run ON the EC2 instance (Amazon Linux 2023) to prepare it for the
# Lee County IPFS bulk publish.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/aws-publish-bootstrap.sh | bash
#   -- OR --
#   bash scripts/aws-publish-bootstrap.sh
#
# Idempotent: safe to re-run; each step skips itself if already done.

set -euo pipefail

REPO_URL="https://github.com/soofi-xyz/elephant-query-db.git"
BRANCH="feat/bulk-ipfs-publish"
CLONE_DIR="${HOME}/elephant-query-db"
NODE_VERSION="22"

log() { echo "[bootstrap] $*"; }
err() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
log "Installing system dependencies..."
sudo dnf install -y git curl tar xz 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Node 22 via the native AL2023 package (amazon-linux-extras ships
#    nodejs22 directly — no external repo, no curl pipe, fully idempotent).
#    Verified against: https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html
# ---------------------------------------------------------------------------
if node --version 2>/dev/null | grep -q "^v${NODE_VERSION}"; then
  log "Node $(node --version) already present — skipping."
else
  log "Installing Node ${NODE_VERSION} via dnf (AL2023 native)..."
  sudo dnf install -y "nodejs${NODE_VERSION}" "nodejs${NODE_VERSION}-npm"

  # If multiple Node versions are registered, point the alternatives to v22
  if command -v alternatives &>/dev/null; then
    sudo alternatives --set node "/usr/bin/node-${NODE_VERSION}" 2>/dev/null || true
    sudo alternatives --set npm  "/usr/bin/npm-${NODE_VERSION}"  2>/dev/null || true
  fi
fi

node --version | grep -q "^v${NODE_VERSION}" \
  || err "Expected Node ${NODE_VERSION}.x but got $(node --version). Aborting."

log "Node $(node --version) / npm $(npm --version)"

# ---------------------------------------------------------------------------
# 3. Clone the repo (or pull if it already exists)
# ---------------------------------------------------------------------------
if [[ -d "${CLONE_DIR}/.git" ]]; then
  log "Repo already cloned at ${CLONE_DIR} — pulling latest..."
  git -C "${CLONE_DIR}" fetch origin
  git -C "${CLONE_DIR}" checkout "${BRANCH}"
  git -C "${CLONE_DIR}" pull --ff-only origin "${BRANCH}"
else
  log "Cloning ${REPO_URL} at branch ${BRANCH}..."
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${CLONE_DIR}"
fi

# ---------------------------------------------------------------------------
# 4. npm install
# ---------------------------------------------------------------------------
log "Running npm install..."
npm --prefix "${CLONE_DIR}" install

# ---------------------------------------------------------------------------
# 5. Verify the two publish scripts are present
# ---------------------------------------------------------------------------
for script in run-property-consolidation-export.ts upload-consolidation-to-filebase.ts; do
  [[ -f "${CLONE_DIR}/scripts/${script}" ]] \
    || err "Expected script not found: ${CLONE_DIR}/scripts/${script}"
done

log "Verified publish scripts present."

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<MSG

=====================================================================
  Bootstrap complete.
=====================================================================

  Repo  : ${CLONE_DIR}
  Branch: ${BRANCH}
  Node  : $(node --version)

  NEXT STEPS
  ----------
  1. Set the 7 required env vars (see RUNBOOK-aws.md for sources):

     export DATABASE_URL="postgresql://..."
     export S3_ACCESS_KEY_ID="..."
     export S3_SECRET_ACCESS_KEY="..."
     export S3_BUCKET="elephant-oracle-open-data"
     export S3_ENDPOINT="https://s3.filebase.io"
     export FILEBASE_API_TOKEN="..."
     export FILEBASE_IPNS_LABEL="oracle-open-data-lee"

  2. Start a tmux session so the run survives SSH disconnect:

     tmux new -s publish

  3. Inside tmux, run the export then the upload:

     cd ${CLONE_DIR}
     npm run export:property-consolidation -- --shard-size 10000 2>&1 | tee .export-\$(date +%Y%m%d-%H%M%S).log
     npm run publish:ipfs-upload 2>&1 | tee .upload-runs/publish-\$(date +%Y%m%d-%H%M%S).log

  Full instructions: ${CLONE_DIR}/RUNBOOK-aws.md
=====================================================================
MSG
