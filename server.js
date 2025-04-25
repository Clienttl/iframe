// server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto'); // For generating lobby IDs

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true }); // Enable client tracking
const PORT = process.env.PORT || 3000;

console.log(`Lobby server starting on port ${PORT}...`);

// --- Serve the HTML file ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Game Constants ---
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5;
const OBSTACLE_BASE_SIZE = 25;
const OBSTACLE_BASE_SPEED = 1.5;
const LEVEL_SCORE_THRESHOLD = 150;
const BASE_SPAWN_INTERVAL = 2500;
const SPEED_LEVEL_MULTIPLIER = 0.20;
const SPAWN_RATE_LEVEL_MULTIPLIER = 0.25;
const SIZE_VARIANCE_LEVEL_MULTIPLIER = 1.5;
const RESPAWN_TIMEOUT = 20000;
const IP_CLEANUP_INTERVAL = 60000;

const COLORS = ['#FF6347', '#4682B4', '#32CD32', '#FFD700', '#6A5ACD', '#FF69B4', '#00CED1', '#FFA07A'];
let globalColorIndex = 0; // Use a global index for variety across lobbies

// --- Global State ---
let players = {}; // { playerId: { ws, username, ip, lobbyId } } - Minimal global player info
let lobbies = {}; // { lobbyId: { name, players: {playerId: playerData}, obstacles, level, ... gameLoopInterval, password } }
let recentlyDeadIPs = {}; // { ipAddress: timestamp }

// --- Helper Functions ---

function getIpFromConnection(ws, req) {
    const forwarded = req?.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(/, /)[0] : req?.socket?.remoteAddress;
    if (!ip && ws && ws._socket) ip = ws._socket.remoteAddress;
    if (ip && ip.startsWith('::ffff:')) return ip.substring(7);
    return ip || 'unknown';
}

function getRandomColor() {
    const color = COLORS[globalColorIndex % COLORS.length];
    globalColorIndex++;
    return color;
}

function generateLobbyId() {
    return crypto.randomBytes(4).toString('hex'); // 8-char hex ID
}

// Send message only to clients in a specific lobby
function broadcastToLobby(lobbyId, data) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const dataString = JSON.stringify(data);
    Object.keys(lobby.players).forEach(playerId => {
        const player = players[playerId]; // Get global player data for WS reference
        if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
            try {
                 player.ws.send(dataString);
            } catch(error) {
                console.error(`Error sending to player ${playerId} in lobby ${lobbyId}:`, error);
            }
        }
    });
}

// Send message to a specific client
function sendToClient(playerId, data) {
     const player = players[playerId];
     if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
         try {
            player.ws.send(JSON.stringify(data));
         } catch(error) {
            console.error(`Error sending direct message to player ${playerId}:`, error);
         }
     }
}

function cleanupDeadIPs() { /* ... unchanged ... */ }
setInterval(cleanupDeadIPs, IP_CLEANUP_INTERVAL);

// --- Lobby Management Functions ---

function createLobby(lobbyName, password = null) {
    const lobbyId = generateLobbyId();
    lobbies[lobbyId] = {
        id: lobbyId,
        name: lobbyName,
        password: password, // Store plaintext (INSECURE!)
        passwordProtected: !!password,
        players: {}, // { playerId: { x, y, color, isAlive, size, useMouse, mousePos, keys } } - Lobby specific player state
        obstacles: [],
        level: 1,
        score: 0,
        gameTimeStart: Date.now(),
        nextObstacleId: 0,
        gameRunning: false,
        gameLoopInterval: null,
        spawnTimer: null,
        colorIndex: 0 // Per-lobby color index if needed, or use global
    };
    console.log(`Lobby created: "${lobbyName}" (ID: ${lobbyId})${password ? ' [Password Protected]' : ''}`);
    return lobbies[lobbyId];
}

// Create the default main lobby
createLobby("Main Lobby");
const MAIN_LOBBY_ID = Object.keys(lobbies)[0]; // Get the ID of the first lobby created

function getLobbyList() {
    const lobbyList = {};
    for (const lobbyId in lobbies) {
        lobbyList[lobbyId] = {
            id: lobbyId,
            name: lobbies[lobbyId].name,
            playerCount: Object.keys(lobbies[lobbyId].players).length,
            passwordProtected: lobbies[lobbyId].passwordProtected
        };
    }
    return lobbyList;
}

