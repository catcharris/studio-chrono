const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// =====================================================
// 0. iOS 사파리 페이지 전체 확대(Pinch/Double-tap Zoom) 100% 원천 차단
// =====================================================
document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', e => e.preventDefault(), { passive: false });

document.addEventListener('touchmove', function(e) {
    if (e.touches && e.touches.length > 1) {
        e.preventDefault();
    }
}, { passive: false });

let lastTouchEndTime = 0;
document.addEventListener('touchend', function(e) {
    const now = Date.now();
    if (now - lastTouchEndTime <= 300) {
        e.preventDefault();
    }
    lastTouchEndTime = now;
}, { passive: false });

// 역할 및 방 상태
let roomId = '';
let myRole = 'master'; // 'master' (지휘자) | 'monitor' (뷰어)
let localStream = null;

// 멀티 피어 및 스트림 관리
const peers = {};       // socketId -> RTCPeerConnection
const peerRoles = {};   // socketId -> 'master' | 'monitor'
const peerStreams = {}; // socketId -> MediaStream

// 오디오/비디오 상태
let isRemoteAudioMuted = true;
let isLocalMicEnabled = true;
let isMusicRawMode = true;
let currentVideoDeviceId = null;
let currentFacingMode = 'user';

// Web Audio API
let remoteAudioCtx = null;
let remoteGainNode = null;

// 뷰어 채널 및 화면 모드
let displayMode = 'stealth'; // 'stealth' | 'video' | 'blackout'
let activeViewerChannel = 'master-front';
let isPipVisible = false;
let isSwappedPip = false;

// 비디오 회전 / 배율 상태
let remoteRotation = 0;
let remoteZoom = 1;
let remoteMirrored = false;

// 타이머 & WakeLock
let chronoSeconds = 0;
let chronoRunning = true;
let chronoInterval = null;
let wakeLock = null;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const peekVideo = document.getElementById('peekVideo');
const pipBox = document.getElementById('pipBox');

function initAudioBooster() {
    try {
        if (!remoteAudioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            remoteAudioCtx = new AudioContext();
            remoteGainNode = remoteAudioCtx.createGain();
            remoteGainNode.connect(remoteAudioCtx.destination);
        }
        if (remoteAudioCtx.state === 'suspended') {
            remoteAudioCtx.resume();
        }
        remoteGainNode.gain.value = isRemoteAudioMuted ? 0 : 1.0;
    } catch (e) {
        console.warn('AudioContext init error:', e);
    }
}

document.addEventListener('touchstart', () => {
    if (remoteAudioCtx && remoteAudioCtx.state === 'suspended') remoteAudioCtx.resume();
}, { passive: true });
document.addEventListener('click', () => {
    if (remoteAudioCtx && remoteAudioCtx.state === 'suspended') remoteAudioCtx.resume();
});

function connectStreamAudio(stream) {
    if (!remoteAudioCtx || !remoteGainNode || !stream) return;
    if (!stream.boostConnected && stream.getAudioTracks().length > 0) {
        try {
            const audioStream = new MediaStream([stream.getAudioTracks()[0]]);
            const source = remoteAudioCtx.createMediaStreamSource(audioStream);
            source.connect(remoteGainNode);
            stream.boostConnected = true;
        } catch (e) {
            console.warn('Audio booster error:', e);
        }
    }
}

// =====================================================
// 1. 세션 시작 (MASTER vs MONITOR)
// =====================================================
window.startSession = async function(role) {
    initAudioBooster();
    const inputVal = document.getElementById('sessionInput').value.trim();
    if (!inputVal) return alert('Enter Session Code');

    roomId = inputVal;
    myRole = role;

    if (myRole === 'master') {
        isRemoteAudioMuted = true;
        isMusicRawMode = true;
        currentFacingMode = 'user';
        displayMode = 'stealth';
        isPipVisible = false; // 마스터는 필요할 때만 PIP 켜기
    } else {
        // MONITOR (뷰어)
        isRemoteAudioMuted = false;
        isMusicRawMode = false;
        currentFacingMode = 'user';
        displayMode = 'video';
        isPipVisible = true;
    }

    document.getElementById('lobbyStatus').innerText = 'INITIALIZING...';

    try {
        await acquireMediaStream(null, currentFacingMode);
    } catch (err) {
        console.error('Camera error:', err);
        alert('카메라/마이크 권한이 필요합니다.');
        return;
    }

    await requestWakeLock();

    document.getElementById('lobbyScreen').style.display = 'none';
    document.getElementById('mainScreen').style.display = 'block';

    configureRoleSpecificUI();

    applyRemoteAudioState();
    updateMicUI();
    updateMusicModeUI();
    updatePipButtonUI();
    setDisplayMode(displayMode);
    startTimers();
    setupPeekHoldEvents();

    setSyncStatus('connecting', 'WAIT');
    socket.emit('join-room', { roomId, role: myRole });
};

