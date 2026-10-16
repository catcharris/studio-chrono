const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// 상태 변수
let roomId = '';
let myRole = 'master'; // 'master' (지휘자) | 'monitor' (뷰어)
let localStream = null;
let remoteStream = null;
let peers = {}; // socketId -> RTCPeerConnection

// 오디오/비디오 제어 상태
let isRemoteAudioMuted = true; // MASTER 입장 시 100% 스피커 음소거가 기본값!
let isLocalMicEnabled = true;
let isMusicRawMode = true; // 합창 원음 모드 (노이즈 억제 해제)
let currentVideoDeviceId = null;
let currentFacingMode = 'user'; // 'user' (전면) | 'environment' (후면)

// 화면 모드 및 뷰어 변형 상태
let displayMode = 'stealth'; // 'stealth' | 'video' | 'blackout'
let stealthPipVisible = false;
let isSwappedPip = false;
let remoteRotation = 0;
let remoteZoom = 1;
let remoteMirrored = false;

// 타이머 & WakeLock
let chronoSeconds = 0;
let chronoRunning = true;
let chronoInterval = null;
let wakeLock = null;

// WebRTC STUN 설정
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// DOM 요소 참조
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const peekVideo = document.getElementById('peekVideo');
const pipBox = document.getElementById('pipBox');

// =====================================================
// 1. 세션 시작 (MASTER vs MONITOR)
// =====================================================
window.startSession = async function(role) {
    const inputVal = document.getElementById('sessionInput').value.trim();
    if (!inputVal) return alert('Enter Session Code');

    roomId = inputVal;
    myRole = role;

    // 역할별 초기 안전 설정
    if (myRole === 'master') {
        // 지휘자는 연습 중 절대 상대방 소리가 나면 안 되므로 무조건 MUTE로 시작!
        isRemoteAudioMuted = true;
        isMusicRawMode = true;
        displayMode = 'stealth';
    } else {
        // 모니터(뷰어)는 지휘자의 합창/지휘 소리를 바로 들어야 하므로 UNMUTE로 시작
        isRemoteAudioMuted = false;
        isMusicRawMode = false;
        displayMode = 'video';
    }

    document.getElementById('lobbyStatus').innerText = 'INITIALIZING SENSORS...';

    try {
        await acquireMediaStream();
        await requestWakeLock();

        // UI 전환
        document.getElementById('lobbyScreen').style.display = 'none';
        document.getElementById('mainScreen').style.display = 'block';

        applyRemoteAudioState();
        updateMicUI();
        updateMusicModeUI();
        setDisplayMode(displayMode);
        startTimers();
        setupPeekHoldEvents();

        // 소켓 방 입장
        setSyncStatus('connecting', 'WAIT SYNC');
        socket.emit('join-room', { roomId, role: myRole });

        // 기기 연결/해제 감지 (Insta360 X5 USB 연결 시 즉시 감지)
        if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
            navigator.mediaDevices.ondevicechange = () => {
                console.log('Media devices changed');
            };
        }
    } catch (err) {
        console.error('Media init error:', err);
        alert('카메라/마이크 접근 권한을 허용해주세요.');
        document.getElementById('lobbyStatus').innerText = 'PERMISSION DENIED';
    }
};

// =====================================================
// 2. 카메라 & 오디오 스트림 획득 (아이폰 + Insta360 X5 지원)
// =====================================================
async function acquireMediaStream(deviceId = null, facingMode = 'user') {
    // 기존 트랙 정지
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    const videoConstraints = {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 }
    };

    if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
    } else {
        videoConstraints.facingMode = { ideal: facingMode };
    }

    const audioConstraints = isMusicRawMode
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        : {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          };

    localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints
    });

    // 내 마이크 ON/OFF 상태 유지
    localStream.getAudioTracks().forEach(track => {
        track.enabled = isLocalMicEnabled;
    });

    // 현재 사용 중인 비디오 트랙 설정 저장
    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) {
        const settings = vTrack.getSettings();
        currentVideoDeviceId = settings.deviceId || deviceId;
        // 전면 카메라일 때만 내 프리뷰 거울 반전
        const isFront = !deviceId && facingMode === 'user';
        localVideo.style.transform = isFront ? 'scaleX(-1)' : 'scaleX(1)';
        document.getElementById('labelCam').innerText = getShortCamName(vTrack.label);
    }

    renderStreamsToVideoElements();

    // 이미 연결된 Peer가 있다면 끊김 없이 트랙만 교체 (replaceTrack)
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

    // 비디오 비트레이트 최적화 적용
    optimizeSenderBitrate();
}

