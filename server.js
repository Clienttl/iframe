// server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express'); // <-- Import Express
const path = require('path');       // <-- Import Path module

// --- Server Setup ---
const app = express();              // <-- Create an Express app
const server = http.createServer(app); // <-- Create HTTP server FROM Express app
const wss = new WebSocket.Server({ server }); // <-- Attach WebSocket server to it
const PORT = process.env.PORT || 3000;

console.log(`WebSocket server starting on port ${PORT}...`);

// --- Serve the HTML file ---
// When someone accesses the root URL ('/'), send them index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Optional: If you add CSS or client-side JS files later, put them in a 'public' folder
// and uncomment this line:
// app.use(express.static(path.join(__dirname, 'public')));


// --- Game State ---
let players = {};
let obstacles = [];
let level = 1;
let score = 0;
let gameTimeStart = Date.now();
let nextObstacleId = 0;
let nextPlayerId = 0;
let gameRunning = false;
let gameLoopInterval = null;
let spawnTimer = null;

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5;
const OBSTACLE_BASE_SIZE = 25;
const OBSTACLE_BASE_SPEED = 1.5;
const LEVEL_SCORE_THRESHOLD = 150;
const BASE_SPAWN_INTERVAL = 2500;

const COLORS = ['#FF6347', '#4682B4', '#32CD32', '#FFD700', '#6A5ACD', '#FF69B4', '#00CED1', '#FFA07A'];
let colorIndex = 0;

// --- Helper Functions (Broadcast, ResetGame, etc. - unchanged) ---
function broadcast(data) {
    const dataString = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(dataString);
        }
    });
}

function getRandomColor() {
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    return color;
}

function resetGame() {
    console.log("Resetting game state...");
    players = {};
    obstacles = [];
    level = 1;
    score = 0;
    gameTimeStart = Date.now();
    nextObstacleId = 0;
    gameRunning = false;
    if (spawnTimer) clearInterval(spawnTimer);
    if (gameLoopInterval) clearInterval(gameLoopInterval);
    spawnTimer = null;
    gameLoopInterval = null;
    wss.clients.forEach(ws => {
        // ws.close(); // Optionally disconnect
    });
    console.log("Game reset complete.");
}

function startGameIfNeeded() {
    if (!gameRunning && Object.keys(players).length > 0) {
        console.log("First player joined, starting game loop...");
        gameRunning = true;
        gameTimeStart = Date.now();
        level = 1;
        score = 0;
        obstacles = [];
        startSpawning();
        gameLoopInterval = setInterval(gameLoop, 1000 / 60);
    }
}

function stopGameIfEmpty() {
    if (gameRunning && Object.keys(players).length === 0) {
        console.log("Last player left, stopping game loop...");
        gameRunning = false;
        if (spawnTimer) clearInterval(spawnTimer);
        if (gameLoopInterval) clearInterval(gameLoopInterval);
        spawnTimer = null;
        gameLoopInterval = null;
        obstacles = [];
        score = 0;
        level = 1;
        console.log("Game stopped.");
    }
}

function spawnObstacle() {
    if (!gameRunning) return;

    const edge = Math.floor(Math.random() * 4);
    const size = OBSTACLE_BASE_SIZE + Math.random() * 20;
    let x, y, vx, vy;
    const speed = (OBSTACLE_BASE_SPEED + Math.random() * 1.0) * (1 + (level - 1) * 0.15);

    switch (edge) {
        case 0: // Top
            x = Math.random() * CANVAS_WIDTH;
            y = -size;
            vx = (Math.random() - 0.5) * speed * 0.5;
            vy = speed;
            break;
        case 1: // Right
            x = CANVAS_WIDTH + size;
            y = Math.random() * CANVAS_HEIGHT;
            vx = -speed;
            vy = (Math.random() - 0.5) * speed * 0.5;
            break;
        case 2: // Bottom
            x = Math.random() * CANVAS_WIDTH;
            y = CANVAS_HEIGHT + size;
            vx = (Math.random() - 0.5) * speed * 0.5;
            vy = -speed;
            break;
        default: // Left
            x = -size;
            y = Math.random() * CANVAS_HEIGHT;
            vx = speed;
            vy = (Math.random() - 0.5) * speed * 0.5;
            break;
    }

    obstacles.push({
        id: nextObstacleId++,
        x, y, vx, vy, size,
        color: '#ff4444'
    });
}

function startSpawning() {
    if (spawnTimer) clearInterval(spawnTimer);
    const spawnInterval = Math.max(300, BASE_SPAWN_INTERVAL / (1 + (level - 1) * 0.2));
    console.log(`Setting spawn interval for Level ${level}: ${spawnInterval.toFixed(0)}ms`);
    spawnTimer = setInterval(spawnObstacle, spawnInterval);
}

