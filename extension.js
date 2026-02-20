const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync, exec } = require("child_process"); // Added exec for async

const SERVER_URL = "http://172.16.26.182:3000";
const EDIT_DEBOUNCE_MS = 1000; // Increased slightly for "calmer" UI
let socket;
let MY_NAME = "Unknown";
const editDebounceTimers = new Map();

class TeamDecorationProvider {
    constructor() {
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
        this.editingFiles = new Map(); 
        this.unpushedFiles = new Map(); 
    }

    refresh() {
        this._onDidChangeFileDecorations.fire();
    }

    provideFileDecoration(uri) {
        const relPath = vscode.workspace.asRelativePath(uri);
        
        if (this.editingFiles.has(relPath)) {
            return {
                badge: "📝",
                tooltip: `${this.editingFiles.get(relPath)} is editing now`,
                color: new vscode.ThemeColor("charts.yellow")
            };
        }

        if (this.unpushedFiles.has(relPath)) {
            const users = this.unpushedFiles.get(relPath);
            return {
                badge: "↑",
                tooltip: `Unpushed changes by: ${users.join(", ")}`,
                color: new vscode.ThemeColor("charts.blue")
            };
        }
        return null;
    }
}

const decoProvider = new TeamDecorationProvider();

function activate(context) {
    try {
        MY_NAME = execSync("git config user.name").toString().trim();
    } catch (e) { MY_NAME = "User-" + Math.floor(Math.random() * 100); }

    socket = io(SERVER_URL, { transports: ["websocket"] });
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decoProvider));

    socket.on("connect", () => {
        vscode.window.showInformationMessage("Connected to CodeSync Server!");
        socket.emit("join_repo", getRepoId());
    });

    socket.on("sync_state", (state) => {
        decoProvider.editingFiles = new Map(Object.entries(state.editing));
        decoProvider.unpushedFiles = new Map(Object.entries(state.unpushed));
        decoProvider.refresh();
    });

    socket.on("update_editing", (data) => {
        console.log(data.user);
        if (!(data.user === MY_NAME)) return;
        
        // Only refresh if state actually changes
        if (decoProvider.editingFiles.get(data.file) !== data.user) {
            decoProvider.editingFiles.set(data.file, data.user);
            decoProvider.refresh();
        }

        // Auto-clear remote user icon after 15s of their silence
        setTimeout(() => {
            if (decoProvider.editingFiles.get(data.file) === data.user) {
                decoProvider.editingFiles.delete(data.file);
                decoProvider.refresh();
            }
        }, 15000);
    });

    socket.on("update_unpushed", (unpushedObj) => {
        decoProvider.unpushedFiles = new Map(Object.entries(unpushedObj));
        decoProvider.refresh();
    });

    // 🔹 IMPROVED: Smoother Watcher
    const watcher = vscode.workspace.onDidChangeTextDocument(event => {
        const relativePath = vscode.workspace.asRelativePath(event.document.uri);

        // Clear existing debounce
        if (editDebounceTimers.has(relativePath)) {
            clearTimeout(editDebounceTimers.get(relativePath));
        }

        // Set a timer to update UI and Server ONLY after user stops typing
        const timer = setTimeout(() => {
            // Local Update
            if (!decoProvider.editingFiles.has(relativePath)) {
                decoProvider.editingFiles.set(relativePath, MY_NAME);
                decoProvider.refresh();
            }

            // Server Update
            socket.emit("file_editing", {
                user: MY_NAME,
                repo: getRepoId(),
                file: relativePath
            });

            // Self-cleanup
            setTimeout(() => {
                if (decoProvider.editingFiles.get(relativePath) === MY_NAME) {
                    decoProvider.editingFiles.delete(relativePath);
                    decoProvider.refresh();
                }
            }, 10000);

            // Execute the Git reminder check ONLY when typing pauses
            checkGitReminders(); 

            editDebounceTimers.delete(relativePath);
        }, EDIT_DEBOUNCE_MS);

        editDebounceTimers.set(relativePath, timer);
    });

    // Run heavy git checks every 15s (increased from 10s for performance)
    setInterval(() => checkGitStatus(), 15000);

    context.subscriptions.push(watcher);
}

// 🔹 IMPROVED: Using async exec to prevent UI "micro-freezes"
function checkGitReminders() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const repoRoot = workspaceFolders[0].uri.fsPath;

    exec("git status --porcelain", { cwd: repoRoot }, (err, stdout) => {
        if (err) return;
        const changedFiles = stdout ? stdout.trim().split("\n").length : 0;
        if (changedFiles > 5) {
            vscode.window.showWarningMessage(`TeamWatcher: You have ${changedFiles} uncommitted changes!`);
        }
    });
}

function getRepoId() {
    if (vscode.workspace.workspaceFolders) {
        try {
            return execSync("git config --get remote.origin.url", {
                cwd: vscode.workspace.workspaceFolders[0].uri.fsPath
            }).toString().trim();
        } catch (e) { return vscode.workspace.name; }
    }
    return "unknown-repo";
}

function checkGitStatus() {
    if (!vscode.workspace.workspaceFolders) return;
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const repoId = getRepoId();
    
    // This command finds:
    // 1. Unpushed commits: @{u}..HEAD
    // 2. Unstaged/Staged changes: HEAD (tracked files only)
    // 3. Untracked files: --others --exclude-standard
    const cmd = 'git diff --name-only @{u} HEAD && git ls-files -m --others --exclude-standard';

    exec(cmd, { cwd: root }, (err, stdout) => {
        // If there's an error (e.g., no upstream set), we fall back to just local changes
        let output = stdout;
        if (err) {
            try {
                output = execSync('git ls-files -m --others --exclude-standard', { cwd: root }).toString();
            } catch(e) { output = ""; }
        }

        const allChangedFiles = [...new Set(output.trim().split("\n").filter(Boolean))];
        
        if (allChangedFiles.length > 0) {
            // Tell the server: "I have these files in a 'pending' state"
            socket.emit("file_committed", { 
                repo: repoId, 
                files: allChangedFiles, 
                user: MY_NAME 
            });

            // Update local UI
            decoProvider.unpushedFiles = new Map(allChangedFiles.map(f => [f, [MY_NAME]]));
            decoProvider.refresh();
        } else {
            // No changes at all? Clear the icons.
            socket.emit("repo_pushed", repoId);
            if (decoProvider.unpushedFiles.size > 0) {
                decoProvider.unpushedFiles.clear();
                decoProvider.refresh();
            }
        }
    });
}

function deactivate() { if (socket) socket.disconnect(); }

module.exports = { activate, deactivate };