function addPlayerToLobby(playerId, lobbyId) {
    const lobby = lobbies[lobbyId];
    const player = players[playerId]; // Global player ref
    if (!lobby || !player) return false;

    // Remove from previous lobby if exists (shouldn't happen often with current flow)
    if (player.lobbyId && lobbies[player.lobbyId]) {
        removePlayerFromLobby(playerId, player.lobbyId, false); // Don't record dead IP here
    }

    // Add to new lobby
    player.lobbyId = lobbyId; // Update global player ref
    lobby.players[playerId] = { // Add lobby-specific state
        x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 100,
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100,
        color: getRandomColor(), // Or use lobby.colorIndex
        isAlive: true,
        size: PLAYER_SIZE,
        useMouse: false,
        mousePos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        keys: {}
    };

    console.log(`Player ${player.username || playerId} joined lobby "${lobby.name}" (ID: ${lobbyId})`);
    startGameIfNeeded(lobbyId); // Start this lobby's game if needed
    return true;
}

function removePlayerFromLobby(playerId, lobbyId, recordDeadIp = true) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.players[playerId]) return;

    const playerGlobal = players[playerId]; // Global ref
    const playerLobby = lobby.players[playerId]; // Lobby ref

    console.log(`Removing player ${playerGlobal?.username || playerId} from lobby "${lobby.name}"`);

    // Record IP if player was dead and flag is set
    if (recordDeadIp && playerLobby && !playerLobby.isAlive && playerGlobal) {
        if (!recentlyDeadIPs[playerGlobal.ip]) {
            console.log(`Player ${playerGlobal.username} left lobby while dead. Adding IP ${playerGlobal.ip} to dead list.`);
            recentlyDeadIPs[playerGlobal.ip] = Date.now();
        }
    }

    // Remove player from lobby's player list
    delete lobby.players[playerId];

    // Update global player ref
    if (playerGlobal) {
        playerGlobal.lobbyId = null;
    }

    // Stop game if lobby is now empty
    stopGameIfEmpty(lobbyId);

    // Optional: Delete empty custom lobbies after a delay? Not implemented here.
    // if (lobbyId !== MAIN_LOBBY_ID && Object.keys(lobby.players).length === 0) { ... }
}

// --- Per-Lobby Game Logic ---

function startGameIfNeeded(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.gameRunning || Object.keys(lobby.players).length === 0) {
        return;
    }
    console.log(`Starting game loop for lobby "${lobby.name}" (ID: ${lobbyId})`);
    lobby.gameRunning = true;
    lobby.gameTimeStart = Date.now(); // Reset score timer for this lobby
    lobby.level = 1; // Reset level/score when game starts
    lobby.score = 0;
    lobby.obstacles = []; // Clear obstacles
    startSpawning(lobbyId);
    if (!lobby.gameLoopInterval) {
        lobby.gameLoopInterval = setInterval(() => gameLoop(lobbyId), 1000 / 60);
    }
}

function stopGameIfEmpty(lobbyId) {
    const lobby = lobbies[lobbyId];
    // Don't stop main lobby? Or maybe reset it? Resetting for now.
    if (!lobby || !lobby.gameRunning || Object.keys(lobby.players).length > 0) {
        return;
    }
    console.log(`Stopping game loop for empty lobby "${lobby.name}" (ID: ${lobbyId})`);
    lobby.gameRunning = false;
    if (lobby.spawnTimer) clearInterval(lobby.spawnTimer);
    if (lobby.gameLoopInterval) clearInterval(lobby.gameLoopInterval);
    lobby.spawnTimer = null;
    lobby.gameLoopInterval = null;
    lobby.obstacles = [];
    // Reset score/level when empty? Optional.
    // lobby.score = 0;
    // lobby.level = 1;
}


function startSpawning(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    if (lobby.spawnTimer) clearInterval(lobby.spawnTimer);

    const spawnInterval = Math.max(150, BASE_SPAWN_INTERVAL / (1 + (lobby.level - 1) * SPAWN_RATE_LEVEL_MULTIPLIER));
    // console.log(`Lobby ${lobbyId}: Spawn interval Lvl ${lobby.level}: ${spawnInterval.toFixed(0)}ms`); // Can be noisy
    lobby.spawnTimer = setInterval(() => spawnObstacle(lobbyId), spawnInterval);
}

