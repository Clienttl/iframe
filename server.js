// server.js
const WebSocket = require('ws');
const http = require('http');

// --- Server Setup ---
const server = http.createServer(); // Basic HTTP server
const wss = new WebSocket.Server({ server }); // WebSocket server attached to HTTP server
const PORT = process.env.PORT || 3000; // Use environment port or 3000

console.log(`WebSocket server starting on port ${PORT}...`);

// --- Game State ---
let players = {}; // Store player data { id: { ws, username, x, y, color, isAlive, size } }
let obstacles = []; // Store obstacle data { id, x, y, vx, vy, size }
let level = 1;
let score = 0; // Time-based score
let gameTimeStart = Date.now();
let nextObstacleId = 0;
let nextPlayerId = 0; // Simple way to assign unique IDs
let gameRunning = false;
let gameLoopInterval = null;
let spawnTimer = null;

const CANVAS_WIDTH = 1200; // Define a virtual canvas size for the server
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5;
const OBSTACLE_BASE_SIZE = 25;
const OBSTACLE_BASE_SPEED = 1.5;
const LEVEL_SCORE_THRESHOLD = 150; // Score needed per level
const BASE_SPAWN_INTERVAL = 2500; // Milliseconds

const COLORS = ['#FF6347', '#4682B4', '#32CD32', '#FFD700', '#6A5ACD', '#FF69B4', '#00CED1', '#FFA07A'];
let colorIndex = 0;

// --- Helper Functions ---
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
    players = {}; // Clear players on full reset (or handle differently if needed)
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
         // Optionally force disconnect or just let them rejoin
         // ws.close();
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
        obstacles = []; // Clear obstacles on game start
        startSpawning();
        gameLoopInterval = setInterval(gameLoop, 1000 / 60); // ~60 FPS
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
        // Optionally reset obstacles/score here or keep state for next player
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

// --- Game Loop ---
function gameLoop() {
    if (!gameRunning) return;

    const now = Date.now();
    score = Math.floor((now - gameTimeStart) / 100); // Score based on time survived

    // --- Level Up Check ---
    const neededScore = level * LEVEL_SCORE_THRESHOLD;
    if (score >= neededScore) {
        level++;
        console.log(`--- LEVEL UP! Reached Level ${level} ---`);
        // Optional: Clear obstacles on level up?
        // obstacles = [];
        startSpawning(); // Adjust spawn rate for new level
    }

    // --- Update Obstacles ---
    obstacles = obstacles.filter(o => {
        o.x += o.vx;
        o.y += o.vy;
        // Simple boundary removal
        return o.x > -o.size * 2 && o.x < CANVAS_WIDTH + o.size * 2 &&
               o.y > -o.size * 2 && o.y < CANVAS_HEIGHT + o.size * 2;
    });

    // --- Collision Detection ---
    const playerIds = Object.keys(players);
    playerIds.forEach(playerId => {
        const player = players[playerId];
        if (!player.isAlive) return; // Skip dead players for obstacle collision

        // Player vs Obstacle
        for (const obstacle of obstacles) {
            const dx = player.x - obstacle.x;
            const dy = player.y - obstacle.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < player.size + obstacle.size / 2) {
                console.log(`Player ${player.username} hit by obstacle ${obstacle.id}`);
                player.isAlive = false;
                // No break here, check all obstacles in one frame
            }
        }
    });

    // Player vs Player (Revival) - Check AFTER obstacle collisions
     playerIds.forEach(idA => {
        const playerA = players[idA];
        if (!playerA.isAlive) return; // Living players revive others

        playerIds.forEach(idB => {
            if (idA === idB) return; // Don't check self
            const playerB = players[idB];
            if (playerB.isAlive) return; // Can only revive dead players

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < playerA.size + playerB.size) {
                 console.log(`Player ${playerA.username} revived ${playerB.username}`);
                 playerB.isAlive = true;
            }
        });
    });


    // --- Prepare State for Broadcast ---
    // Only send necessary data
    const broadcastPlayers = {};
    playerIds.forEach(id => {
        const p = players[id];
        broadcastPlayers[id] = {
            id: p.id,
            username: p.username,
            x: p.x,
            y: p.y,
            color: p.color,
            isAlive: p.isAlive,
            size: p.size
        };
    });

    const gameState = {
        type: 'gameState',
        players: broadcastPlayers,
        obstacles: obstacles,
        level: level,
        score: score
    };

    // --- Broadcast State ---
    broadcast(gameState);
}


// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    console.log(`Client connected, assigning ID: ${playerId}`);

    // Initialize player state
    players[playerId] = {
        id: playerId,
        ws: ws, // Keep reference for potential direct messages (though we mostly broadcast)
        username: `Player${playerId}`, // Default username
        x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 100, // Random start near center
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100,
        color: getRandomColor(),
        isAlive: true,
        size: PLAYER_SIZE,
        targetX: CANVAS_WIDTH / 2, // For mouse movement
        targetY: CANVAS_HEIGHT / 2,
        keys: {} // Store key state
    };

    // Send the new player their ID and current level/score
    ws.send(JSON.stringify({ type: 'yourId', id: playerId, currentLevel: level, currentScore: score }));

    // Start game if needed
    startGameIfNeeded();

    // Handle messages from this client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId]; // Get player associated with this websocket

            if (!player) return; // Should not happen normally

            // --- Username Setup ---
            if (data.type === 'setUsername' && data.username) {
                const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_ ]/g, ''); // Basic sanitize
                console.log(`Player ${playerId} set username to: ${sanitizedUsername}`);
                player.username = sanitizedUsername || `Player${playerId}`; // Fallback if empty after sanitize
                // Broadcast the updated player list potentially, or let next game state handle it
            }

            // --- Input Handling ---
             if (data.type === 'input') {
                 if (data.keys) {
                     player.keys = data.keys; // Update key state
                 }
                 if (data.mouse) {
                     player.targetX = data.mouse.x;
                     player.targetY = data.mouse.y;
                     player.useMouse = true; // Flag that mouse is the primary input
                 } else {
                     player.useMouse = false; // Keyboard is primary if no mouse data
                 }

                 // --- Server-Side Movement Calculation ---
                 if (player.isAlive) {
                    let dx = 0;
                    let dy = 0;

                    if (player.useMouse) {
                        const diffX = player.targetX - player.x;
                        const diffY = player.targetY - player.y;
                        const dist = Math.sqrt(diffX * diffX + diffY * diffY);
                        const moveSpeed = PLAYER_SPEED * 1.2; // Slightly faster for mouse follow

                        if (dist > player.size / 2) { // Move if cursor is away from center
                            dx = (diffX / dist) * moveSpeed;
                            dy = (diffY / dist) * moveSpeed;
                            // Prevent overshooting
                             if (Math.abs(diffX) < Math.abs(dx)) dx = diffX;
                             if (Math.abs(diffY) < Math.abs(dy)) dy = diffY;
                        }
                    } else {
                        // Keyboard movement
                        if (player.keys['w'] || player.keys['arrowup']) dy -= 1;
                        if (player.keys['s'] || player.keys['arrowdown']) dy += 1;
                        if (player.keys['a'] || player.keys['arrowleft']) dx -= 1;
                        if (player.keys['d'] || player.keys['arrowright']) dx += 1;

                        const len = Math.sqrt(dx * dx + dy * dy);
                        if (len > 0) {
                            dx = (dx / len) * PLAYER_SPEED;
                            dy = (dy / len) * PLAYER_SPEED;
                        }
                    }

                    player.x += dx;
                    player.y += dy;

                    // Boundary checks
                    player.x = Math.max(player.size, Math.min(CANVAS_WIDTH - player.size, player.x));
                    player.y = Math.max(player.size, Math.min(CANVAS_HEIGHT - player.size, player.y));
                }
             }

        } catch (error) {
            console.error('Failed to parse message or invalid message format:', message, error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        console.log(`Client ${players[playerId]?.username} (ID: ${playerId}) disconnected.`);
        delete players[playerId]; // Remove player from state
        // Stop game if no players left
        stopGameIfEmpty();
        // Broadcast updated player list (or let game state handle it)
        broadcast({ type: 'playerLeft', id: playerId });
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId}:`, error);
        // Ensure cleanup happens even on error
        if (players[playerId]) {
            delete players[playerId];
            stopGameIfEmpty();
            broadcast({ type: 'playerLeft', id: playerId });
        }
    });
});

// Start the HTTP server -> WebSocket server starts with it
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// Graceful shutdown handling (optional but good practice)
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    wss.clients.forEach(ws => ws.close()); // Close all WebSocket connections
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
     if (gameLoopInterval) clearInterval(gameLoopInterval);
     if (spawnTimer) clearInterval(spawnTimer);
});
