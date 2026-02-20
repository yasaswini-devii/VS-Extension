const io = require("socket.io")(3000, {
    cors: {
        origin: "*", // This allows VS Code to connect
        methods: ["GET", "POST"]
    }
});

console.log("--- CodeSync Server Started ---");
console.log("Listening on port: 3000");

io.on("connection", (socket) => {
    // This MUST log as soon as the extension starts
    console.log(`NEW CONNECTION: ${socket.id}`);

    socket.on("join_repo", (repoId) => {
        socket.join(repoId);
        console.log(`User joined Repo Room: ${repoId}`);
    });

    socket.on("file_editing", (data) => {
        socket.to(data.repo).emit("show_toast", data);
    });

    socket.on("disconnect", () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});