const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync } = require("child_process");

let MY_NAME = "Unknown";
try { MY_NAME = execSync("git config user.name").toString().trim(); } 
catch (e) {}

const SERVER_URL = "http://localhost:3000"; // Change if server is remote
const socket = io(SERVER_URL);

function activate(context) {
    vscode.window.showInformationMessage(`CodeSync activated as ${MY_NAME}`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const REPO_ROOT = workspaceFolders[0].uri.fsPath;
    const REPO_NAME = vscode.workspace.asRelativePath(REPO_ROOT);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(uri => {
        const relativePath = vscode.workspace.asRelativePath(uri);
        socket.emit("file_editing", {
            user: MY_NAME,
            file: `${REPO_NAME}/${relativePath.replace(/\\/g, "/")}`
        });

        checkGitReminders(REPO_ROOT);
    });

    socket.on("show_toast", data => {
        vscode.window.showWarningMessage(`${data.user} is editing ${data.file}. Avoid conflicts!`);
    });

    context.subscriptions.push(watcher);
}

function checkGitReminders(repoRoot) {
    try {
        const changedFilesOutput = execSync("git status --porcelain", { cwd: repoRoot }).toString().trim();
        const changedFiles = changedFilesOutput ? changedFilesOutput.split("\n").length : 0;

        const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();
        const unpushedCommitsOutput = execSync(`git log origin/${branch}..HEAD --oneline`, { cwd: repoRoot }).toString().trim();
        const unpushedCommits = unpushedCommitsOutput ? unpushedCommitsOutput.split("\n").length : 0;

        if (changedFiles > 5) vscode.window.showWarningMessage(`You have ${changedFiles} modified files. Consider committing!`);
        if (unpushedCommits > 3) vscode.window.showWarningMessage(`You have ${unpushedCommits} unpushed commits. Consider pushing!`);
    } catch (e) {
        console.warn("Git check failed:", e.message);
    }
}

function deactivate() {
    socket.disconnect();
}

module.exports = { activate, deactivate };