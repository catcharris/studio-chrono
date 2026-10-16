const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

// 각 방의 현재 접속자 목록 관리 (자동 재연결 및 멀티 카메라 지원)
const rooms = {}; // roomId -> { socketId: { role: 'master' | 'monitor' | 'aux' } }

io.on('connection', (socket) => {
    console.log('Node connected:', socket.id);

    socket.on('join-room', (payload) => {
        const roomId = typeof payload === 'string' ? payload : payload.roomId;
        const role = (typeof payload === 'object' && payload.role) ? payload.role : 'monitor';

        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = role;

        if (!rooms[roomId]) rooms[roomId] = {};
        rooms[roomId][socket.id] = { role };

        console.log(`Node ${socket.id} (${role}) joined session ${roomId}`);

        // 방에 이미 있는 참가자 목록을 새로 들어온 사람에게 전달
        const existingPeers = Object.keys(rooms[roomId])
            .filter(id => id !== socket.id)
            .map(id => ({ id, role: rooms[roomId][id].role }));
        socket.emit('existing-peers', existingPeers);

        // 기존 참가자들에게 새 참가자 알림
        socket.to(roomId).emit('user-connected', { id: socket.id, role });
    });

    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', payload);
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', payload);
    });

    socket.on('ice-candidate', (incoming) => {
        io.to(incoming.target).emit('ice-candidate', {
            candidate: incoming.candidate,
            sender: socket.id
        });
    });

    // 무음 메모, 상태 동기화, 원격 카메라 전환 요청 등을 위한 이벤트 릴레이
    socket.on('room-event', (payload) => {
        socket.to(payload.roomId).emit('room-event', {
            ...payload,
            sender: socket.id
        });
    });

    socket.on('disconnect', () => {
        console.log('Node disconnected:', socket.id);
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            delete rooms[roomId][socket.id];
            socket.to(roomId).emit('user-disconnected', socket.id);
            if (Object.keys(rooms[roomId]).length === 0) {
                delete rooms[roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, "0.0.0.0", () => {
    console.log(`Studio Chrono Server running on port ${PORT}`);
});