function configureRoleSpecificUI() {
    const isMaster = (myRole === 'master');

    // 마스터에게만 상단 TIMER/VIEW/DIM 버튼 및 하단 CAM/RAW 버튼 표시
    document.getElementById('masterModeSwitcher').style.display = isMaster ? 'flex' : 'none';

    document.querySelectorAll('.master-only').forEach(el => {
        el.style.display = isMaster ? 'flex' : 'none';
    });
}

// =====================================================
// 2. PIP 화면 켜기 / 끄기 토글
// =====================================================
window.togglePipVisibility = function() {
    isPipVisible = !isPipVisible;
    updatePipButtonUI();
    updateVideoLayout();
};

function updatePipButtonUI() {
    const btn = document.getElementById('btnPipToggle');
    const label = document.getElementById('labelPip');
    if (isPipVisible) {
        btn.className = 'dock-btn pip-active';
        label.innerText = 'PIP';
    } else {
        btn.className = 'dock-btn';
        label.innerText = 'PIP';
    }
}

// =====================================================
// 3. 카메라 & 오디오 스트림 획득
// =====================================================
async function acquireMediaStream(deviceId = null, facingMode = 'user') {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    const videoConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
        : { facingMode: facingMode, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };

    const useEchoCancel = !isRemoteAudioMuted || !isMusicRawMode;
    const audioConstraints = {
        echoCancellation: useEchoCancel,
        noiseSuppression: !isMusicRawMode,
        autoGainControl: !isMusicRawMode
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: audioConstraints
        });
    } catch (err) {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
    }

    localStream.getAudioTracks().forEach(track => {
        track.enabled = isLocalMicEnabled;
    });
    localStream.getVideoTracks().forEach(track => {
        track.enabled = isLocalCamEnabled;
    });

    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) {
        const settings = vTrack.getSettings ? vTrack.getSettings() : {};
        currentVideoDeviceId = settings.deviceId || deviceId;
        const isFront = (!deviceId && facingMode === 'user') || (vTrack.label && vTrack.label.toLowerCase().includes('front'));
        localVideo.style.transform = isFront ? 'scaleX(-1)' : 'scaleX(1)';
        document.getElementById('labelCam').innerText = getShortCamName(vTrack.label, facingMode);
    }

    updateVideoLayout();

    for (const peerId in peers) {
        const pc = peers[peerId];
        const senders = pc.getSenders();

        const newVideoTrack = localStream.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender && newVideoTrack) {
            await videoSender.replaceTrack(newVideoTrack);
        }

        const newAudioTrack = localStream.getAudioTracks()[0];
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender && newAudioTrack) {
            await audioSender.replaceTrack(newAudioTrack);
        }
    }
}

function getShortCamName(label, facing) {
    if (!label) return facing === 'environment' ? 'REAR' : 'FRONT';
    const lower = label.toLowerCase();
    if (lower.includes('ultra') || lower.includes('초광각') || lower.includes('0.5')) return '0.5x';
    if (lower.includes('back') || lower.includes('후면')) return 'REAR';
    if (lower.includes('front') || lower.includes('전면')) return 'FRONT';
    return 'CAM';
}

// =====================================================
// 4. 화면 배치 로직
// =====================================================
function getStreamByRole(targetRole) {
    for (const id in peerStreams) {
        if (peerRoles[id] === targetRole) {
            return peerStreams[id];
        }
    }
    return null;
}

function getFirstRemoteStream() {
    const ids = Object.keys(peerStreams);
    return ids.length > 0 ? peerStreams[ids[0]] : null;
}

function assignVideoSrc(videoEl, stream) {
    if (!videoEl) return;
    if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream || null;
        if (stream) {
            videoEl.play().catch(e => console.warn('play warning:', e));
        }
    }
}

