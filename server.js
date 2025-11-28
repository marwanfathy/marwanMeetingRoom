const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- PRODUCTION: HTTPS SETUP ---
// WebRTC Audio requires HTTPS on non-localhost networks.
// If you have key.pem and cert.pem in this folder, it uses HTTPS.
let server;
let isHttps = false;

try {
    if (fs.existsSync('key.pem') && fs.existsSync('cert.pem')) {
        const options = {
            key: fs.readFileSync('key.pem'),
            cert: fs.readFileSync('cert.pem')
        };
        server = require('https').createServer(options, app);
        isHttps = true;
    } else {
        throw new Error("No certs found");
    }
} catch (e) {
    server = require('http').createServer(app);
}

// --- SOCKET OPTIMIZATION ---
// perMessageDeflate: false reduces CPU usage at cost of bandwidth
// pingInterval/Timeout tweaked for faster disconnect detection
const io = require('socket.io')(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    perMessageDeflate: false,
    pingInterval: 10000,
    pingTimeout: 5000
});

app.use(express.static(__dirname));

// --- STATE MANAGEMENT ---
// Using Map for better performance than Objects on large sets
let drawingHistory = []; 
let userNames = new Map(); 
let screenSharerId = null;

function getLocalExternalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if ('IPv4' !== iface.family || iface.internal) continue;
            return iface.address;
        }
    }
    return 'localhost';
}

function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) { color += letters[Math.floor(Math.random() * 16)]; }
    return color;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    // 1. Initial Handshake
    socket.on('join-room', (name) => {
        const safeName = name || `User-${socket.id.substr(0,4)}`;
        userNames.set(socket.id, safeName);
        
        // Notify others
        socket.broadcast.emit('user-notification', { 
            type: 'join', 
            text: `${safeName} Joined` 
        });

        // Send State
        socket.emit('init', { history: drawingHistory });
        socket.emit('user-count', userNames.size);
        socket.broadcast.emit('user-count', userNames.size);

        // Send active screen share state
        if (screenSharerId) {
            socket.emit('screen-share-active', { sharerId: screenSharerId });
        }

        // Send existing users for WebRTC Mesh
        const existingUsers = Array.from(userNames.keys()).filter(id => id !== socket.id);
        socket.emit('all-users', existingUsers);
    });

    // --- HIGH FREQUENCY EVENTS (Cursors / Drawing) ---
    // Forwarded immediately for lowest latency
    socket.on('draw_batch', (batch) => {
        if (!Array.isArray(batch)) return;
        drawingHistory.push(...batch);
        socket.broadcast.emit('draw_batch', batch);
    });

    socket.on('cursor', (pos) => {
        // Volatile: If a packet is dropped, don't retry. Reduces latency lag.
        socket.broadcast.volatile.emit('cursor', {
            id: socket.id, 
            x: pos.x, 
            y: pos.y, 
            color: getRandomColor() // Assign random color for cursor logic
        });
    });

    // --- STATE UPDATES ---
    socket.on('update_batch', (updatedItems) => {
        updatedItems.forEach(updated => {
            const index = drawingHistory.findIndex(i => i.id === updated.id);
            if (index !== -1) drawingHistory[index] = updated;
        });
        socket.broadcast.emit('update_batch', updatedItems);
    });

    socket.on('delete_batch', (ids) => {
        drawingHistory = drawingHistory.filter(item => !ids.includes(item.id));
        socket.broadcast.emit('delete_batch', ids);
    });

    socket.on('undo', () => {
        if(drawingHistory.length > 0) {
            drawingHistory.pop();
            io.emit('sync_history', drawingHistory);
        }
    });

    socket.on('clear', () => {
        drawingHistory = [];
        io.emit('clear');
    });

    // --- WEBRTC SIGNALING (Audio & Screen) ---
    socket.on('sending-signal', p => io.to(p.userToSignal).emit('user-joined-audio', { signal: p.signal, callerID: p.callerID }));
    socket.on('returning-signal', p => io.to(p.callerID).emit('receiving-returned-signal', { signal: p.signal, id: socket.id }));
    socket.on('ice-candidate', p => io.to(p.target).emit('ice-candidate', { candidate: p.candidate, sender: socket.id }));

    // Screen Share Signaling
    socket.on('start-screen-share', () => {
        if (!screenSharerId) {
            screenSharerId = socket.id;
            io.emit('screen-share-started', socket.id);
        }
    });

    socket.on('stop-screen-share', () => {
        if (screenSharerId === socket.id) {
            screenSharerId = null;
            io.emit('screen-share-stopped');
        }
    });

    socket.on('screen-signal', p => io.to(p.target).emit('screen-signal', { signal: p.signal, sender: socket.id }));

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const name = userNames.get(socket.id);
        userNames.delete(socket.id);
        
        io.emit('user-disconnected', socket.id);
        io.emit('user-count', userNames.size);
        
        if (screenSharerId === socket.id) {
            screenSharerId = null;
            io.emit('screen-share-stopped');
        }

        if (name) {
            socket.broadcast.emit('user-notification', { type: 'leave', text: `${name} Left` });
        }
    });
});

const PORT = process.env.PORT || 3001;
const localIP = getLocalExternalIP();
const protocol = isHttps ? 'https' : 'http';

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n--- MARWAN MEETING ROOM (Production Mode) ---`);
    console.log(`> Protocol: ${isHttps ? 'HTTPS (Secure)' : 'HTTP (Insecure - Audio may fail on mobile)'}`);
    console.log(`> Local:    ${protocol}://localhost:${PORT}`);
    console.log(`> Network:  ${protocol}://${localIP}:${PORT}`);
    console.log(`---------------------------------------------`);
});
