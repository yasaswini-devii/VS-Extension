const io = require("socket.io")(3000, { cors: { origin: "*" } });

console.log("Broadcast Server Active on Port 3000...");

io.on("connection", socket => {
    console.log("Client connected:", socket.id);

    socket.on("file_editing", data => {
        socket.broadcast.emit("show_toast", data);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});