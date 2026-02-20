const io = require("socket.io")(3000, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const repoState = {}; 

function ensureRepo(repoId) {
    if (!repoState[repoId]) {
        repoState[repoId] = { editing: {}, unpushed: {} };
    }
    console.log(repoId);
    return repoState[repoId];
}

io.on("connection", (socket) => {
    socket.on("join_repo", (repoId) => {
        console.log(`Joined repo ${repoId}`);
        socket.join(repoId);
        socket.emit("sync_state", ensureRepo(repoId));
    });

    socket.on("file_editing", (data) => {
        const state = ensureRepo(data.repo);
        console.log(data.file, data.user);
        state.editing[data.file] = data.user;
        socket.to(data.repo).emit("update_editing", data);
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