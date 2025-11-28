const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');
const os = require('os');

app.use(express.static(__dirname));

let drawingHistory = [];
let undoStack = []; 
let currentBgColor = "#222222";
let userColors = {};

function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) { color += letters[Math.floor(Math.random() * 16)]; }
    return color;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    userColors[socket.id] = getRandomColor();
    
    // --- NOTIFICATION: Tell everyone else a new user joined ---
    socket.broadcast.emit('user-notification', { 
        type: 'join', 
        text: 'New Collaborator Joined!' 
    });

    // --- WHITEBOARD INIT ---
    socket.emit('init', { history: drawingHistory, bg: currentBgColor });

    // --- AUDIO: Tell new user about existing users ---
    const existingUsers = Array.from(io.sockets.sockets.keys()).filter(id => id !== socket.id);
    socket.emit('all-users', existingUsers);

    socket.on('draw_batch', (batch) => {
        if (!Array.isArray(batch)) return;
        drawingHistory.push(...batch);
        socket.broadcast.emit('draw_batch', batch);
        undoStack = []; 
    });

    socket.on('update_batch', (updatedItems) => {
        if (!Array.isArray(updatedItems)) return;
        updatedItems.forEach(updated => {
            const index = drawingHistory.findIndex(i => i.id === updated.id);
            if (index !== -1) drawingHistory[index] = updated;
        });
        socket.broadcast.emit('update_batch', updatedItems);
    });

    socket.on('delete_batch', (idsToDelete) => {
        drawingHistory = drawingHistory.filter(item => !idsToDelete.includes(item.id));
        socket.broadcast.emit('delete_batch', idsToDelete);
    });

    socket.on('undo', () => {
        if (drawingHistory.length > 0) {
            const removed = drawingHistory.pop();
            undoStack.push(removed);
            io.emit('sync_history', drawingHistory); 
        }
    });

    socket.on('bg-change', (color) => {
        currentBgColor = color;
        io.emit('bg-change', color);
    });

    socket.on('cursor', (pos) => {
        socket.broadcast.emit('cursor', {
            id: socket.id, x: pos.x, y: pos.y, color: userColors[socket.id]
        });
    });

    socket.on('clear', () => {
        drawingHistory = [];
        io.emit('clear');
    });

    // --- AUDIO SIGNALING ---
    socket.on('sending-signal', payload => {
        io.to(payload.userToSignal).emit('user-joined-audio', { signal: payload.signal, callerID: payload.callerID });
    });
    socket.on('returning-signal', payload => {
        io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
    });
    socket.on('ice-candidate', payload => {
        io.to(payload.target).emit('ice-candidate', { candidate: payload.candidate, sender: socket.id });
    });

    socket.on('disconnect', () => {
        delete userColors[socket.id];
        io.emit('user-disconnected', socket.id);
        
        // --- NOTIFICATION: Tell everyone someone left ---
        socket.broadcast.emit('user-notification', { 
            type: 'leave', 
            text: 'Collaborator Left' 
        });
    });
});

const PORT = 3001;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`\n--- WHITEBOARD RUNNING ---`);
    const interfaces = os.networkInterfaces();
    for (let k in interfaces) {
        for (let k2 in interfaces[k]) {
            const address = interfaces[k][k2];
            if (address.family === 'IPv4' && !address.internal) {
                console.log(` > http://${address.address}:${PORT}`);
            }
        }
    }
});