function getShortCamName(label) {
    if (!label) return 'SENSOR';
    const lower = label.toLowerCase();
    if (lower.includes('insta360') || lower.includes('x5') || lower.includes('usb')) return 'EXT (X5)';
    if (lower.includes('back') || lower.includes('후면') || lower.includes('environment')) return 'REAR';
    if (lower.includes('front') || lower.includes('전면') || lower.includes('facetime')) return 'FRONT';
    return 'CAM';
}

// =====================================================
// 3. 카메라 센서 선택 모달 (아이폰 전면 / 후면 / Insta360 X5)
// =====================================================
window.openCamModal = async function() {
    const modal = document.getElementById('camModal');
    const container = document.getElementById('camListContainer');
    container.innerHTML = '';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        // 1) 기본 전면/후면 빠른 전환 버튼 제공 (iOS Safari 호환성 보장)
        const quickFront = document.createElement('button');
        quickFront.className = 'cam-item' + (currentFacingMode === 'user' && !currentVideoDeviceId ? ' selected' : '');
        quickFront.innerHTML = `<span>Front Sensor (전면)</span><span>USER</span>`;
        quickFront.onclick = async () => {
            currentFacingMode = 'user';
            currentVideoDeviceId = null;
            closeCamModal();
            await acquireMediaStream(null, 'user');
        };
        container.appendChild(quickFront);

        const quickRear = document.createElement('button');
        quickRear.className = 'cam-item' + (currentFacingMode === 'environment' && !currentVideoDeviceId ? ' selected' : '');
        quickRear.innerHTML = `<span>Rear Sensor (후면)</span><span>ENV</span>`;
        quickRear.onclick = async () => {
            currentFacingMode = 'environment';
            currentVideoDeviceId = null;
            closeCamModal();
            await acquireMediaStream(null, 'environment');
        };
        container.appendChild(quickRear);

        // 2) 개별 하드웨어 카메라 목록 (Insta360 X5 등 외장 UVC 웹캠 포함)
        videoDevices.forEach((dev, idx) => {
            const btn = document.createElement('button');
            const isSel = dev.deviceId && dev.deviceId === currentVideoDeviceId;
            btn.className = 'cam-item' + (isSel ? ' selected' : '');
            const name = dev.label || `Camera Sensor #${idx + 1}`;
            btn.innerHTML = `<span>${name}</span><span>${isSel ? '●' : ''}</span>`;
            btn.onclick = async () => {
                currentVideoDeviceId = dev.deviceId;
                closeCamModal();
                await acquireMediaStream(dev.deviceId, null);
            };
            container.appendChild(btn);
        });
    } catch (e) {
        console.error('Device enumeration error:', e);
    }

    modal.style.display = 'flex';
};

window.closeCamModal = function() {
    document.getElementById('camModal').style.display = 'none';
};

// =====================================================
// 4. 절대 안전 오디오 제어 (상대 소리 Mute & 내 마이크 Mute)
// =====================================================
window.toggleRemoteAudio = function() {
    isRemoteAudioMuted = !isRemoteAudioMuted;
    applyRemoteAudioState();
};

function applyRemoteAudioState() {
    // 1) HTMLMediaElement 자체를 muted 처리
    remoteVideo.muted = isRemoteAudioMuted;
    localVideo.muted = true; // 로컬 프리뷰는 항상 에코 방지를 위해 뮤트
    peekVideo.muted = true;

    // 2) 이중 안전장치: 원격 오디오 트랙 자체의 enabled 속성까지 제어
    if (remoteStream) {
        remoteStream.getAudioTracks().forEach(track => {
            track.enabled = !isRemoteAudioMuted;
        });
    }

    // UI 업데이트
    const btn = document.getElementById('btnSpeaker');
    const icon = document.getElementById('iconSpeaker');
    const label = document.getElementById('labelSpeaker');

    if (isRemoteAudioMuted) {
        btn.className = 'dock-btn safe-muted';
        icon.innerText = 'volume_off';
        label.innerText = 'SPK: MUTE';
    } else {
        btn.className = 'dock-btn live-warn';
        icon.innerText = 'volume_up';
        label.innerText = 'SPK: ON';
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
        label.innerText = 'MIC: ON';
    } else {
        btn.className = 'dock-btn mic-off';
        icon.innerText = 'mic_off';
        label.innerText = 'MIC: OFF';
    }
}

window.toggleMusicAudioMode = async function() {
    isMusicRawMode = !isMusicRawMode;
    updateMusicModeUI();
    await acquireMediaStream(currentVideoDeviceId, currentFacingMode);
};

function updateMusicModeUI() {
    const label = document.getElementById('labelMusicMode');
    label.innerText = isMusicRawMode ? 'RAW: ON' : 'RAW: OFF';
}