// --- Game Loop (unchanged) ---
function gameLoop() {
    if (!gameRunning) return;

    const now = Date.now();
    score = Math.floor((now - gameTimeStart) / 100);

    const neededScore = level * LEVEL_SCORE_THRESHOLD;
    if (score >= neededScore) {
        level++;
        console.log(`--- LEVEL UP! Reached Level ${level} ---`);
        startSpawning();
    }

    obstacles = obstacles.filter(o => {
        o.x += o.vx;
        o.y += o.vy;
        return o.x > -o.size * 2 && o.x < CANVAS_WIDTH + o.size * 2 &&
               o.y > -o.size * 2 && o.y < CANVAS_HEIGHT + o.size * 2;
    });

    const playerIds = Object.keys(players);
    playerIds.forEach(playerId => {
        const player = players[playerId];
        if (!player.isAlive) return;

        for (const obstacle of obstacles) {
            const dx = player.x - obstacle.x;
            const dy = player.y - obstacle.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < player.size + obstacle.size / 2) {
                console.log(`Player ${player.username} hit by obstacle ${obstacle.id}`);
                player.isAlive = false;
                 // No break, check all obstacles
            }
        }
    });

     playerIds.forEach(idA => {
        const playerA = players[idA];
        if (!playerA.isAlive) return;

        playerIds.forEach(idB => {
            if (idA === idB) return;
            const playerB = players[idB];
            if (playerB.isAlive) return;

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < playerA.size + playerB.size) {
                 console.log(`Player ${playerA.username} revived ${playerB.username}`);
                 playerB.isAlive = true;
            }
        });
    });

    const broadcastPlayers = {};
    playerIds.forEach(id => {
        const p = players[id];
        broadcastPlayers[id] = {
            id: p.id, username: p.username, x: p.x, y: p.y, color: p.color, isAlive: p.isAlive, size: p.size
        };
    });

    const gameState = {
        type: 'gameState', players: broadcastPlayers, obstacles: obstacles, level: level, score: score
    };

    broadcast(gameState);
}


// --- WebSocket Connection Handling (mostly unchanged) ---
wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    console.log(`Client connected, assigning ID: ${playerId}`);

    players[playerId] = {
        id: playerId, ws: ws, username: `Player${playerId}`,
        x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 100,
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100,
        color: getRandomColor(), isAlive: true, size: PLAYER_SIZE, targetX: CANVAS_WIDTH / 2, targetY: CANVAS_HEIGHT / 2, keys: {}
    };

    ws.send(JSON.stringify({ type: 'yourId', id: playerId, currentLevel: level, currentScore: score }));
    startGameIfNeeded();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];
            if (!player) return;

            if (data.type === 'setUsername' && data.username) {
                const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_ ]/g, '');
                console.log(`Player ${playerId} set username to: ${sanitizedUsername}`);
                player.username = sanitizedUsername || `Player${playerId}`;
            }

             if (data.type === 'input') {
                 if (data.keys) player.keys = data.keys;
                 if (data.mouse) { player.targetX = data.mouse.x; player.targetY = data.mouse.y; player.useMouse = true; }
                 else { player.useMouse = false; }

                 if (player.isAlive) {
                    let dx = 0; let dy = 0;
                    if (player.useMouse) {
                        const diffX = player.targetX - player.x; const diffY = player.targetY - player.y;
                        const dist = Math.sqrt(diffX * diffX + diffY * diffY);
                        const moveSpeed = PLAYER_SPEED * 1.2;
                        if (dist > player.size / 2) { dx = (diffX / dist) * moveSpeed; dy = (diffY / dist) * moveSpeed;
                             if (Math.abs(diffX) < Math.abs(dx)) dx = diffX; if (Math.abs(diffY) < Math.abs(dy)) dy = diffY;
                        }
                    } else {
                        if (player.keys['w'] || player.keys['arrowup']) dy -= 1; if (player.keys['s'] || player.keys['arrowdown']) dy += 1;
                        if (player.keys['a'] || player.keys['arrowleft']) dx -= 1; if (player.keys['d'] || player.keys['arrowright']) dx += 1;
                        const len = Math.sqrt(dx * dx + dy * dy);
                        if (len > 0) { dx = (dx / len) * PLAYER_SPEED; dy = (dy / len) * PLAYER_SPEED; }
                    }
                    player.x += dx; player.y += dy;
                    player.x = Math.max(player.size, Math.min(CANVAS_WIDTH - player.size, player.x));
                    player.y = Math.max(player.size, Math.min(CANVAS_HEIGHT - player.size, player.y));
                }
             }
        } catch (error) { console.error('Failed to parse message:', message, error); }
    });

    ws.on('close', () => {
        console.log(`Client ${players[playerId]?.username} (ID: ${playerId}) disconnected.`);
        delete players[playerId];
        stopGameIfEmpty();
        broadcast({ type: 'playerLeft', id: playerId });
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId}:`, error);
        if (players[playerId]) { delete players[playerId]; stopGameIfEmpty(); broadcast({ type: 'playerLeft', id: playerId }); }
    });
});

// --- Start the Server ---
server.listen(PORT, () => { // <-- Use server.listen (which includes the Express app)
    console.log(`HTTP server listening on port ${PORT}`);
});

// --- Graceful Shutdown (unchanged) ---
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing server');
    wss.clients.forEach(ws => ws.close());
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
     if (gameLoopInterval) clearInterval(gameLoopInterval);
     if (spawnTimer) clearInterval(spawnTimer);
});
