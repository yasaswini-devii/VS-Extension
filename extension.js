const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync } = require("child_process");

const SERVER_URL = "http://172.16.26.182:3000";
const EDIT_DEBOUNCE_MS = 800; // reduce chatty emits per file
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
        
        // Icon for Active Editing
        if (this.editingFiles.has(relPath)) {
            return {
                badge: "📝",
                tooltip: `${this.editingFiles.get(relPath)} is editing now`,
                color: new vscode.ThemeColor("charts.yellow")
            };
        }

        // Icon for Unpushed Changes
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
        if (data.user === MY_NAME) return; // already rendered locally
        decoProvider.editingFiles.set(data.file, data.user);
        decoProvider.refresh();
        // Clear after 10s of inactivity
        setTimeout(() => {
            decoProvider.editingFiles.delete(data.file);
            decoProvider.refresh();
        }, 10000);
    });

    socket.on("update_unpushed", (unpushedObj) => {
        decoProvider.unpushedFiles = new Map(Object.entries(unpushedObj));
        decoProvider.refresh();
    });

    // 🔹 File edit watcher
    const watcher = vscode.workspace.onDidChangeTextDocument(event => {
        const relativePath = vscode.workspace.asRelativePath(event.document.uri);
        // Update local decorations immediately so the author also sees the badge.
        decoProvider.editingFiles.set(relativePath, MY_NAME);
        decoProvider.refresh();
        setTimeout(() => {
            decoProvider.editingFiles.delete(relativePath);
            decoProvider.refresh();
        }, 10000);

        // Debounce edit pings to avoid spamming the server per keystroke.
        if (editDebounceTimers.has(relativePath)) {
            clearTimeout(editDebounceTimers.get(relativePath));
        }
        editDebounceTimers.set(relativePath, setTimeout(() => {
            socket.emit("file_editing", {
                user: MY_NAME,
                repo: getRepoId(),
                file: relativePath
            });
            editDebounceTimers.delete(relativePath);
        }, EDIT_DEBOUNCE_MS));
        
        // Bring back your reminder check!
        checkGitReminders();
    });

    // Periodic Git check (every 10s)
    setInterval(() => checkGitStatus(), 10000);

    context.subscriptions.push(watcher);
}

// 🔹 Your original reminder logic restored
function checkGitReminders() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const repoRoot = workspaceFolders[0].uri.fsPath;

    try {
        const output = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
        const changedFiles = output ? output.split("\n").length : 0;

        if (changedFiles > 5) {
            vscode.window.showWarningMessage(`TeamWatcher: You have ${changedFiles} uncommitted changes! Consider committing.`);
        }
    } catch (e) { console.error("Git Reminder Error:", e.message); }
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
    try {
        // Detect local files ahead of origin
        const unpushedFiles = execSync("git diff --name-only @{u} HEAD", { cwd: root })
            .toString().trim().split("\n").filter(Boolean);
        
        if (unpushedFiles.length > 0) {
            socket.emit("file_committed", { repo: repoId, files: unpushedFiles, user: MY_NAME });
            // Also reflect locally so the author sees their own unpushed badge.
            decoProvider.unpushedFiles = new Map(
                unpushedFiles.map(f => [f, [MY_NAME]])
            );
            decoProvider.refresh();
        } else {
            socket.emit("repo_pushed", repoId);
            if (decoProvider.unpushedFiles.size > 0) {
                decoProvider.unpushedFiles.clear();
                decoProvider.refresh();
            }
        }
    } catch (e) { /* No upstream set yet */ }
}

function deactivate() { if (socket) socket.disconnect(); }

module.exports = { activate, deactivate };