#!/usr/bin/env bash
# Example setup script. Runs once when a workspace is created, inside the
# worktree directory ($CONDUCTOR_WORKSPACE_PATH).
set -e
echo "Setting up workspace: $CONDUCTOR_WORKSPACE_NAME"
echo "  worktree: $CONDUCTOR_WORKSPACE_PATH"
echo "  repo root: $CONDUCTOR_ROOT_PATH"
echo "  port: $CONDUCTOR_PORT"
# e.g. copy env files, install deps:
#   cp "$CONDUCTOR_ROOT_PATH/.env" .
#   npm install
touch .setup-done
echo "Setup complete."
