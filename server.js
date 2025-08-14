const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map();
const messages = [];
const typingUsers = new Set();
const friendRequests = {};
const friends = {};

io.on('connection', (socket) => {
    let username = null;

    socket.on('set username', (name, callback) => {
        name = name.trim();
        if (!name) return callback({ success: false, message: 'Username cannot be empty' });
        if (onlineUsers.has(name)) return callback({ success: false, message: 'Username is taken' });
        username = name;
        onlineUsers.set(username, socket.id);
        friendRequests[username] = friendRequests[username] || [];
        friends[username] = friends[username] || [];
        io.emit('user list', Array.from(onlineUsers.keys()));
        callback({ success: true, messages });
    });

    socket.on('chat message', (msg) => {
        if (!username) return;
        const messageObj = { username, text: msg, time: new Date().toLocaleTimeString() };
        messages.push(messageObj);
        if (messages.length > 200) messages.shift();
        io.emit('chat message', messageObj);
    });

    socket.on('typing', (isTyping) => {
        if (!username) return;
        if (isTyping) typingUsers.add(username);
        else typingUsers.delete(username);
        io.emit('typing users', Array.from(typingUsers));
    });

    socket.on('send friend request', (target) => {
        if (!username || !onlineUsers.has(target) || target === username) return;
        friendRequests[target] = friendRequests[target] || [];
        if (!friendRequests[target].includes(username) && !friends[target]?.includes(username)) {
            friendRequests[target].push(username);
            io.to(onlineUsers.get(target)).emit('friend request', username);
        }
    });

    socket.on('accept friend request', (from) => {
        if (!username) return;
        friendRequests[username] = (friendRequests[username] || []).filter(u => u !== from);
        friends[username].push(from);
        friends[from].push(username);
        io.to(onlineUsers.get(from)).emit('friend accepted', username);
    });

    socket.on('private message', ({ to, text }) => {
        if (!username || !friends[username]?.includes(to)) return;
        const pm = { from: username, text, time: new Date().toLocaleTimeString() };
        io.to(onlineUsers.get(to)).emit('private message', pm);
        io.to(socket.id).emit('private message', pm);
    });

    socket.on('disconnect', () => {
        if (username) {
            onlineUsers.delete(username);
            typingUsers.delete(username);
            io.emit('user list', Array.from(onlineUsers.keys()));
            io.emit('typing users', Array.from(typingUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
