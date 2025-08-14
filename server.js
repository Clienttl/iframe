const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map(); // username -> socketId
const friendRequests = {}; // username -> [pending usernames]
const friends = {}; // username -> [friend usernames]
const messages = {}; // friend pair key -> array of messages
const bannedUsers = new Set();

io.on('connection', (socket) => {
    let username = null;
    let isAdmin = false;

    socket.on('set username', ({ name, code }, callback) => {
        name = name.trim();
        if (!name) return callback({ success: false, message: 'Username required' });
        if (onlineUsers.has(name) || bannedUsers.has(name)) {
            return callback({ success: false, message: 'Username taken or banned' });
        }

        username = name;
        isAdmin = (code === '13854');
        onlineUsers.set(username, socket.id);
        friendRequests[username] = friendRequests[username] || [];
        friends[username] = friends[username] || [];

        if (isAdmin) {
            socket.emit('admin granted', { onlineUsers: Array.from(onlineUsers.keys()), messages });
        }

        friends[username].forEach(f => {
            if (onlineUsers.has(f)) {
                io.to(onlineUsers.get(f)).emit('friend online', username);
            }
        });

        callback({ success: true, friends: friends[username], requests: friendRequests[username], isAdmin });
    });

    socket.on('send friend request', (target) => {
        if (!username || !target || target === username) return;
        if (!onlineUsers.has(target)) return;
        friendRequests[target] = friendRequests[target] || [];
        if (!friendRequests[target].includes(username) && !friends[target]?.includes(username)) {
            friendRequests[target].push(username);
            io.to(onlineUsers.get(target)).emit('friend request', username);
        }
    });

    socket.on('respond friend request', ({ from, accepted }) => {
        if (!username || !from) return;
        friendRequests[username] = (friendRequests[username] || []).filter(u => u !== from);

        if (accepted) {
            friends[username].push(from);
            friends[from].push(username);

            if (onlineUsers.has(from)) {
                io.to(onlineUsers.get(from)).emit('friend accepted', username);
                io.to(socket.id).emit('friend accepted', from);
            }
        } else {
            if (onlineUsers.has(from)) {
                io.to(onlineUsers.get(from)).emit('friend declined', username);
            }
        }
        io.to(socket.id).emit('friend requests', friendRequests[username]);
    });

    socket.on('private message', ({ to, text }) => {
        if (!username || !friends[username]?.includes(to)) return;
        const msg = { from: username, text, time: new Date().toLocaleTimeString() };

        const key = [username, to].sort().join('|');
        messages[key] = messages[key] || [];
        messages[key].push(msg);

        if (onlineUsers.has(to)) io.to(onlineUsers.get(to)).emit('private message', msg);
        io.to(socket.id).emit('private message', msg);

        if (isAdmin) {
            socket.emit('admin message log', messages);
        }
    });

    socket.on('admin ban', (target) => {
        if (!isAdmin || !target) return;
        bannedUsers.add(target);
        if (onlineUsers.has(target)) {
            io.to(onlineUsers.get(target)).disconnectSockets(true);
            onlineUsers.delete(target);
        }
    });

    socket.on('disconnect', () => {
        if (username) {
            onlineUsers.delete(username);
            friends[username].forEach(f => {
                if (onlineUsers.has(f)) {
                    io.to(onlineUsers.get(f)).emit('friend offline', username);
                }
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
