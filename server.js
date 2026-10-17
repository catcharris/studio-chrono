const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

const rooms = {}; // roomId -> { peers: { socketId: { role } } }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (payload) => {
        const roomId = typeof payload === 'string' ? payload : payload.roomId;
        const role = (typeof payload === 'object' && payload.role) ? payload.role : 'monitor';

        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = role;

        if (!rooms[roomId]) {
            rooms[roomId] = { peers: {} };
        }
        rooms[roomId].peers[socket.id] = { role };

        console.log(`User ${socket.id} (${role}) joined room ${roomId}`);

        socket.to(roomId).emit('user-connected', { id: socket.id, role });
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

    // 메시지 및 카메라 전환 이벤트 릴레이 (방 전체에 확실하게 전달!)
    socket.on('room-event', (payload) => {
        const rId = payload.roomId || socket.roomId;
        if (!rId) return;

        // 혹시 소켓이 재연결되었을 경우를 대비해 방에 다시 join 보장
        socket.join(rId);

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
