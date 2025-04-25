// server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

console.log(`WebSocket server starting on port ${PORT}...`);

// --- Serve the HTML file ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// app.use(express.static(path.join(__dirname, 'public'))); // If you add other static files

// --- Game State ---
let players = {}; // { id: { ws, username, x, y, color, isAlive, size, ip, useMouse, mousePos, keys } }
let obstacles = []; // { id, x, y, vx, vy, size, color }
let level = 1;
let score = 0;
let gameTimeStart = Date.now();
let nextObstacleId = 0;
let nextPlayerId = 0;
let gameRunning = false;
let gameLoopInterval = null;
let spawnTimer = null;
let recentlyDeadIPs = {}; // { ipAddress: timestamp }
const RESPAWN_TIMEOUT = 20000; // 20 seconds timeout before respawn allowed
const IP_CLEANUP_INTERVAL = 60000; // Check to remove old IPs every minute

const CANVAS_WIDTH = 1200; // Reference size for server logic
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5; // Base speed for keyboard
const OBSTACLE_BASE_SIZE = 25;
const OBSTACLE_BASE_SPEED = 1.5;
const LEVEL_SCORE_THRESHOLD = 150;
const BASE_SPAWN_INTERVAL = 2500; // Base milliseconds

// Difficulty scaling factors - ADJUST THESE TO TUNE DIFFICULTY
const SPEED_LEVEL_MULTIPLIER = 0.20; // How much faster obstacles get per level (additive percentage)
const SPAWN_RATE_LEVEL_MULTIPLIER = 0.25; // How much faster obstacles spawn per level (divisor factor)
const SIZE_VARIANCE_LEVEL_MULTIPLIER = 1.5; // How much max size variance increases per level (pixels)

const COLORS = ['#FF6347', '#4682B4', '#32CD32', '#FFD700', '#6A5ACD', '#FF69B4', '#00CED1', '#FFA07A'];
let colorIndex = 0;

// --- Helper Functions ---

function getIpFromConnection(ws, req) {
    // Get IP from the initial HTTP request headers during WebSocket upgrade
    // This is more reliable for platforms behind proxies (like Render)
    const forwarded = req?.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(/, /)[0] : req?.socket?.remoteAddress;

    // Fallback if request object isn't available (shouldn't happen with standard ws setup)
    if (!ip && ws && ws._socket) {
        ip = ws._socket.remoteAddress;
    }

    // Handle IPv6 mapped IPv4 addresses (like ::ffff:127.0.0.1)
    if (ip && ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }
    return ip || 'unknown'; // Return 'unknown' if IP cannot be determined
}


function broadcast(data) {
    const dataString = JSON.stringify(data);
    wss.clients.forEach(client => {
        // Find the player associated with this client WebSocket instance
        const player = Object.values(players).find(p => p.ws === client);
        if (player && client.readyState === WebSocket.OPEN) {
             try {
                client.send(dataString);
             } catch (error) {
                 console.error(`Error sending to player ${player.id}:`, error);
                 // Optionally handle disconnect here if send fails repeatedly
             }
        }
    });
}

function getRandomColor() {
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;
    return color;
}

// Cleanup function for the IP timeout list
function cleanupDeadIPs() {
    const now = Date.now();
    let cleanedCount = 0;
    for (const ip in recentlyDeadIPs) {
        if (now - recentlyDeadIPs[ip] > RESPAWN_TIMEOUT) {
            delete recentlyDeadIPs[ip];
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`Cleaned ${cleanedCount} IPs from dead list.`);
    }
}
// Run cleanup periodically
setInterval(cleanupDeadIPs, IP_CLEANUP_INTERVAL);


function resetGame() {
    console.log("Resetting game state...");
    players = {}; // Clear players? Or just reset their state? Clearing for now.
    obstacles = [];
    level = 1;
    score = 0;
    gameTimeStart = Date.now();
    nextObstacleId = 0;
    gameRunning = false;
    recentlyDeadIPs = {}; // Clear dead IPs on full reset
    if (spawnTimer) clearInterval(spawnTimer);
    if (gameLoopInterval) clearInterval(gameLoopInterval);
    spawnTimer = null;
    gameLoopInterval = null;
    wss.clients.forEach(ws => {
        // Optionally force disconnect or just let them rejoin
        // ws.close(1000, "Game Reset");
    });
    console.log("Game reset complete.");
}


