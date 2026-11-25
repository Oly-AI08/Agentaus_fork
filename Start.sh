#!/usr/bin/env bash
# Agentaus PC companion launcher for macOS and Linux.
# Requires Node.js 22 or newer. Keep server.mjs, Start.sh and
# Agentaus.html together in one folder. Run:  ./Start.sh
set -uo pipefail

cd "$(dirname "$0")" || exit 1

if [ ! -f server.mjs ]; then
  echo
  echo "server.mjs was not found next to Start.sh."
  echo "Keep server.mjs, Start.sh and Agentaus.html together, then run ./Start.sh again."
  echo
  exit 1
fi

if [ ! -f Agentaus.html ]; then
  echo
  echo "Agentaus.html was not found next to Start.sh."
  echo "Keep server.mjs, Start.sh and Agentaus.html together, then run ./Start.sh again."
  echo
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/en/download"
  echo
  exit 1
fi

NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo
  echo "Node.js 22 or newer is required for the companion."
  echo "The version found was: $(node --version 2>/dev/null)"
  echo "Install it from https://nodejs.org/en/download, then run ./Start.sh again."
  echo
  exit 1
fi

echo
echo "============================================================"
echo " Agentaus PC Companion"
echo "============================================================"
echo
echo "This window runs the local companion service. Keep it open"
echo "while you use the Agentaus app, and press Ctrl+C to stop it."
echo
echo "Advanced options can be passed when starting this script, for"
echo "example:  ./Start.sh --port 43128 --state-dir /home/you/companion-backups"
echo

printf "%s" "Enter the website origin that may use this companion."
echo " Use the protocol and host only."
echo "For a project site such as https://YOUR-USERNAME.github.io/agentaus/"
echo "you approve https://YOUR-USERNAME.github.io"
printf "%s" "Origin (Enter for https://oly-ai08.github.io): "
IFS= read -r ORIGIN || ORIGIN=""
if [ -z "$ORIGIN" ]; then
  ORIGIN="https://oly-ai08.github.io"
fi

ROOTS=()
while :; do
  echo
  echo "Approved folders give the app access to their contents with backups and Undo."
  printf "%s" "Full folder path (Enter to finish): "
  FOLDER=""
  IFS= read -r FOLDER || break
  [ -z "$FOLDER" ] && break
  if [ ! -d "$FOLDER" ]; then
    echo "That path was not found. Type a full path such as /home/you/Documents."
    continue
  fi
  ROOTS+=("$FOLDER")
  echo "Approved: $FOLDER"
done

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo
  echo "At least one approved folder is required."
  exit 1
fi

ARGS=()
for r in "${ROOTS[@]}"; do
  ARGS+=(--root "$r")
done

echo
echo "Starting the companion..."
echo
echo "The pairing token and local app address are printed below."
echo "Keep this window open while you use the app, and press Ctrl+C to stop it."
echo
node server.mjs "$@" --origin "$ORIGIN" "${ARGS[@]}"
