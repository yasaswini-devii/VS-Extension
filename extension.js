const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync } = require("child_process");

let MY_NAME = "Unknown";
try { 
    MY_NAME = execSync("git config user.name").toString().trim(); 
} catch (e) {
    MY_NAME = process.env.USER || process.env.USERNAME || "Collaborator";
}

const SERVER_URL = "http://172.16.26.182:3000"; 
const socket = io(SERVER_URL);

// Prevents spamming the server on every single character typed
let editTimeout;

function activate(context) {
    vscode.window.showInformationMessage(`CodeSync active: Logged in as ${MY_NAME}`);

    // --- 1. LISTEN FOR OTHERS ---
    socket.on("show_toast", (data) => {
        // Person B receives this when Person A edits
        vscode.window.showWarningMessage(
            `Conflict Warning: ${data.user} is currently editing ${data.file}`
        );
    });

    // --- 2. SEND YOUR UPDATES ---
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        const fileName = vscode.workspace.asRelativePath(event.document.uri);
        
        clearTimeout(editTimeout);
        editTimeout = setTimeout(() => {
            socket.emit("file_editing", {
                user: MY_NAME,
                file: fileName
            });
            
            // Optional: Run your Git checks here
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) checkGitReminders(workspaceFolders[0].uri.fsPath);
        }, 1000); // Only sends once every second of activity
    }));

    context.subscriptions.push(watcher);
}

function checkGitReminders(repoRoot) {
    try {
        const changedFilesOutput = execSync("git status --porcelain", { cwd: repoRoot }).toString().trim();
        const changedFiles = changedFilesOutput ? changedFilesOutput.split("\n").length : 0;

        if (changedFiles > 5) {
            vscode.window.showInformationMessage(`Reminder: You have ${changedFiles} unsaved changes.`);
        }
    } catch (e) {
        // Git not initialized or not found
    }
}

function deactivate() {
    if (socket) socket.disconnect();
}

module.exports = { activate, deactivate };