function updateVideoLayout() {
    const masterStream = getStreamByRole('master');
    const monitorStream = getStreamByRole('monitor');
    const anyRemoteStream = getFirstRemoteStream();

    const badgeMaster = document.getElementById('badgeMaster');
    if (badgeMaster) badgeMaster.classList.toggle('live', !!(masterStream || anyRemoteStream));

    // 1) 마스터 스텔스 타이머 모드
    if (displayMode === 'stealth') {
        if (isPipVisible) {
            pipBox.classList.remove('hidden-pip');
            pipBox.classList.add('stealth-mini');
            const targetPip = monitorStream || anyRemoteStream || localStream;
            assignVideoSrc(localVideo, targetPip);
            localVideo.style.transform = (monitorStream || anyRemoteStream) ? 'scaleX(1)' : 'scaleX(-1)';
            document.getElementById('pipLabel').innerText = (monitorStream || anyRemoteStream) ? 'MON' : 'CAM';
        } else {
            pipBox.classList.add('hidden-pip');
        }
        return;
    }

    // 2) VIEW 모드
    pipBox.classList.remove('stealth-mini');

    if (myRole === 'monitor') {
        const mainTarget = masterStream || anyRemoteStream || null;

        if (!isSwappedPip) {
            assignVideoSrc(remoteVideo, mainTarget);
            assignVideoSrc(localVideo, localStream);
            localVideo.style.transform = 'scaleX(-1)';
            document.getElementById('pipLabel').innerText = 'ME';
        } else {
            assignVideoSrc(remoteVideo, localStream);
            assignVideoSrc(localVideo, mainTarget);
            localVideo.style.transform = 'scaleX(1)';
            document.getElementById('pipLabel').innerText = 'STAGE';
        }

        if (isPipVisible) {
            pipBox.classList.remove('hidden-pip');
        } else {
            pipBox.classList.add('hidden-pip');
        }
    } else {
        const targetRemote = monitorStream || anyRemoteStream || null;

        if (!isSwappedPip) {
            assignVideoSrc(remoteVideo, targetRemote || localStream);
            assignVideoSrc(localVideo, localStream);
            localVideo.style.transform = 'scaleX(-1)';
            document.getElementById('pipLabel').innerText = 'CAM';
        } else {
            assignVideoSrc(remoteVideo, localStream);
            assignVideoSrc(localVideo, targetRemote);
            localVideo.style.transform = 'scaleX(1)';
            document.getElementById('pipLabel').innerText = 'MON';
        }

        if (isPipVisible) {
            pipBox.classList.remove('hidden-pip');
        } else {
            pipBox.classList.add('hidden-pip');
        }
    }

    applyRemoteAudioState();
}

// =====================================================
// 5. WebRTC 시그널링
// =====================================================
socket.on('user-connected', async (peerInfo) => {
    const userId = typeof peerInfo === 'string' ? peerInfo : peerInfo.id;
    const role = (typeof peerInfo === 'object' && peerInfo.role) ? peerInfo.role : 'monitor';
    peerRoles[userId] = role;

    setSyncStatus('connecting', 'LINK');

    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('offer', {
        target: userId,
        caller: socket.id,
        sdp: pc.localDescription,
        role: myRole
    });
});

socket.on('offer', async (payload) => {
    if (payload.role) peerRoles[payload.caller] = payload.role;

    const pc = createPeerConnection(payload.caller);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer', {
        target: payload.caller,
        caller: socket.id,
        sdp: pc.localDescription,
        role: myRole
    });
});

socket.on('answer', async (payload) => {
    if (payload.role) peerRoles[payload.caller] = payload.role;

    const pc = peers[payload.caller];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        setSyncStatus('online', 'SYNC');
    }
});

socket.on('ice-candidate', async (incoming) => {
    const pc = peers[incoming.sender];
    if (pc && incoming.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(incoming.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    }
});

socket.on('user-disconnected', (data) => {
    const peerId = typeof data === 'string' ? data : data.id;
    if (peers[peerId]) {
        peers[peerId].close();
        delete peers[peerId];
    }
    delete peerStreams[peerId];
    delete peerRoles[peerId];

    if (Object.keys(peerStreams).length === 0) {
        setSyncStatus('connecting', 'WAIT');
    }
    updateVideoLayout();
});

function createPeerConnection(targetUserId) {
    if (peers[targetUserId]) {
        peers[targetUserId].close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetUserId] = pc;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetUserId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = (event) => {
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        peerStreams[targetUserId] = stream;

        connectStreamAudio(stream);
        setSyncStatus('online', 'SYNC');
        updateVideoLayout();
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            setSyncStatus('online', 'SYNC');
            updateVideoLayout();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            delete peers[targetUserId];
            delete peerStreams[targetUserId];
            updateVideoLayout();
        }
    };

    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    return pc;
}

