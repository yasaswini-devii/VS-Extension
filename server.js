const io = require("socket.io")(3000, {
    cors: { origin: "*" } // Allows connections from VS Code
});

console.log("CodeSync Server running on port 3000...");

io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // When Person A sends an update...
    socket.on("file_editing", (data) => {
        console.log(`${data.user} is editing ${data.file}`);
        
        // ...Broadcast it to Person B (everyone else)
        socket.broadcast.emit("show_toast", data);
    });

    socket.on("disconnect", () => {
        console.log("User disconnected");
    });
});