const io = require("socket.io")(3000, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const repoState = {}; 

function ensureRepo(repoId) {
    if (!repoState[repoId]) {
        repoState[repoId] = { editing: {}, unpushed: {}, presence: {} };
    }
    if (!repoState[repoId].presence) repoState[repoId].presence = {};
    return repoState[repoId];
}

io.on("connection", (socket) => {
    socket.on("join_repo", (data) => {
        // Handle if data is an object {repoId, email} or just a string
        const repoId = typeof data === 'object' ? data.repoId : data;
        const email = (data && data.email) ? data.email : "unknown-user";

        socket.join(repoId);
        socket.repoId = repoId;
        socket.email = email; // Store for disconnect logic

        const state = ensureRepo(repoId);
        
        // 🔹 Track presence by email
        state.presence[email] = {
            status: 'online',
            currentFile: 'Browsing',
            lastSeen: Date.now()
        };

        socket.emit("sync_state", state);
        io.to(repoId).emit("presence_update", state.presence);
    });

    socket.on("file_editing", (data) => {
        const state = ensureRepo(data.repo);
        console.log(data.file, data.user);
        state.editing[data.file] = data.user;
        socket.to(data.repo).emit("update_editing", data);
    });

    socket.on("disconnect", () => {
        if (socket.email && socket.repoId) {
            const state = repoState[socket.repoId];
            if (state && state.presence[socket.email]) {
                state.presence[socket.email].status = 'offline';
                state.presence[socket.email].currentFile = null;
                io.to(socket.repoId).emit("presence_update", state.presence);
            }
        }
    });

    socket.on("file_committed", (data) => {
        const state = ensureRepo(data.repo);
        data.files.forEach(file => {
            if (!state.unpushed[file]) state.unpushed[file] = [];
            if (!state.unpushed[file].includes(data.user)) state.unpushed[file].push(data.user);
            console.log(data.user, file)
        });
        socket.to(data.repo).emit("update_unpushed", state.unpushed);
    });

    socket.on("repo_pushed", (repoId) => {
        const state = ensureRepo(repoId);
        state.unpushed = {};
        io.to(repoId).emit("update_unpushed", {});
    });

    socket.on("user_cleared_changes", (data) => {
    const state = ensureRepo(data.repo);
    
    // Iterate through every file and remove this specific user
    Object.keys(state.unpushed).forEach(file => {
        state.unpushed[file] = state.unpushed[file].filter(u => u !== data.user);
        
        // Clean up the file key if no one else has changes there
        if (state.unpushed[file].length === 0) {
            delete state.unpushed[file];
        }
    });

    // Broadcast the updated (and cleaned) list to everyone
    io.to(data.repo).emit("update_unpushed", state.unpushed);
});
});
console.log("Server running on port 3000");