// =====================================================
// 5. 스텔스 화면 모드 전환 (TIMER / VIEW / DIM)
// =====================================================
window.setDisplayMode = function(mode) {
    displayMode = mode;

    const stealthDeck = document.getElementById('stealthDeck');
    const blackoutOverlay = document.getElementById('blackoutOverlay');
    const viewerTools = document.getElementById('viewerTools');

    document.getElementById('btnStealthMode').classList.toggle('active', mode === 'stealth');
    document.getElementById('btnVideoMode').classList.toggle('active', mode === 'video');
    document.getElementById('btnBlackoutMode').classList.toggle('active', mode === 'blackout');

    if (mode === 'stealth') {
        stealthDeck.style.display = 'flex';
        blackoutOverlay.style.display = 'none';
        viewerTools.style.display = 'none';
        updateStealthPipState();
    } else if (mode === 'video') {
        stealthDeck.style.display = 'none';
        blackoutOverlay.style.display = 'none';
        viewerTools.style.display = 'flex';
        pipBox.classList.remove('stealth-mini', 'hidden-pip');
        renderStreamsToVideoElements();
    } else if (mode === 'blackout') {
        blackoutOverlay.style.display = 'flex';
    }
};

// 스텔스 타이머 모드에서 초소형 PIP 켜기/끄기
window.toggleStealthPip = function() {
    stealthPipVisible = !stealthPipVisible;
    document.getElementById('pipToggleBtn').innerText = stealthPipVisible ? 'PIP: ON' : 'PIP: OFF';
    updateStealthPipState();
};

function updateStealthPipState() {
    if (displayMode !== 'stealth') return;
    if (stealthPipVisible) {
        pipBox.classList.remove('hidden-pip');
        pipBox.classList.add('stealth-mini');
        // 스텔스 PIP가 켜지면 작은 창에 상대방 얼굴을 은밀하게 표시
        localVideo.srcObject = remoteStream || localStream;
        document.getElementById('pipLabel').innerText = remoteStream ? 'MON' : 'CAM';
    } else {
        pipBox.classList.add('hidden-pip');
    }
}

// 타이머 숫자를 누르고 있는 동안에만(Hold) 상대방 모습을 크게 보여주는 시크릿 Peek 기능
function setupPeekHoldEvents() {
    const timerEl = document.getElementById('elapsedTimer');
    const peekOverlay = document.getElementById('peekOverlay');

    const showPeek = (e) => {
        if (e.cancelable) e.preventDefault();
        peekVideo.srcObject = remoteStream || localStream;
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

// 블랙아웃(완전 암전) 화면에서 더블탭 시 복귀
let lastBlackoutTap = 0;
window.handleBlackoutTap = function() {
    const now = Date.now();
    if (now - lastBlackoutTap < 350) {
        setDisplayMode(myRole === 'master' ? 'stealth' : 'video');
    }
    lastBlackoutTap = now;
};

// 메인 화면과 PIP 화면 맞바꾸기
window.swapMainAndPip = function() {
    if (displayMode === 'stealth') return;
    isSwappedPip = !isSwappedPip;
    renderStreamsToVideoElements();
};

function renderStreamsToVideoElements() {
    if (displayMode === 'stealth') {
        updateStealthPipState();
        return;
    }

    if (!isSwappedPip) {
        remoteVideo.srcObject = remoteStream || localStream;
        localVideo.srcObject = localStream;
        document.getElementById('pipLabel').innerText = 'LOCAL';
    } else {
        remoteVideo.srcObject = localStream;
        localVideo.srcObject = remoteStream;
        document.getElementById('pipLabel').innerText = 'REMOTE';
    }
    applyRemoteAudioState();
}

// =====================================================
// 6. 모니터(뷰어) 전용 화면 회전 / 줌 / 원격 카메라 전환
// =====================================================
window.rotateRemoteVideo = function() {
    remoteRotation = (remoteRotation + 90) % 360;
    applyVideoTransform();
};

window.zoomRemoteVideo = function() {
    const levels = [1, 1.4, 1.8, 2.4];
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

// 모니터 쪽에서 지휘자 카메라 전환(전면 <-> 후면/X5) 원격 요청 가능
window.requestRemoteCamSwitch = function() {
    if (!roomId) return;
    socket.emit('room-event', { roomId, type: 'switch-cam' });
    showFloatingMsg('REQUESTED SENSOR SWITCH');
};

// =====================================================
// 7. WebRTC 시그널링 & 자동 재연결 & 대역폭 최적화
// =====================================================
socket.on('connect', () => {
    // 네트워크 순단 후 재접속 시 자동으로 방에 다시 조인하여 스트림 복구
    if (roomId) {
        setSyncStatus('connecting', 'RE-SYNCING');
        socket.emit('join-room', { roomId, role: myRole });
    }
});

socket.on('existing-peers', async (peerList) => {
    for (const peer of peerList) {
        await initiateCall(peer.id);
    }
});

socket.on('user-connected', async (peer) => {
    console.log('Peer joined:', peer.id);
    setSyncStatus('connecting', 'LINKING...');
});

socket.on('user-disconnected', (peerId) => {
    if (peers[peerId]) {
        peers[peerId].close();
        delete peers[peerId];
    }
    if (Object.keys(peers).length === 0) {
        remoteStream = null;
        setSyncStatus('connecting', 'STANDBY');
        renderStreamsToVideoElements();
    }
});

async function initiateCall(targetId) {
    const pc = createPeerConnection(targetId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', {
        target: targetId,
        caller: socket.id,
        sdp: pc.localDescription
    });
}

socket.on('offer', async (payload) => {
    const pc = createPeerConnection(payload.caller);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', {
        target: payload.caller,
        caller: socket.id,
        sdp: pc.localDescription
    });
});