// =====================================================
// 6. 카메라 센서 선택 모달 (카메라 끄기 OFF 포함!)
// =====================================================
let isLocalCamEnabled = true;

function setLocalCamEnabled(enabled) {
    isLocalCamEnabled = enabled;
    if (localStream) {
        localStream.getVideoTracks().forEach(track => {
            track.enabled = isLocalCamEnabled;
        });
    }
    const btnCam = document.getElementById('btnCam');
    const labelCam = document.getElementById('labelCam');
    if (!isLocalCamEnabled) {
        if (btnCam) btnCam.className = 'dock-btn mic-off';
        if (labelCam) labelCam.innerText = 'OFF';
    } else {
        if (btnCam) btnCam.className = 'dock-btn';
        const vTrack = localStream ? localStream.getVideoTracks()[0] : null;
        if (labelCam) labelCam.innerText = getShortCamName(vTrack ? vTrack.label : '', currentFacingMode);
    }
}

window.openCamModal = async function() {
    const modal = document.getElementById('camModal');
    const container = document.getElementById('camListContainer');
    container.innerHTML = '';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        let ultraWideDev = null;
        const externalDevs = [];

        videoDevices.forEach(dev => {
            const l = (dev.label || '').toLowerCase();
            if (l.includes('ultra') || l.includes('초광각') || l.includes('0.5')) {
                if (!ultraWideDev) ultraWideDev = dev;
            } else if (l.includes('insta360') || l.includes('x5') || l.includes('usb') || l.includes('external') || l.includes('외장')) {
                externalDevs.push(dev);
            }
        });

        // 1) 전면 카메라 (Front)
        const isFrontSel = isLocalCamEnabled && (currentFacingMode === 'user' && !currentVideoDeviceId);
        const btnFront = document.createElement('button');
        btnFront.className = 'cam-item' + (isFrontSel ? ' selected' : '');
        btnFront.innerHTML = `<span>전면 카메라 (Front)</span><span>${isFrontSel ? '● FRONT' : 'FRONT'}</span>`;
        btnFront.onclick = async () => {
            currentFacingMode = 'user';
            currentVideoDeviceId = null;
            isLocalCamEnabled = true;
            closeCamModal();
            await acquireMediaStream(null, 'user');
            setLocalCamEnabled(true);
        };
        container.appendChild(btnFront);

        // 2) 후면 카메라 (Rear 1x)
        const isRearSel = isLocalCamEnabled && (currentFacingMode === 'environment' && !currentVideoDeviceId);
        const btnRear = document.createElement('button');
        btnRear.className = 'cam-item' + (isRearSel ? ' selected' : '');
        btnRear.innerHTML = `<span>후면 카메라 (Rear 1x)</span><span>${isRearSel ? '● REAR 1x' : 'REAR 1x'}</span>`;
        btnRear.onclick = async () => {
            currentFacingMode = 'environment';
            currentVideoDeviceId = null;
            isLocalCamEnabled = true;
            closeCamModal();
            await acquireMediaStream(null, 'environment');
            setLocalCamEnabled(true);
        };
        container.appendChild(btnRear);

        // 3) 후면 초광각 (Wide 0.5x)
        if (ultraWideDev) {
            const isUltraSel = isLocalCamEnabled && (currentVideoDeviceId === ultraWideDev.deviceId);
            const btnUltra = document.createElement('button');
            btnUltra.className = 'cam-item' + (isUltraSel ? ' selected' : '');
            btnUltra.innerHTML = `<span>후면 초광각 (Wide 0.5x)</span><span>${isUltraSel ? '● WIDE 0.5x' : 'WIDE 0.5x'}</span>`;
            btnUltra.onclick = async () => {
                currentFacingMode = 'environment';
                currentVideoDeviceId = ultraWideDev.deviceId;
                isLocalCamEnabled = true;
                closeCamModal();
                await acquireMediaStream(ultraWideDev.deviceId, 'environment');
                setLocalCamEnabled(true);
            };
            container.appendChild(btnUltra);
        }

        // 4) 외장 카메라
        externalDevs.forEach((dev) => {
            const isExtSel = isLocalCamEnabled && (currentVideoDeviceId === dev.deviceId);
            const btnExt = document.createElement('button');
            btnExt.className = 'cam-item' + (isExtSel ? ' selected' : '');
            btnExt.innerHTML = `<span>외장 카메라 (${dev.label})</span><span>${isExtSel ? '● EXT' : 'EXT'}</span>`;
            btnExt.onclick = async () => {
                currentVideoDeviceId = dev.deviceId;
                isLocalCamEnabled = true;
                closeCamModal();
                await acquireMediaStream(dev.deviceId, null);
                setLocalCamEnabled(true);
            };
            container.appendChild(btnExt);
        });

        // 5) 카메라 끄기 (Video OFF)
        const isOffSel = !isLocalCamEnabled;
        const btnOff = document.createElement('button');
        btnOff.className = 'cam-item' + (isOffSel ? ' selected' : '');
        btnOff.style.borderColor = isOffSel ? '#f59e0b' : '#2e2e38';
        btnOff.style.color = isOffSel ? '#fbbf24' : '#f87171';
        btnOff.innerHTML = `<span>카메라 끄기 (Video OFF)</span><span>${isOffSel ? '● OFF' : 'OFF'}</span>`;
        btnOff.onclick = () => {
            setLocalCamEnabled(false);
            closeCamModal();
            showFloatingMsg('내 카메라가 꺼졌습니다 (오디오만 유지)');
        };
        container.appendChild(btnOff);
    } catch (e) {
        console.error('Device enumeration error:', e);
    }

    modal.style.display = 'flex';
};

