const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

const rooms = {}; // roomId -> { peers: { socketId: { role } }, ext360Url: '' }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (payload) => {
        const roomId = typeof payload === 'string' ? payload : payload.roomId;
        const role = (typeof payload === 'object' && payload.role) ? payload.role : 'monitor';

        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = role;

        if (!rooms[roomId]) {
            rooms[roomId] = { peers: {}, ext360Url: '' };
        }
        rooms[roomId].peers[socket.id] = { role };

        console.log(`User ${socket.id} (${role}) joined room ${roomId}`);

        // 기존 영화관 앱과 동일하게 방의 기존 유저들에게 user-connected 이벤트를 쏴서 즉시 Offer를 생성하게 함!
        socket.to(roomId).emit('user-connected', { id: socket.id, role });

        // 현재 방의 360 링크 정보가 있으면 전달
        if (rooms[roomId].ext360Url) {
            socket.emit('room-event', { type: 'ext-360-url', url: rooms[roomId].ext360Url });
        }
    });

    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', {
            ...payload,
            role: socket.role
        });
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', {
            ...payload,
            role: socket.role
        });
    });

    socket.on('ice-candidate', (incoming) => {
        io.to(incoming.target).emit('ice-candidate', {
            candidate: incoming.candidate,
            sender: socket.id
        });
    });

    socket.on('room-event', (payload) => {
        const rId = payload.roomId || socket.roomId;
        if (!rId) return;

        if (payload.type === 'ext-360-url' && rooms[rId]) {
            rooms[rId].ext360Url = payload.url || '';
        }

        socket.to(rId).emit('room-event', {
            ...payload,
            sender: socket.id,
            senderRole: socket.role
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const roomId = socket.roomId;
        if (roomId && rooms[roomId] && rooms[roomId].peers) {
            delete rooms[roomId].peers[socket.id];
            socket.to(roomId).emit('user-disconnected', {
                id: socket.id,
                role: socket.role
            });
            if (Object.keys(rooms[roomId].peers).length === 0) {
                delete rooms[roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, "0.0.0.0", () => {
    console.log(`Studio Chrono Server running on port ${PORT}`);
});
