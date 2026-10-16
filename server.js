const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

// 각 방의 접속자 및 외부 360 링크 상태 관리
const rooms = {}; // roomId -> { peers: { socketId: { role } }, ext360Url: '' }

io.on('connection', (socket) => {
    console.log('Node connected:', socket.id);

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

        console.log(`Node ${socket.id} (${role}) joined session ${roomId}`);

        // 방에 이미 있는 참가자 목록과 현재 360 스트림 URL을 새로 들어온 사람에게 전달
        const existingPeers = Object.keys(rooms[roomId].peers)
            .filter(id => id !== socket.id)
            .map(id => ({ id, role: rooms[roomId].peers[id].role }));

        socket.emit('existing-peers', {
            peers: existingPeers,
            ext360Url: rooms[roomId].ext360Url
        });

        // 기존 참가자들에게 새 참가자 알림
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

    // 무음 메모, 원격 카메라 전환, 360 스트림 URL 공유 등을 위한 이벤트 릴레이
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
        console.log('Node disconnected:', socket.id);
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
    console.log(`Studio Chrono Multi-Cam Server running on port ${PORT}`);
});
