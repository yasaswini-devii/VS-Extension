const vscode = require("vscode");
const { io } = require("socket.io-client");
const { execSync, exec } = require("child_process"); // Added exec for async
const fs = require("fs");
const path = require("path");

const SERVER_URL = "http://172.16.26.182:3000";
const EDIT_DEBOUNCE_MS = 1000; // Increased slightly for "calmer" UI
const COMMIT_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "build", "chore", "ci"];
let socket;
let MY_NAME = "Unknown";
let MY_EMAIL = "unknown@mail.com"; // 🔹 Standardized variable
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
        MY_EMAIL = execSync("git config user.email").toString().trim();
    } catch (e) { 
        MY_NAME = "User-" + Math.floor(Math.random() * 100);
        MY_EMAIL = "unknown@mail.com";
    }

    socket = io(SERVER_URL, { transports: ["websocket"] });
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decoProvider));

    const commitWithAiSuggestionCommand = vscode.commands.registerCommand("extension.commitWithAiSuggestion", async () => {
        await commitWithAiSuggestion();
    });

    const startMonitoringCommand = vscode.commands.registerCommand("extension.startMonitoring", async () => {
        checkGitStatus();
        vscode.window.showInformationMessage("TeamWatcher monitoring is active for this repository.");
    });

    context.subscriptions.push(commitWithAiSuggestionCommand, startMonitoringCommand);

    socket.on("connect", () => {
        vscode.window.showInformationMessage("Connected to CodeSync Server!");
        // 🔹 Send both Repo ID and Email
        socket.emit("join_repo", { 
            repoId: getRepoId(), 
            email: MY_EMAIL 
        });
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
        if (editDebounceTimers.has(relativePath)) clearTimeout(editDebounceTimers.get(relativePath));

        const timer = setTimeout(() => {
            socket.emit("file_editing", {
                userEmail: MY_EMAIL, // 🔹 Send email
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

function runGit(repoRoot, args) {
    return execSync(`git ${args}`, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
    }).trim();
}

function getRepoRoot() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return null;
    const folderPath = workspaceFolders[0].uri.fsPath;
    try {
        return runGit(folderPath, "rev-parse --show-toplevel");
    } catch {
        return null;
    }
}

function resolveGitPath(repoRoot, gitRelativeOrAbsolutePath) {
    if (!gitRelativeOrAbsolutePath) return null;
    if (path.isAbsolute(gitRelativeOrAbsolutePath)) return gitRelativeOrAbsolutePath;
    return path.join(repoRoot, gitRelativeOrAbsolutePath);
}

function disableBrokenLegacyPrepareCommitHook(repoRoot) {
    let gitDir;
    try {
        gitDir = runGit(repoRoot, "rev-parse --git-dir");
    } catch {
        return { changed: false };
    }

    const resolvedGitDir = resolveGitPath(repoRoot, gitDir);
    if (!resolvedGitDir) return { changed: false };

    const hookPath = path.join(resolvedGitDir, "hooks", "prepare-commit-msg");
    if (!fs.existsSync(hookPath)) return { changed: false };

    let hookContent = "";
    try {
        hookContent = fs.readFileSync(hookPath, "utf8");
    } catch {
        return { changed: false };
    }

    if (!hookContent.includes("aiCommit.js")) {
        return { changed: false };
    }

    const referencedPaths = [...hookContent.matchAll(/[A-Za-z]:\\[^\"'\n\r]*aiCommit\.js/g)].map(match => match[0]);
    const hasMissingReferencedScript = referencedPaths.length > 0 && referencedPaths.some(candidatePath => !fs.existsSync(candidatePath));

    if (!hasMissingReferencedScript) {
        return { changed: false };
    }

    const backupPath = `${hookPath}.teamwatcher.bak`;
    try {
        fs.copyFileSync(hookPath, backupPath);
        fs.unlinkSync(hookPath);
        return { changed: true, backupPath };
    } catch {
        return { changed: false };
    }
}

function escapeForCommitMessage(message) {
    return message.replace(/"/g, '\\"');
}

function parseNameStatus(nameStatusOutput) {
    return nameStatusOutput
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split(/\s+/);
            const status = parts[0];
            const filePath = parts[parts.length - 1];
            return { status, filePath };
        });
}

function detectScope(entries) {
    if (!entries.length) return "repo";
    const topLevels = entries
        .map(entry => entry.filePath.split("/")[0])
        .filter(Boolean);
    const uniqueTopLevels = [...new Set(topLevels)];
    if (uniqueTopLevels.length === 1) {
        return uniqueTopLevels[0].replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
    }
    const firstFile = entries[0].filePath;
    const baseName = firstFile.split("/").pop() || "repo";
    return baseName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

function detectType(entries, diffText) {
    if (!entries.length) return "chore";

    const files = entries.map(entry => entry.filePath.toLowerCase());
    const onlyDocs = files.every(file => file.includes("readme") || file.endsWith(".md") || file.startsWith("docs/"));
    if (onlyDocs) return "docs";

    const onlyTests = files.every(file => file.includes("test") || file.includes("spec"));
    if (onlyTests) return "test";

    const onlyBuildFiles = files.every(file =>
        file.includes("package.json") ||
        file.includes("package-lock.json") ||
        file.includes("eslint") ||
        file.includes("tsconfig") ||
        file.includes("vite.config") ||
        file.includes("webpack") ||
        file.includes(".github/")
    );
    if (onlyBuildFiles) return "build";

    const lowerDiff = diffText.toLowerCase();
    if (/\b(fix|bug|error|prevent|handle|fallback|null|undefined|crash)\b/.test(lowerDiff)) return "fix";
    if (/\b(refactor|cleanup|rename|extract|simplify)\b/.test(lowerDiff)) return "refactor";
    if (/\b(optimize|performance|cache|memoize|faster|latency)\b/.test(lowerDiff)) return "perf";

    const hasAdded = entries.some(entry => entry.status.startsWith("A"));
    if (hasAdded) return "feat";
    return "chore";
}

function buildSubject(type, scope, entries) {
    if (!entries.length) return `update ${scope} changes`;
    const statuses = new Set(entries.map(entry => entry.status[0]));
    const firstFile = entries[0].filePath;
    const normalizedName = (firstFile.split("/").pop() || scope)
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]+/g, " ")
        .toLowerCase();

    if (statuses.size === 1 && statuses.has("A")) {
        return `add ${normalizedName} implementation`;
    }
    if (statuses.size === 1 && statuses.has("D")) {
        return `remove ${normalizedName} implementation`;
    }
    if (type === "fix") {
        return `resolve ${normalizedName} behavior issues`;
    }
    if (type === "docs") {
        return `update ${normalizedName} documentation`;
    }
    if (type === "test") {
        return `add coverage for ${normalizedName}`;
    }
    if (type === "build") {
        return `update ${normalizedName} build configuration`;
    }
    if (type === "feat") {
        return `add ${normalizedName} support`;
    }
    return `update ${scope} implementation`;
}

function isConventionalCommit(message) {
    const trimmed = message.trim();
    if (!trimmed) return false;
    if (trimmed.length > 72) return false;
    const pattern = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9-./]+\\))?: [a-z][^A-Z]*$`);
    return pattern.test(trimmed);
}

async function ensureStagedChanges(repoRoot) {
    const staged = runGit(repoRoot, "diff --cached --name-status");
    if (staged) return true;

    let unstaged = "";
    try {
        unstaged = runGit(repoRoot, "status --porcelain");
    } catch {
        unstaged = "";
    }

    if (!unstaged) return false;

    const choice = await vscode.window.showQuickPick(
        [
            { label: "Stage all changes and continue", value: "stage" },
            { label: "Cancel", value: "cancel" }
        ],
        { placeHolder: "No staged changes found. What should TeamWatcher do?" }
    );

    if (!choice || choice.value !== "stage") return false;
    runGit(repoRoot, "add -A");
    return true;
}

async function commitWithAiSuggestion() {
    const repoRoot = getRepoRoot();
    if (!repoRoot) {
        vscode.window.showErrorMessage("TeamWatcher: Open a Git repository workspace to use AI commit suggestions.");
        return;
    }

    let hasStagedChanges;
    try {
        hasStagedChanges = await ensureStagedChanges(repoRoot);
    } catch (error) {
        vscode.window.showErrorMessage(`TeamWatcher: Failed to inspect changes. ${error.message}`);
        return;
    }

    if (!hasStagedChanges) {
        vscode.window.showWarningMessage("TeamWatcher: No changes available to commit.");
        return;
    }

    const hookRepairResult = disableBrokenLegacyPrepareCommitHook(repoRoot);
    if (hookRepairResult.changed) {
        vscode.window.showWarningMessage(
            `TeamWatcher: Disabled broken legacy prepare-commit-msg hook (backup: ${hookRepairResult.backupPath}).`
        );
    }

    let entries = [];
    let diffText = "";

    try {
        const nameStatus = runGit(repoRoot, "diff --cached --name-status");
        entries = parseNameStatus(nameStatus);
        diffText = runGit(repoRoot, "diff --cached --unified=0 --no-color");
    } catch (error) {
        vscode.window.showErrorMessage(`TeamWatcher: Unable to analyze staged diff. ${error.message}`);
        return;
    }

    const type = detectType(entries, diffText);
    const scope = detectScope(entries);
    const subject = buildSubject(type, scope, entries);
    const suggestion = `${type}(${scope}): ${subject}`;

    const finalMessage = await vscode.window.showInputBox({
        title: "Commit Using AI Suggestion",
        prompt: "Use format: type(scope): short, lowercase summary",
        value: suggestion,
        ignoreFocusOut: true,
        validateInput: value => {
            if (!value || !value.trim()) return "Commit message is required.";
            if (value.trim().length > 72) return "Keep the subject line at 72 characters or less.";
            if (!isConventionalCommit(value.trim())) {
                return "Expected format: feat(scope): concise lowercase summary";
            }
            return null;
        }
    });

    if (!finalMessage) {
        vscode.window.showInformationMessage("TeamWatcher: Commit cancelled.");
        return;
    }

    try {
        runGit(repoRoot, `commit -m "${escapeForCommitMessage(finalMessage.trim())}"`);
        vscode.window.showInformationMessage(`Committed: ${finalMessage.trim()}`);
    } catch (error) {
        vscode.window.showErrorMessage(`TeamWatcher: Commit failed. ${error.message}`);
    }
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