window.closeCamModal = function() {
    document.getElementById('camModal').style.display = 'none';
};

// =====================================================
// 7. 뷰어(MONITOR) 상단 카메라 전환 (지휘자 / 합창단)
// =====================================================
window.selectViewerChannel = function(channel) {
    activeViewerChannel = channel;

    ['chMasterFront', 'chMasterRear'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });

    if (channel === 'master-front') {
        document.getElementById('chMasterFront').classList.add('active');
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'front' });
        updateVideoLayout();
        showFloatingMsg('지휘자 (전면) 뷰');
    } else if (channel === 'master-rear') {
        document.getElementById('chMasterRear').classList.add('active');
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'rear-wide' });
        updateVideoLayout();
        showFloatingMsg('합창단 (후면) 뷰');
    }
};

// =====================================================
// 8. 깔끔한 비디오 회전 / 배율 / 반전
// =====================================================
window.rotateRemoteVideo = function() {
    remoteRotation = (remoteRotation + 90) % 360;
    applyVideoTransform();
};

window.zoomRemoteVideo = function() {
    const levels = [1, 1.4, 1.8, 2.2];
    const nextIdx = (levels.indexOf(remoteZoom) + 1) % levels.length;
    remoteZoom = levels[nextIdx];
    document.getElementById('zoomBtn').innerText = remoteZoom + 'x';
    applyVideoTransform();
};

window.mirrorRemoteVideo = function() {
    remoteMirrored = !remoteMirrored;
    applyVideoTransform();
};

function applyVideoTransform() {
    const scaleX = remoteMirrored ? -remoteZoom : remoteZoom;
    const scaleY = remoteZoom;
    remoteVideo.style.transform = `rotate(${remoteRotation}deg) scale(${scaleX}, ${scaleY})`;
}

// =====================================================
// 9. 절대 안전 오디오 제어 (컴팩트 텍스트 & 하울링 원천 차단)
// =====================================================
window.toggleRemoteAudio = async function() {
    isRemoteAudioMuted = !isRemoteAudioMuted;
    initAudioBooster();
    applyRemoteAudioState();

    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack && audioTrack.applyConstraints) {
            try {
                await audioTrack.applyConstraints({
                    echoCancellation: !isRemoteAudioMuted || !isMusicRawMode,
                    noiseSuppression: !isRemoteAudioMuted || !isMusicRawMode
                });
            } catch (e) {}
        }
    }
};

