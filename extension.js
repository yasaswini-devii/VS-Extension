const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// 🔹 Change to your server IP
const SERVER_URL = "http://172.16.26.182:3000";
const socket = io(SERVER_URL, { transports: ["websocket"] });

let MY_NAME = "Unknown";
try {
    MY_NAME = execSync("git config user.name").toString().trim();
} catch (e) {
    MY_NAME = "User-" + Math.floor(Math.random() * 1000);
}

// 🔹 Controls popup spam (once per category per session)
let shownCategoryWarnings = new Set();

// 🔹 Prevents re-adding same ignore entry again in session
let handledIgnoreEntries = new Set();

function getRemoteUrl(repoRoot) {
    try {
        return execSync("git config --get remote.origin.url", {
            cwd: repoRoot
        }).toString().trim();
    } catch (e) {
        return null;
    }
}

function activate(context) {
    console.log("TeamWatcher extension is now active!");

    socket.on("connect", () => {
        vscode.window.showInformationMessage("Connected to CodeSync Server!");

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const ROOM_ID = getRemoteUrl(rootPath) || vscode.workspace.name;
            socket.emit("join_repo", ROOM_ID);
        }
    });

    socket.on("connect_error", (err) => {
        console.error("Connection Failed:", err.message);
    });

    socket.on("show_toast", (data) => {
        if (data.user !== MY_NAME) {
            vscode.window.showWarningMessage(
                `⚠️ ${data.user} is editing ${data.file}`
            );
        }
    });

    // 🔹 File edit watcher
    let editTimeout;
    const watcher = vscode.workspace.onDidChangeTextDocument(event => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const rootPath = workspaceFolders[0].uri.fsPath;
        const ROOM_ID = getRemoteUrl(rootPath) || vscode.workspace.name;
        const relativePath = vscode.workspace.asRelativePath(event.document.uri);

        clearTimeout(editTimeout);
        editTimeout = setTimeout(() => {
            socket.emit("file_editing", {
                user: MY_NAME,
                repo: ROOM_ID,
                file: relativePath
            });

            checkGitReminders(rootPath);
        }, 1000);
    });

    context.subscriptions.push(watcher);

    // 🔹 Periodic staged file check
    const interval = setInterval(() => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        checkStagedFiles(workspaceFolders[0].uri.fsPath);
    }, 2000);

    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function checkGitReminders(repoRoot) {
    try {
        const output = execSync("git status --porcelain", {
            cwd: repoRoot,
            encoding: "utf8"
        }).trim();

        const changedFiles = output ? output.split("\n").length : 0;

        if (changedFiles > 5) {
            vscode.window.showInformationMessage(
                `TeamWatcher: You have ${changedFiles} uncommitted changes! Consider committing.`
            );
        }
    } catch (e) {
        console.error("Git Reminder Error:", e.message);
    }
}

function checkStagedFiles(repoRoot) {
    try {
        const output = execSync("git diff --cached --name-only", {
            cwd: repoRoot,
            encoding: "utf8"
        }).trim();

        if (!output) return;

        const stagedFiles = output.split("\n");

        let foundEnv = false;
        let foundNodeModules = false;
        let foundLargeFile = false;

        const gitignorePath = path.join(repoRoot, ".gitignore");
        let gitignoreContent = "";

        if (fs.existsSync(gitignorePath)) {
            gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
        }

        const gitignoreLines = gitignoreContent
            .split("\n")
            .map(l => l.trim());

        stagedFiles.forEach(file => {

            const normalizedFile = file.replace(/\\/g, "/");
            const fullPath = path.join(repoRoot, file);

            if (!fs.existsSync(fullPath)) return;

            const fileSize = fs.statSync(fullPath).size;
            const isLarge = fileSize > 5 * 1024 * 1024;
            const isEnv = normalizedFile.endsWith(".env");
            const isNodeModules = normalizedFile.includes("node_modules/");

            let ignoreEntry = null;

            // 🔹 Handle node_modules (correct folder path)
            if (isNodeModules) {
                foundNodeModules = true;

                const parts = normalizedFile.split("/");
                const index = parts.indexOf("node_modules");
                ignoreEntry =
                    parts.slice(0, index + 1).join("/") + "/";
            }

            // 🔹 Handle .env (correct relative path)
            else if (isEnv) {
                foundEnv = true;
                ignoreEntry = normalizedFile;
            }

            // 🔹 Handle large file
            else if (isLarge) {
                foundLargeFile = true;
                ignoreEntry = normalizedFile;
            }

            else {
                return;
            }

            // 🔹 Add to .gitignore only once per session
            if (
                ignoreEntry &&
                !gitignoreLines.includes(ignoreEntry) &&
                !handledIgnoreEntries.has(ignoreEntry)
            ) {
                fs.appendFileSync(gitignorePath, `\n${ignoreEntry}\n`);
                handledIgnoreEntries.add(ignoreEntry);
            }

            // 🔹 Always unstage
            execSync(`git restore --staged "${file}"`, {
                cwd: repoRoot
            });
        });

        // 🔹 Show popup only once per category per session

        if (foundEnv && !shownCategoryWarnings.has("env")) {
            vscode.window.showErrorMessage(
                "🚨 .env file detected. Removed from staging."
            );
            shownCategoryWarnings.add("env");
        }

        if (foundNodeModules && !shownCategoryWarnings.has("node_modules")) {
            vscode.window.showErrorMessage(
                "🚨 node_modules detected. Removed from staging."
            );
            shownCategoryWarnings.add("node_modules");
        }

        if (foundLargeFile && !shownCategoryWarnings.has("large_file")) {
            vscode.window.showErrorMessage(
                "🚨 Large file (>5MB) detected. Removed from staging."
            );
            shownCategoryWarnings.add("large_file");
        }

    } catch (e) {
        console.error("Staged File Check Error:", e.message);
    }
}

function deactivate() {
    if (socket) socket.disconnect();
}

module.exports = {
    activate,
    deactivate
};