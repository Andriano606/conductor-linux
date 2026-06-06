#!/usr/bin/env bash
# Example run script. Triggered by the Run button. Use $CONDUCTOR_PORT so
# multiple workspaces can run side by side.
set -e
echo "Running workspace $CONDUCTOR_WORKSPACE_NAME on port $CONDUCTOR_PORT"
# e.g. start a dev server bound to the workspace port:
#   npm run dev -- --port "$CONDUCTOR_PORT"