function applyRemoteAudioState() {
    remoteVideo.muted = true;
    localVideo.muted = true;
    peekVideo.muted = true;

    if (remoteGainNode) {
        remoteGainNode.gain.value = isRemoteAudioMuted ? 0 : 1.0;
    }

    for (const id in peerStreams) {
        peerStreams[id].getAudioTracks().forEach(track => {
            track.enabled = !isRemoteAudioMuted;
        });
    }

    const btn = document.getElementById('btnSpeaker');
    const icon = document.getElementById('iconSpeaker');
    const label = document.getElementById('labelSpeaker');

    if (isRemoteAudioMuted) {
        btn.className = 'dock-btn safe-muted';
        icon.innerText = 'volume_off';
        label.innerText = 'MUTE';
    } else {
        btn.className = 'dock-btn live-warn';
        icon.innerText = 'volume_up';
        label.innerText = 'SPK';
    }
}

window.toggleLocalMic = function() {
    isLocalMicEnabled = !isLocalMicEnabled;
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = isLocalMicEnabled;
        });
    }
    updateMicUI();
};

function updateMicUI() {
    const btn = document.getElementById('btnMic');
    const icon = document.getElementById('iconMic');
    const label = document.getElementById('labelMic');

    if (isLocalMicEnabled) {
        btn.className = 'dock-btn';
        icon.innerText = 'mic';
        label.innerText = 'MIC';
    } else {
        btn.className = 'dock-btn mic-off';
        icon.innerText = 'mic_off';
        label.innerText = 'OFF';
    }
}

window.toggleMusicAudioMode = async function() {
    isMusicRawMode = !isMusicRawMode;
    updateMusicModeUI();
    await acquireMediaStream(currentVideoDeviceId, currentFacingMode);
};

function updateMusicModeUI() {
    const btn = document.getElementById('btnMusicMode');
    const label = document.getElementById('labelMusicMode');
    label.innerText = isMusicRawMode ? 'RAW' : 'STD';
    btn.className = isMusicRawMode ? 'dock-btn master-only pip-active' : 'dock-btn master-only';
}

// =====================================================
// 10. 스텔스 화면 모드 전환 (TIMER / VIEW / DIM)
// =====================================================
let previousDisplayMode = 'stealth';

window.setDisplayMode = function(mode) {
    if (mode !== 'blackout') {
        previousDisplayMode = mode;
    }
    displayMode = mode;

    const stealthDeck = document.getElementById('stealthDeck');
    const blackoutOverlay = document.getElementById('blackoutOverlay');
    const viewerTools = document.getElementById('viewerTools');
    const channelBar = document.getElementById('channelBar');

    document.getElementById('btnStealthMode').classList.toggle('active', mode === 'stealth');
    document.getElementById('btnVideoMode').classList.toggle('active', mode === 'video');
    document.getElementById('btnBlackoutMode').classList.toggle('active', mode === 'blackout');

    if (mode === 'stealth') {
        stealthDeck.style.display = 'flex';
        blackoutOverlay.style.display = 'none';
        viewerTools.style.display = 'none';
        channelBar.style.display = 'none';
        updateVideoLayout();
    } else if (mode === 'video') {
        stealthDeck.style.display = 'none';
        blackoutOverlay.style.display = 'none';
        // 우측 [회전 / 1x 줌 / 좌우반전] 툴바는 VIEW 모드일 때 마스터와 모니터 모두에게 항상 표시!
        viewerTools.style.display = 'flex';
        channelBar.style.display = (myRole === 'monitor') ? 'flex' : 'none';
        updateVideoLayout();
    } else if (mode === 'blackout') {
        blackoutOverlay.style.display = 'flex';
    }
};

function setupPeekHoldEvents() {
    const timerEl = document.getElementById('elapsedTimer');
    const peekOverlay = document.getElementById('peekOverlay');

    const showPeek = (e) => {
        if (e.cancelable) e.preventDefault();
        const monitorStream = getStreamByRole('monitor') || getFirstRemoteStream();
        assignVideoSrc(peekVideo, monitorStream || localStream);
        peekOverlay.style.display = 'flex';
    };
    const hidePeek = () => {
        peekOverlay.style.display = 'none';
    };

    timerEl.addEventListener('touchstart', showPeek, { passive: false });
    timerEl.addEventListener('touchend', hidePeek);
    timerEl.addEventListener('touchcancel', hidePeek);
    timerEl.addEventListener('mousedown', showPeek);
    window.addEventListener('mouseup', hidePeek);
}