socket.on('answer', async (payload) => {
    const pc = peers[payload.caller];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    }
});

socket.on('ice-candidate', async (incoming) => {
    const pc = peers[incoming.sender];
    if (pc && incoming.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(incoming.candidate));
        } catch (e) {
            console.error('ICE candidate error:', e);
        }
    }
});

function createPeerConnection(targetId) {
    if (peers[targetId]) {
        peers[targetId].close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
            remoteStream = event.streams[0];
            setSyncStatus('online', 'SYNC LOCKED');
            renderStreamsToVideoElements();
            applyRemoteAudioState();
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
            setSyncStatus('online', 'SYNC LOCKED');
            optimizeSenderBitrate();
        } else if (state === 'disconnected' || state === 'failed') {
            setSyncStatus('connecting', 'RECONNECTING');
        }
    };

    return pc;
}

// 교회 Wi-Fi 환경에서 끊김 없는 전송을 위한 적응형 비트레이트 제한 (최대 1.2Mbps)
async function optimizeSenderBitrate() {
    for (const peerId in peers) {
        const pc = peers[peerId];
        const senders = pc.getSenders();
        for (const sender of senders) {
            if (sender.track && sender.track.kind === 'video' && sender.getParameters) {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.encodings[0].maxBitrate = 1200 * 1000; // 1.2 Mbps 상한으로 버퍼링 방지
                    params.encodings[0].maxFramerate = 30;
                    await sender.setParameters(params);
                } catch (e) {
                    // 일부 모바일 브라우저 미지원 시 무시
                }
            }
        }
    }
}

function setSyncStatus(state, text) {
    const dot = document.getElementById('syncDot');
    const label = document.getElementById('syncText');
    dot.className = 'sync-dot ' + state;
    label.innerText = text;
}

// =====================================================
// 8. 무음 메모 소통 & 원격 카메라 전환 이벤트
// =====================================================
window.toggleNotePopup = function() {
    const popup = document.getElementById('notePopup');
    const isVisible = popup.style.display === 'flex';
    popup.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible) {
        document.getElementById('noteInput').focus();
    }
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
    } else if (payload.type === 'switch-cam' && myRole === 'master') {
        // 모니터가 카메라 전환을 요청하면 전면 <-> 후면 즉시 스위칭
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
        currentVideoDeviceId = null;
        await acquireMediaStream(null, currentFacingMode);
    }
});

function displayIncomingNote(msg) {
    // 1) 스텔스 타이머 하단 악보 메모란에 조용히 업데이트
    const noteText = document.getElementById('stealthNoteText');
    if (noteText) noteText.innerText = msg;

    // 2) 비디오 모드일 때는 상단 캡션으로 4초간 표시
    showFloatingMsg(msg);
}

let floatingTimer = null;
function showFloatingMsg(msg) {
    const el = document.getElementById('floatingMsg');
    el.innerText = msg;
    el.style.display = 'block';
    clearTimeout(floatingTimer);
    floatingTimer = setTimeout(() => {
        el.style.display = 'none';
    }, 4500);
}

// =====================================================
// 9. 리허설 타이머 & 화면 꺼짐 방지 (WakeLock)
// =====================================================
function startTimers() {
    if (chronoInterval) clearInterval(chronoInterval);
    chronoInterval = setInterval(() => {
        // 현재 시각 표시
        const now = new Date();
        document.getElementById('realClock').innerText = now.toTimeString().split(' ')[0];

        // 경과 타이머 표시
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
        } catch (e) {
            console.log('WakeLock non-critical error:', e);
        }
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        requestWakeLock();
    }
});
