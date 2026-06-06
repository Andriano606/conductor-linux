#!/usr/bin/env bash
# Example archive script. Runs before the worktree is removed. Clean up any
# resources that live outside the workspace directory (containers, db, etc).
echo "Archiving workspace $CONDUCTOR_WORKSPACE_NAME"
# e.g. docker compose down, drop a scratch database, etc.