function spawnObstacle(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.gameRunning) return;

    const edge = Math.floor(Math.random() * 4);
    const sizeVariance = 20 + (lobby.level * SIZE_VARIANCE_LEVEL_MULTIPLIER);
    const size = OBSTACLE_BASE_SIZE + Math.random() * sizeVariance;
    let x, y, vx, vy;
    const speed = (OBSTACLE_BASE_SPEED + Math.random() * 1.0) * (1 + (lobby.level - 1) * SPEED_LEVEL_MULTIPLIER);

    switch (edge) { /* ... Same obstacle generation logic ... */
        case 0: x = Math.random() * CANVAS_WIDTH; y = -size; vx = (Math.random() - 0.5) * speed; vy = speed; break;
        case 1: x = CANVAS_WIDTH + size; y = Math.random() * CANVAS_HEIGHT; vx = -speed; vy = (Math.random() - 0.5) * speed; break;
        case 2: x = Math.random() * CANVAS_WIDTH; y = CANVAS_HEIGHT + size; vx = (Math.random() - 0.5) * speed; vy = -speed; break;
        default: x = -size; y = Math.random() * CANVAS_HEIGHT; vx = speed; vy = (Math.random() - 0.5) * speed; break;
    }
    lobby.obstacles.push({ id: lobby.nextObstacleId++, x, y, vx, vy, size, color: '#ff4444' });
}

// --- The Game Loop (Now takes lobbyId) ---
function gameLoop(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.gameRunning) {
        // Should be stopped by stopGameIfEmpty, but as a safeguard:
        if (lobby && lobby.gameLoopInterval) {
            console.warn(`Stopping orphaned game loop for lobby ${lobbyId}`);
            clearInterval(lobby.gameLoopInterval);
            lobby.gameLoopInterval = null;
        }
        return;
    }

    const now = Date.now();
    // Score update logic (same as before)
    if (Object.values(lobby.players).some(p => p.isAlive)) {
       lobby.score = Math.floor((now - lobby.gameTimeStart) / 100);
    } else {
        lobby.gameTimeStart = now - (lobby.score * 100);
    }

    // --- Level Up Check ---
    const neededScore = lobby.level * LEVEL_SCORE_THRESHOLD;
    if (lobby.score >= neededScore) {
        lobby.level++;
        console.log(`Lobby ${lobbyId}: LEVEL UP! Reached Level ${lobby.level}`);
        startSpawning(lobbyId); // Adjust spawn rate/speed
        broadcastToLobby(lobbyId, { type: 'levelUp', newLevel: lobby.level }); // Notify clients in lobby
    }

    // --- Update Obstacles ---
    lobby.obstacles = lobby.obstacles.filter(o => {
        o.x += o.vx;
        o.y += o.vy;
        return o.x > -o.size * 3 && o.x < CANVAS_WIDTH + o.size * 3 &&
               o.y > -o.size * 3 && o.y < CANVAS_HEIGHT + o.size * 3;
    });

    // --- Update Players and Collision Detection ---
    const playerIdsInLobby = Object.keys(lobby.players);

    // Collision Detection
    playerIdsInLobby.forEach(playerId => {
        const playerLobby = lobby.players[playerId]; // Lobby specific data
        const playerGlobal = players[playerId]; // Global data (for IP)
        if (!playerLobby || !playerLobby.isAlive || !playerGlobal) return;

        // Player vs Obstacle
        for (const obstacle of lobby.obstacles) {
            const dx = playerLobby.x - obstacle.x;
            const dy = playerLobby.y - obstacle.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < playerLobby.size + obstacle.size / 2) {
                console.log(`Lobby ${lobbyId}: Player ${playerGlobal.username} (IP: ${playerGlobal.ip}) hit by obstacle.`);
                playerLobby.isAlive = false;
                recentlyDeadIPs[playerGlobal.ip] = Date.now();
                 // console.log(`Added IP ${playerGlobal.ip} to dead list.`);
                // No break needed
            }
        }
    });

    // Revival (Player vs Player)
     playerIdsInLobby.forEach(idA => {
        const playerA = lobby.players[idA];
        if (!playerA || !playerA.isAlive) return;

        playerIdsInLobby.forEach(idB => {
            if (idA === idB) return;
            const playerB = lobby.players[idB];
            if (!playerB || playerB.isAlive) return;

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < playerA.size + playerB.size) {
                 const usernameA = players[idA]?.username || idA;
                 const usernameB = players[idB]?.username || idB;
                 console.log(`Lobby ${lobbyId}: Player ${usernameA} revived ${usernameB}`);
                 playerB.isAlive = true;
            }
        });
    });

    // --- Prepare State for Broadcast ---
    const broadcastPlayers = {};
     playerIdsInLobby.forEach(id => {
        const pLobby = lobby.players[id];
        const pGlobal = players[id]; // Need global for username
        if(pLobby && pGlobal) { // Ensure both exist
            broadcastPlayers[id] = {
                id: id, // Send the actual player ID
                username: pGlobal.username, // Get username from global scope
                x: pLobby.x, y: pLobby.y,
                color: pLobby.color, isAlive: pLobby.isAlive, size: pLobby.size
            };
        }
    });

    const gameState = {
        type: 'gameState', // This message type tells client to update game view
        players: broadcastPlayers,
        obstacles: lobby.obstacles,
        level: lobby.level,
        score: lobby.score
    };

    // --- Broadcast State ---
    broadcastToLobby(lobbyId, gameState);
}


// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    const playerIp = getIpFromConnection(ws, req);
    console.log(`Incoming connection from IP: ${playerIp}`);

    // --- IP Respawn Check ---
    const deadTimestamp = recentlyDeadIPs[playerIp];
    if (deadTimestamp) {
        const timeSinceDeath = Date.now() - deadTimestamp;
        if (timeSinceDeath < RESPAWN_TIMEOUT) {
            const timeLeft = Math.ceil((RESPAWN_TIMEOUT - timeSinceDeath) / 1000);
            console.log(`Rejecting connection from recently dead IP: ${playerIp}. Time left: ${timeLeft}s`);
            ws.send(JSON.stringify({ type: 'respawnTimeout', timeLeft: timeLeft }));
            ws.close(1008, `Respawn timeout active (${timeLeft}s left)`);
            return;
        } else {
             console.log(`Respawn timeout expired for IP: ${playerIp}.`);
             delete recentlyDeadIPs[playerIp];
        }
    }

    // --- Player Initialization (Minimal Global) ---
    const playerId = crypto.randomBytes(6).toString('hex'); // Unique Player ID
    players[playerId] = {
        ws: ws,
        username: `Player_${playerId.substring(0, 4)}`, // Initial temporary username
        ip: playerIp,
        lobbyId: null // Not in a lobby yet
    };
    ws.playerId = playerId; // Associate playerId with the ws connection for easy lookup on close/error

    console.log(`Client accepted. Player ID: ${playerId}, IP: ${playerIp}`);

    // Send initial lobby list right away
    sendToClient(playerId, { type: 'lobbyList', lobbies: getLobbyList() });

    // Handle messages from this client
    ws.on('message', (message) => {
        let data;
        try {
            if (message.length > 2048) { // Increased limit slightly for lobby names etc.
                 console.warn(`Player ${playerId} sent oversized message. Closing.`);
                 ws.close(1009, "Message too large");
                 return;
            }
            data = JSON.parse(message);
        } catch (error) {
            console.error(`Failed to parse message from player ${playerId}:`, message, error);
            return;
        }

        const player = players[playerId]; // Global player data
        if (!player) {
            console.warn(`Message received for non-existent player ID: ${playerId}. WS exists but player data lost?`);
             ws.close(1011, "Internal server error - player data lost"); // 1011 = Internal Error
            return;
        }
        const currentLobbyId = player.lobbyId;
        const lobby = currentLobbyId ? lobbies[currentLobbyId] : null;
        const playerLobbyData = lobby ? lobby.players[playerId] : null;


        // --- Message Routing ---

        // Messages allowed BEFORE joining a lobby:
        if (!currentLobbyId) {
            if (data.type === 'getLobbies') {
                sendToClient(playerId, { type: 'lobbyList', lobbies: getLobbyList() });
            }
            else if (data.type === 'createLobby' && typeof data.lobbyName === 'string') {
                const name = data.lobbyName.substring(0, 30).trim(); // Sanitize/limit name length
                const pass = typeof data.password === 'string' && data.password.length > 0 ? data.password.substring(0, 20) : null; // Limit password length

                if (!name) {
                     sendToClient(playerId, { type: 'createFailed', reason: 'Lobby name cannot be empty.' });
                     return;
                }
                // Basic check for existing name (case-insensitive) - could be more robust
                const nameExists = Object.values(lobbies).some(l => l.name.toLowerCase() === name.toLowerCase());
                if (nameExists) {
                    sendToClient(playerId, { type: 'createFailed', reason: `Lobby name "${name}" already exists.` });
                    return;
                }

                const newLobby = createLobby(name, pass);
                if (addPlayerToLobby(playerId, newLobby.id)) {
                    sendToClient(playerId, { type: 'joinSuccess', lobbyId: newLobby.id, lobbyName: newLobby.name });
                     // Send full lobby list update to everyone else who is not in a lobby
                     broadcastLobbyListUpdate();
                } else {
                     sendToClient(playerId, { type: 'createFailed', reason: 'Failed to add player to new lobby.' });
                     // Clean up potentially orphaned lobby?
                     if (Object.keys(newLobby.players).length === 0) delete lobbies[newLobby.id];
                }

            }
            else if (data.type === 'joinLobby' && data.lobbyId) {
                const targetLobby = lobbies[data.lobbyId];
                if (!targetLobby) {
                    sendToClient(playerId, { type: 'joinFailed', reason: 'Lobby not found.' });
                    return;
                }

                if (targetLobby.passwordProtected) {
                    if (typeof data.password !== 'string' || data.password !== targetLobby.password) {
                         // If first attempt without password, ask for it
                         if (data.password === undefined) {
                             sendToClient(playerId, { type: 'passwordRequired', lobbyId: data.lobbyId });
                         } else {
                             sendToClient(playerId, { type: 'joinFailed', reason: 'Incorrect password.' });
                         }
                         return;
                    }
                    // Password correct, proceed
                }

                // Add player to lobby
                if (addPlayerToLobby(playerId, data.lobbyId)) {
                    sendToClient(playerId, { type: 'joinSuccess', lobbyId: targetLobby.id, lobbyName: targetLobby.name });
                     // Send lobby list update AFTER successful join? Or handled by client requesting again?
                     // Let's send an update to others.
                      broadcastLobbyListUpdate();
                } else {
                    sendToClient(playerId, { type: 'joinFailed', reason: 'Failed to add player to lobby.' });
                }
            }
             else {
                  console.warn(`Player ${playerId} sent invalid message type before joining lobby: ${data.type}`);
             }
        }
        // Messages allowed AFTER joining a lobby:
        else if (lobby && playerLobbyData) { // Ensure lobby and player data for lobby exist
             if (data.type === 'setUsername' && typeof data.username === 'string') {
                const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_.\- ]/g, '');
                 if (player.username !== sanitizedUsername) {
                    console.log(`Lobby ${currentLobbyId}: Player ${playerId} set username to: ${sanitizedUsername}`);
                    player.username = sanitizedUsername || `Player_${playerId.substring(0,4)}`; // Update global username
                 }
            }
            else if (data.type === 'input') {
                // Apply input to the player's state *within the lobby*
                if (data.keys) playerLobbyData.keys = data.keys;
                if (data.mousePos) playerLobbyData.mousePos = data.mousePos;
                if (typeof data.useMouse === 'boolean') playerLobbyData.useMouse = data.useMouse;

                // --- Server-Side Movement Calculation ---
                if (playerLobbyData.isAlive) {
                    if (playerLobbyData.useMouse && playerLobbyData.mousePos) {
                        playerLobbyData.x = playerLobbyData.mousePos.x;
                        playerLobbyData.y = playerLobbyData.mousePos.y;
                    } else {
                        let dx = 0, dy = 0;
                        if (playerLobbyData.keys['w'] || playerLobbyData.keys['arrowup']) dy -= 1;
                        if (playerLobbyData.keys['s'] || playerLobbyData.keys['arrowdown']) dy += 1;
                        if (playerLobbyData.keys['a'] || playerLobbyData.keys['arrowleft']) dx -= 1;
                        if (playerLobbyData.keys['d'] || playerLobbyData.keys['arrowright']) dx += 1;
                        const len = Math.sqrt(dx * dx + dy * dy);
                        if (len > 0) { dx = (dx / len) * PLAYER_SPEED; dy = (dy / len) * PLAYER_SPEED; }
                        playerLobbyData.x += dx; playerLobbyData.y += dy;
                    }
                    playerLobbyData.x = Math.max(playerLobbyData.size, Math.min(CANVAS_WIDTH - playerLobbyData.size, playerLobbyData.x));
                    playerLobbyData.y = Math.max(playerLobbyData.size, Math.min(CANVAS_HEIGHT - playerLobbyData.size, playerLobbyData.y));
                }
            }
             else if (data.type === 'getLobbies' || data.type === 'joinLobby' || data.type === 'createLobby') {
                 // Ignore lobby management commands once inside a lobby
                 console.warn(`Player ${playerId} in lobby ${currentLobbyId} sent disallowed command: ${data.type}`);
             }
            // Add other in-game messages here (e.g., chat within lobby)
        } else if (currentLobbyId && !lobby) {
             console.error(`Player ${playerId} has lobbyId ${currentLobbyId}, but lobby does not exist! Forcing disconnect.`);
             player.lobbyId = null; // Clear invalid lobby association
             ws.close(1011, "Internal server error - lobby data lost");
        } else if (currentLobbyId && lobby && !playerLobbyData) {
             console.error(`Player ${playerId} in lobby ${currentLobbyId}, but player data missing from lobby! Forcing disconnect.`);
             delete lobby.players[playerId]; // Ensure removed if partially added
             player.lobbyId = null;
             ws.close(1011, "Internal server error - player lobby data lost");
        }

    }); // End ws.on('message')

    // Handle disconnection
    ws.on('close', (code, reason) => {
        const closedPlayerId = ws.playerId; // Get player ID from ws object
        const player = players[closedPlayerId]; // Get player data using the ID
        if (!player) {
            console.log(`Disconnected client had no associated player data (ID: ${closedPlayerId}). Code: ${code}`);
            return; // Nothing more to do if player wasn't fully registered
        }

        console.log(`Client ${player.username} (ID: ${closedPlayerId}, IP: ${player.ip}) disconnected. Code: ${code}, Reason: ${reason?.toString()}`);

        // Remove player from their lobby (if they were in one)
        if (player.lobbyId) {
            removePlayerFromLobby(closedPlayerId, player.lobbyId, true); // Record dead IP if applicable
             // Notify others in that lobby immediately? Or wait for next game state? Let game state handle it for now.
             // broadcastToLobby(player.lobbyId, { type: 'playerLeft', id: closedPlayerId });
             broadcastLobbyListUpdate(); // Update counts for lobby browser users
        }

        // Remove player from global list
        delete players[closedPlayerId];
        console.log(`Remaining global players: ${Object.keys(players).length}`);

    });

    ws.on('error', (error) => {
         const errorPlayerId = ws.playerId;
         const player = players[errorPlayerId];
        console.error(`WebSocket error for player ${player?.username || errorPlayerId} (IP: ${player?.ip}):`, error);
        // Ensure cleanup happens even on error
        if (player && player.lobbyId) {
            removePlayerFromLobby(errorPlayerId, player.lobbyId, true);
             broadcastLobbyListUpdate();
        }
        if (players[errorPlayerId]) delete players[errorPlayerId];
        // Don't necessarily need to close ws here, 'close' event should follow an error.
    });
}); // End wss.on('connection')


// Function to send updated lobby list to players not currently in a lobby
function broadcastLobbyListUpdate() {
     const list = getLobbyList();
     Object.keys(players).forEach(pid => {
         if (!players[pid].lobbyId) { // Only send to players *not* in a lobby
             sendToClient(pid, { type: 'lobbyList', lobbies: list });
         }
     });
}

// --- Start the Server ---
server.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => { /* ... unchanged ... */ });
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
