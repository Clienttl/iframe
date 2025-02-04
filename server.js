const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname + '/public'));

let players = {};
let spectators = {};

io.on('connection', (socket) => {
    socket.on('setUsername', (username) => {
        if (!Object.values(players).includes(username)) {
            players[socket.id] = { username, alive: true };
            io.emit('playerList', Object.values(players).map(p => p.username));
            checkStartGame();
        } else {
            socket.emit('usernameTaken');
        }
    });

    socket.on('playerDied', () => {
        if (players[socket.id]) {
            players[socket.id].alive = false;
            spectators[socket.id] = players[socket.id];
            delete players[socket.id];
            io.to(socket.id).emit('spectate', Object.values(players));
            checkGameOver();
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        delete spectators[socket.id];
        io.emit('playerList', Object.values(players).map(p => p.username));
        checkGameOver();
    });

    function checkStartGame() {
        if (Object.keys(players).length >= 2) {
            io.emit('startGame');
        }
    }

    function checkGameOver() {
        if (Object.keys(players).length === 1) {
            let winner = Object.values(players)[0];
            io.emit('gameOver', winner.username);
            setTimeout(() => io.emit('reload'), 5000);
        }
    }
});

server.listen(3000, () => console.log('Server running on port 3000'));
