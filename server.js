const io = require("socket.io")(3000, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const repoState = {}; 

function ensureRepo(repoId) {
    if (!repoState[repoId]) {
        repoState[repoId] = { editing: {}, unpushed: {} };
    }
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
});
console.log("Server running on port 3000");