// 디머(DIM) 화면에서 아무 곳이나 한 번만 터치해도 즉시 직전 화면(TIMER 또는 VIEW)으로 복귀!
window.handleBlackoutTap = function(e) {
    if (e && e.cancelable) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    setDisplayMode(previousDisplayMode || (myRole === 'monitor' ? 'video' : 'stealth'));
};

window.swapMainAndPip = function() {
    if (displayMode === 'stealth') return;
    isSwappedPip = !isSwappedPip;
    updateVideoLayout();
};

function setSyncStatus(state, text) {
    document.getElementById('syncDot').className = 'sync-dot ' + state;
    document.getElementById('syncText').innerText = text;
}

// =====================================================
// 11. 무음 메모 & 원격 렌즈 전환
// =====================================================
window.toggleNotePopup = function() {
    const popup = document.getElementById('notePopup');
    const isVisible = popup.style.display === 'flex';
    popup.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible) document.getElementById('noteInput').focus();
};

window.sendNote = function() {
    const input = document.getElementById('noteInput');
    const msg = input.value.trim();
    if (!msg) return;

    if (roomId) {
        socket.emit('room-event', { roomId, type: 'note', data: msg });
    }
    displayIncomingNote(msg);
    input.value = '';
    document.getElementById('notePopup').style.display = 'none';
};

socket.on('room-event', async (payload) => {
    if (payload.type === 'note') {
        displayIncomingNote(payload.data);
    } else if (payload.type === 'set-master-cam' && myRole === 'master') {
        if (payload.mode === 'front') {
            currentFacingMode = 'user';
            currentVideoDeviceId = null;
            await acquireMediaStream(null, 'user');
        } else if (payload.mode === 'rear-wide') {
            const ultraWideId = await findUltraWideRearDeviceId();
            currentFacingMode = 'environment';
            currentVideoDeviceId = ultraWideId;
            await acquireMediaStream(ultraWideId, 'environment');
        }
    }
});

async function findUltraWideRearDeviceId() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        const ultra = videoDevices.find(d => {
            const l = (d.label || '').toLowerCase();
            return l.includes('ultra') || l.includes('초광각') || l.includes('0.5');
        });
        return ultra ? ultra.deviceId : null;
    } catch (e) {
        return null;
    }
}

function displayIncomingNote(msg) {
    const noteBar = document.getElementById('stealthNoteBar');
    const noteText = document.getElementById('stealthNoteText');
    if (noteText) noteText.innerText = msg;

    if (noteBar) {
        noteBar.classList.add('new-msg');
        setTimeout(() => noteBar.classList.remove('new-msg'), 6000);
    }

    // 상단 플로팅 배너에도 10초 동안 선명하게 표시 (클릭하면 즉시 닫힘)
    showFloatingMsg('💬 ' + msg, 10000);
}

let floatingTimer = null;
function showFloatingMsg(msg, duration = 4000) {
    const el = document.getElementById('floatingMsg');
    if (!el) return;
    el.innerText = msg;
    el.style.display = 'block';
    el.onclick = () => { el.style.display = 'none'; };
    clearTimeout(floatingTimer);
    floatingTimer = setTimeout(() => {
        el.style.display = 'none';
    }, duration);
}

// =====================================================
// 12. 리허설 타이머 & WakeLock
// =====================================================
function startTimers() {
    if (chronoInterval) clearInterval(chronoInterval);
    chronoInterval = setInterval(() => {
        const now = new Date();
        document.getElementById('realClock').innerText = now.toTimeString().split(' ')[0];

        if (chronoRunning) {
            chronoSeconds++;
            const mins = String(Math.floor(chronoSeconds / 60)).padStart(2, '0');
            const secs = String(chronoSeconds % 60).padStart(2, '0');
            document.getElementById('elapsedTimer').innerText = `${mins}:${secs}`;
        }
    }, 1000);
}

window.toggleChrono = function() {
    chronoRunning = !chronoRunning;
    document.getElementById('chronoToggleBtn').innerText = chronoRunning ? 'PAUSE' : 'RESUME';
};

window.resetChrono = function() {
    chronoSeconds = 0;
    document.getElementById('elapsedTimer').innerText = '00:00';
};

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (e) {}
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        requestWakeLock();
    }
});