function startGameIfNeeded() {
    if (!gameRunning && Object.keys(players).length > 0) {
        console.log("First player joined, starting game loop...");
        gameRunning = true;
        gameTimeStart = Date.now();
        level = 1; // Ensure level/score reset when game starts
        score = 0;
        obstacles = [];
        startSpawning();
        if (!gameLoopInterval) { // Prevent multiple intervals
           gameLoopInterval = setInterval(gameLoop, 1000 / 60); // ~60 FPS
        }
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
        // Keep level/score? Resetting obstacles is good.
        obstacles = [];
        // score = 0; // Optional: reset score when empty
        // level = 1; // Optional: reset level when empty
        console.log("Game stopped.");
    }
}

function spawnObstacle() {
    if (!gameRunning) return;

    const edge = Math.floor(Math.random() * 4);
    // Increase size variance with level
    const sizeVariance = 20 + (level * SIZE_VARIANCE_LEVEL_MULTIPLIER);
    const size = OBSTACLE_BASE_SIZE + Math.random() * sizeVariance;
    let x, y, vx, vy;
    // Increase speed with level
    const speed = (OBSTACLE_BASE_SPEED + Math.random() * 1.0) * (1 + (level - 1) * SPEED_LEVEL_MULTIPLIER);

    // Make them cover more area by adjusting entry points slightly
    const entryVarianceX = CANVAS_WIDTH * 0.1;
    const entryVarianceY = CANVAS_HEIGHT * 0.1;

    switch (edge) {
        case 0: // Top
            x = Math.random() * CANVAS_WIDTH; y = -size;
            vx = (Math.random() - 0.5) * speed; vy = speed; // More horizontal potential
            break;
        case 1: // Right
            x = CANVAS_WIDTH + size; y = Math.random() * CANVAS_HEIGHT;
            vx = -speed; vy = (Math.random() - 0.5) * speed; // More vertical potential
            break;
        case 2: // Bottom
            x = Math.random() * CANVAS_WIDTH; y = CANVAS_HEIGHT + size;
            vx = (Math.random() - 0.5) * speed; vy = -speed; // More horizontal potential
            break;
        default: // Left
            x = -size; y = Math.random() * CANVAS_HEIGHT;
            vx = speed; vy = (Math.random() - 0.5) * speed; // More vertical potential
            break;
    }

    obstacles.push({ id: nextObstacleId++, x, y, vx, vy, size, color: '#ff4444' });
}


function startSpawning() {
    if (spawnTimer) clearInterval(spawnTimer);
    // Increase spawn rate (decrease interval) with level
    const spawnInterval = Math.max(150, BASE_SPAWN_INTERVAL / (1 + (level - 1) * SPAWN_RATE_LEVEL_MULTIPLIER)); // Even lower min interval
    console.log(`Setting spawn interval for Level ${level}: ${spawnInterval.toFixed(0)}ms`);
    spawnTimer = setInterval(spawnObstacle, spawnInterval);
}

