# TeamWatcher

Real-time collaboration alerts for VS Code.

## Features
- Detects when teammates are editing the same file.
- Sends conflict warnings via Socket.io.
- Reminds you to commit/push based on Git status.
- Command Palette action: `Commit Using AI Suggestion` analyzes staged diff content, proposes a Conventional Commit style message (`type(scope): summary`), validates the format, then commits.
- If an old `prepare-commit-msg` hook references a missing `aiCommit.js`, TeamWatcher auto-disables that broken hook and creates a backup before committing.

## Requirements
- A running TeamWatcher server (Node.js/Socket.io).