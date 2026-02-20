const vscode = require("vscode");
const io = require("socket.io-client");
const { execSync } = require("child_process");

// 1. CHANGE THIS to your machine's IP (Find it using 'hostname -I' on Linux)
const SERVER_URL = "http://172.16.26.182:3000"; 
const socket = io(SERVER_URL, { transports: ['websocket'] });

let MY_NAME = "Unknown";
try { 
    MY_NAME = execSync("git config user.name").toString().trim(); 
} catch (e) {
    MY_NAME = "User-" + Math.floor(Math.random() * 1000);
}

function getRemoteUrl(repoRoot) {
    try {
        return execSync("git config --get remote.origin.url", { cwd: repoRoot }).toString().trim();
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
            console.log(ROOM_ID);
            socket.emit("join_repo", ROOM_ID);
        }
    });

    socket.on("connect_error", (err) => {
        console.error("Connection Failed:", err.message);
    });

    socket.on("show_toast", (data) => {
        if (data.user !== MY_NAME) {
            vscode.window.showWarningMessage(`⚠️ ${data.user} is editing ${data.file}`);
        }
    });

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
        checkGitReminders(workspaceFolders[0].uri.fsPath);
        }, 1000);         
    });
    

    context.subscriptions.push(watcher);
}

function checkGitReminders(repoRoot) {
    try {
        // Use --porcelain to get a script-friendly output
        const output = execSync("git status --porcelain", { 
            cwd: repoRoot,
            encoding: 'utf8' // Ensures output is a string, not a Buffer
        }).trim();

        const changedFiles = output ? output.split("\n").length : 0;
        console.log(`Checking Git: Found ${changedFiles} changes in ${repoRoot}`);

        if (changedFiles > 5) {
            vscode.window.showInformationMessage(`TeamWatcher: You have ${changedFiles} uncommitted changes! Consider a commit.`);
        }
    } catch (e) {
        console.error("Git Reminder Error:", e.message);
    }
}

function deactivate() { 
    if(socket) socket.disconnect(); 
}

module.exports = { activate, deactivate };