// --- Game Loop ---
function gameLoop() {
    if (!gameRunning) return;

    const now = Date.now();
    // Only update score if players are alive
    if (Object.values(players).some(p => p.isAlive)) {
       score = Math.floor((now - gameTimeStart) / 100);
    } else {
        // Maybe pause score increase if everyone is dead? Resetting start time achieves this.
        gameTimeStart = now - (score * 100); // Maintain current score value
    }


    // --- Level Up Check ---
    const neededScore = level * LEVEL_SCORE_THRESHOLD;
    if (score >= neededScore) {
        level++;
        console.log(`--- LEVEL UP! Reached Level ${level} ---`);
        // Optional: Clear obstacles on level up? Makes it easier briefly.
        // obstacles = [];
        startSpawning(); // Adjust spawn rate/speed for new level
        broadcast({ type: 'levelUp', newLevel: level }); // Notify clients
    }

    // --- Update Obstacles ---
    obstacles = obstacles.filter(o => {
        o.x += o.vx;
        o.y += o.vy;
        // Simple boundary removal (keep them slightly longer to ensure they cross screen)
        return o.x > -o.size * 3 && o.x < CANVAS_WIDTH + o.size * 3 &&
               o.y > -o.size * 3 && o.y < CANVAS_HEIGHT + o.size * 3;
    });

    // --- Update Players and Collision Detection ---
    const playerIds = Object.keys(players);

    // 1. Update player positions based on input (already handled in 'message' event)

    // 2. Detect Collisions
    playerIds.forEach(playerId => {
        const player = players[playerId];
        if (!player || !player.isAlive) return; // Skip dead or missing players

        // Player vs Obstacle
        for (const obstacle of obstacles) {
            const dx = player.x - obstacle.x;
            const dy = player.y - obstacle.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < player.size + obstacle.size / 2) {
                console.log(`Player ${player.username} (IP: ${player.ip}) hit by obstacle ${obstacle.id}.`);
                player.isAlive = false;
                recentlyDeadIPs[player.ip] = Date.now(); // Record IP and time of death
                console.log(`Added IP ${player.ip} to dead list.`);
                // No break needed here, could be hit by multiple in one frame
            }
        }
    });

    // 3. Detect Revival (Player vs Player) - Check AFTER obstacle collisions
     playerIds.forEach(idA => {
        const playerA = players[idA];
        if (!playerA || !playerA.isAlive) return; // Living players revive others

        playerIds.forEach(idB => {
            if (idA === idB) return; // Don't check self
            const playerB = players[idB];
            if (!playerB || playerB.isAlive) return; // Can only revive dead players

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < playerA.size + playerB.size) {
                 console.log(`Player ${playerA.username} revived ${playerB.username}`);
                 playerB.isAlive = true;
                 // Optional: Remove IP from dead list immediately upon revive?
                 // Or let timeout handle it? Letting timeout handle it for now.
                 // delete recentlyDeadIPs[playerB.ip];
            }
        });
    });


    // --- Prepare State for Broadcast ---
    // Only send necessary data
    const broadcastPlayers = {};
    playerIds.forEach(id => {
        const p = players[id];
        if(p) { // Ensure player still exists
            broadcastPlayers[id] = {
                id: p.id,
                username: p.username,
                x: p.x,
                y: p.y,
                color: p.color,
                isAlive: p.isAlive,
                size: p.size
                // DO NOT SEND IP TO CLIENTS
            };
        }
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
// We pass 'req' from the upgrade event to get initial headers/IP
wss.on('connection', (ws, req) => {
    const playerIp = getIpFromConnection(ws, req);
    console.log(`Incoming connection attempt from IP: ${playerIp}`);

    // --- IP Respawn Check ---
    const deadTimestamp = recentlyDeadIPs[playerIp];
    if (deadTimestamp) {
        const timeSinceDeath = Date.now() - deadTimestamp;
        if (timeSinceDeath < RESPAWN_TIMEOUT) {
            const timeLeft = Math.ceil((RESPAWN_TIMEOUT - timeSinceDeath) / 1000);
            console.log(`Rejecting connection from recently dead IP: ${playerIp}. Time left: ${timeLeft}s`);
            ws.send(JSON.stringify({ type: 'respawnTimeout', timeLeft: timeLeft }));
            ws.close(1008, `Respawn timeout active (${timeLeft}s left)`); // 1008 = Policy Violation
            return; // Stop processing this connection
        } else {
             // Timeout expired, remove IP before letting them connect
             console.log(`Respawn timeout expired for IP: ${playerIp}. Allowing connection.`);
             delete recentlyDeadIPs[playerIp];
        }
    }


    // --- Player Initialization ---
    const playerId = nextPlayerId++;
    console.log(`Client accepted. Assigning ID: ${playerId}, IP: ${playerIp}`);

    players[playerId] = {
        id: playerId,
        ws: ws, // Keep reference for potential direct messages
        username: `Player${playerId}`, // Default username
        x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 100, // Random start near center
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100,
        color: getRandomColor(),
        isAlive: true,
        size: PLAYER_SIZE,
        ip: playerIp, // Store the player's IP
        useMouse: false, // Default to keyboard
        mousePos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        keys: {} // Store key state
    };

    // Send the new player their ID and current game state
    ws.send(JSON.stringify({
        type: 'yourId',
        id: playerId,
        currentLevel: level,
        currentScore: score,
        // Send initial full state so they don't start on a blank screen
        initialState: {
             players: players, // Send current players
             obstacles: obstacles // Send current obstacles
         }
    }));

    // Start game if needed
    startGameIfNeeded();

    // Handle messages from this client
    ws.on('message', (message) => {
        let data;
        try {
             // Add safety for large messages (optional)
            if (message.length > 1024) {
                 console.warn(`Player ${playerId} sent oversized message (${message.length} bytes). Ignoring.`);
                 ws.close(1009, "Message too large"); // 1009 = Message Too Big
                 return;
            }
            data = JSON.parse(message);
        } catch (error) {
            console.error(`Failed to parse message from player ${playerId}:`, message, error);
            return; // Ignore malformed messages
        }

        const player = players[playerId]; // Get player associated with this websocket
        if (!player) {
             console.warn(`Received message for non-existent player ID: ${playerId}.`);
             return; // Should not happen normally
         }


        // --- Username Setup ---
        if (data.type === 'setUsername' && typeof data.username === 'string') {
            const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_.\- ]/g, ''); // Allow .- too
            console.log(`Player ${playerId} set username to: ${sanitizedUsername}`);
            player.username = sanitizedUsername || `Player${playerId}`; // Fallback if empty after sanitize
            // No need to broadcast immediately, next gameState update will include it
        }

        // --- Input Handling ---
        else if (data.type === 'input') {
            if (data.keys) player.keys = data.keys;
            if (data.mousePos) player.mousePos = data.mousePos;
            if (typeof data.useMouse === 'boolean') player.useMouse = data.useMouse;


            // --- Server-Side Movement Calculation ---
            if (player.isAlive) {
                if (player.useMouse && player.mousePos) {
                    // Direct position setting for mouse control
                    player.x = player.mousePos.x;
                    player.y = player.mousePos.y;
                } else {
                    // Keyboard movement calculation
                    let dx = 0;
                    let dy = 0;
                    if (player.keys['w'] || player.keys['arrowup']) dy -= 1;
                    if (player.keys['s'] || player.keys['arrowdown']) dy += 1;
                    if (player.keys['a'] || player.keys['arrowleft']) dx -= 1;
                    if (player.keys['d'] || player.keys['arrowright']) dx += 1;

                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 0) {
                        dx = (dx / len) * PLAYER_SPEED;
                        dy = (dy / len) * PLAYER_SPEED;
                    }
                    player.x += dx;
                    player.y += dy;
                }

                // Boundary checks (apply regardless of input method)
                player.x = Math.max(player.size, Math.min(CANVAS_WIDTH - player.size, player.x));
                player.y = Math.max(player.size, Math.min(CANVAS_HEIGHT - player.size, player.y));
            }
        }
        // Add other message types (like chat) here if needed
    });

    // Handle disconnection
    ws.on('close', (code, reason) => {
        console.log(`Client ${players[playerId]?.username} (ID: ${playerId}, IP: ${players[playerId]?.ip}) disconnected. Code: ${code}, Reason: ${reason?.toString()}`);
        const player = players[playerId]; // Get player before deleting

        if (player && !player.isAlive) {
            // If player disconnected while dead, ensure their IP is tracked
             if (!recentlyDeadIPs[player.ip]) { // Check if already added by collision
                 console.log(`Player ${player.username} disconnected while dead. Adding IP ${player.ip} to dead list.`);
                 recentlyDeadIPs[player.ip] = Date.now();
             }
        }

        delete players[playerId]; // Remove player from state
        stopGameIfEmpty(); // Stop game if no players left
        broadcast({ type: 'playerLeft', id: playerId }); // Notify remaining clients
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId} (IP: ${players[playerId]?.ip}):`, error);
        // Ensure cleanup happens even on error
        const player = players[playerId];
        if (player && !player.isAlive) {
             if (!recentlyDeadIPs[player.ip]) {
                 console.log(`Player ${player.username} errored out while dead. Adding IP ${player.ip} to dead list.`);
                 recentlyDeadIPs[player.ip] = Date.now();
             }
        }
        if (players[playerId]) delete players[playerId];
        stopGameIfEmpty();
        broadcast({ type: 'playerLeft', id: playerId });
    });
});


// --- Start the Server ---
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing server gracefully...');
    wss.clients.forEach(ws => ws.close(1001, "Server Shutting Down")); // 1001 = Going Away
    server.close(() => {
        console.log('HTTP server closed.');
        // Clear intervals after server stops accepting connections
        if (gameLoopInterval) clearInterval(gameLoopInterval);
        if (spawnTimer) clearInterval(spawnTimer);
        console.log('Intervals cleared.');
        process.exit(0);
    });
    // Force exit after a timeout if graceful shutdown fails
    setTimeout(() => {
       console.error("Graceful shutdown timed out. Forcing exit.");
       process.exit(1);
    }, 5000); // 5 seconds timeout
});
