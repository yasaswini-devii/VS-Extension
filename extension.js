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
    // Filter Editing: Remove any entries where the user is ME
    const filteredEditing = new Map();
    for (const [file, user] of Object.entries(state.editing)) {
        if (user !== MY_NAME) {
            filteredEditing.set(file, user);
        }
    }
    decoProvider.editingFiles = filteredEditing;

    // Filter Unpushed: Remove ME from the arrays
    const filteredUnpushed = Object.entries(state.unpushed).reduce((acc, [file, users]) => {
        const others = users.filter(u => u !== MY_NAME);
        if (others.length > 0) acc.push([file, others]);
        return acc;
    }, []);
    
    decoProvider.unpushedFiles = new Map(filteredUnpushed);
    decoProvider.refresh();
});

    socket.on("update_editing", (data) => {
    // 🛑 STOP: If the message is about me, ignore it immediately.
    if (data.user === MY_NAME) return;

    // Only add to the map if it's someone else
    decoProvider.editingFiles.set(data.file, data.user);
    decoProvider.refresh();

    // Auto-clear their icon after 15s of silence
    setTimeout(() => {
        if (decoProvider.editingFiles.get(data.file) === data.user) {
            decoProvider.editingFiles.delete(data.file);
            decoProvider.refresh();
        }
    }, 15000);
});

    socket.on("update_unpushed", (unpushedObj) => {
    const filtered = Object.entries(unpushedObj).reduce((acc, [file, users]) => {
        const others = users.filter(u => u !== MY_NAME);
        // Only add the file to the map if someone OTHER than you has changes
        if (others.length > 0) {
            acc.push([file, others]);
        }
        return acc;
    }, []);

    decoProvider.unpushedFiles = new Map(filtered);
    decoProvider.refresh();
});

    // 🔹 IMPROVED: Smoother Watcher
    const editWatcher = vscode.workspace.onDidChangeTextDocument(event => {
    const relativePath = vscode.workspace.asRelativePath(event.document.uri);

    if (editDebounceTimers.has(relativePath)) {
        clearTimeout(editDebounceTimers.get(relativePath));
    }

    const timer = setTimeout(() => {
        socket.emit("file_editing", {
            user: MY_NAME,
            repo: getRepoId(),
            file: relativePath
        });
        editDebounceTimers.delete(relativePath);
    }, EDIT_DEBOUNCE_MS);

    editDebounceTimers.set(relativePath, timer);
});



    // Run heavy git checks every 15s (increased from 10s for performance)
    const saveWatcher = vscode.workspace.onDidSaveTextDocument(document => {
    // Immediate check when a file is saved
    checkGitStatus();
});

context.subscriptions.push(saveWatcher, editWatcher);}

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
        
        // Inside checkGitStatus()
if (allChangedFiles.length > 0) {
    socket.emit("file_committed", { 
        repo: repoId, 
        files: allChangedFiles, 
        user: MY_NAME 
    });
} else {
    // FIX: Only tell the server to clear YOUR changes, not the whole repo
    socket.emit("user_cleared_changes", {
        repo: repoId,
        user: MY_NAME
    });
}
    });
}

function deactivate() { if (socket) socket.disconnect(); }

module.exports = { activate, deactivate };