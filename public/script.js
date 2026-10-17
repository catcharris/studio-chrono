const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// =====================================================
// 0. iOS 사파리 페이지 전체 확대(Pinch/Double-tap Zoom) 100% 원천 차단!
// =====================================================
document.addEventListener('gesturestart', function(e) {
    e.preventDefault();
}, { passive: false });

document.addEventListener('gesturechange', function(e) {
    e.preventDefault();
}, { passive: false });

document.addEventListener('gestureend', function(e) {
    e.preventDefault();
}, { passive: false });

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
let myRole = 'master'; // 'master' (지휘자) | 'monitor' (뷰어) | 'aux' (합창단/X5 보조 카메라)
let localStream = null;

// 멀티 피어 및 스트림 관리
const peers = {};       // socketId -> RTCPeerConnection
const peerRoles = {};   // socketId -> 'master' | 'monitor' | 'aux'
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
let isPipVisible = false; // 마스터는 기본 PIP 숨김(OFF), 필요할 때만 켜서 확인!
let isSwappedPip = false;
let currentExt360Url = '';

// 비디오 회전 / 배율 상태
let remoteRotation = 0;
let remoteZoom = 1;
let remoteMirrored = false;

// Three.js 360° VR Sphere 변수
let vrScene = null;
let vrCamera = null;
let vrRenderer = null;
let vrSphereMesh = null;
let vrVideoTexture = null;
let vrIsActive = false;
let vrLon = 0;
let vrLat = 0;
let vrFov = 75;

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
const auxPipVideo = document.getElementById('auxPipVideo');
const peekVideo = document.getElementById('peekVideo');
const pipBox = document.getElementById('pipBox');
const auxPipBox = document.getElementById('auxPipBox');

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
        remoteGainNode.gain.value = isRemoteAudioMuted ? 0 : 2.0;
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
// 1. 세션 시작 (MASTER / MONITOR / AUX 역할별 UI 완벽 분리!)
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
        isPipVisible = false; // 마스터는 처음에는 PIP가 안 보이게 시작 (필요할 때만 버튼으로 켬!)
    } else if (myRole === 'aux') {
        isRemoteAudioMuted = true;
        isMusicRawMode = true;
        currentFacingMode = 'environment';
        displayMode = 'stealth';
        isPipVisible = false;
    } else {
        // MONITOR (뷰어)
        isRemoteAudioMuted = false;
        isMusicRawMode = false;
        currentFacingMode = 'user';
        displayMode = 'video';
        isPipVisible = true; // 모니터는 본인 얼굴 PIP 기본 표시 (원하면 PIP 버튼으로 끌 수 있음)
    }

    document.getElementById('lobbyStatus').innerText = 'INITIALIZING SENSORS...';

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

    // 역할별 전용 버튼 노출/숨김 처리 (모니터 화면에서 불필요한 마스터 버튼 완전 제거!)
    configureRoleSpecificUI();

    applyRemoteAudioState();
    updateMicUI();
    updateMusicModeUI();
    updatePipButtonUI();
    setDisplayMode(displayMode);
    startTimers();
    setupPeekHoldEvents();

    setSyncStatus('connecting', 'WAIT SYNC');
    socket.emit('join-room', { roomId, role: myRole });
};

function configureRoleSpecificUI() {
    const isMasterOrAux = (myRole === 'master' || myRole === 'aux');

    // 1) 상단 우측 TIMER / VIEW / DIM 스위처는 마스터에게만 표시 (모니터 화면에선 숨김!)
    document.getElementById('masterModeSwitcher').style.display = isMasterOrAux ? 'flex' : 'none';

    // 2) 하단 독의 마스터 전용 버튼들(SENSOR, RAW, X5 360)은 모니터 화면에서 모두 숨김!
    document.querySelectorAll('.master-only').forEach(el => {
        el.style.display = isMasterOrAux ? 'flex' : 'none';
    });
}

// =====================================================
// 2. PIP 화면 켜기 / 끄기 토글 (필요할 때만 띄우기)
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
        label.innerText = 'PIP: ON';
    } else {
        btn.className = 'dock-btn';
        label.innerText = 'PIP: OFF';
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

    const audioConstraints = isMusicRawMode
        ? { autoGainControl: false, noiseSuppression: false }
        : { autoGainControl: true, noiseSuppression: true, echoCancellation: true };

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
    if (lower.includes('insta360') || lower.includes('x5') || lower.includes('usb')) return 'EXT (X5)';
    if (lower.includes('ultra') || lower.includes('초광각') || lower.includes('0.5')) return '0.5x WIDE';
    if (lower.includes('back') || lower.includes('후면')) return 'REAR';
    if (lower.includes('front') || lower.includes('전면')) return 'FRONT';
    return 'CAM';
}

// =====================================================
// 4. 화면 배치 로직 (마스터 PIP 제어 & 모니터 깔끔한 뷰)
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
    const auxStream = getStreamByRole('aux');
    const monitorStream = getStreamByRole('monitor');
    const anyRemoteStream = getFirstRemoteStream();

    const badgeMaster = document.getElementById('badgeMaster');
    const badgeAux = document.getElementById('badgeAux');
    if (badgeMaster) badgeMaster.classList.toggle('live', !!(masterStream || anyRemoteStream));
    if (badgeAux) badgeAux.classList.toggle('live', !!auxStream);

    // 1) 마스터 스텔스 타이머 모드일 때:
    // PIP 버튼을 켰을 때만(isPipVisible === true) 원격 접속자(모니터) 화면을 작은 PIP로 띄움!
    if (displayMode === 'stealth') {
        auxPipBox.classList.add('hidden-pip');
        if (isPipVisible) {
            pipBox.classList.remove('hidden-pip');
            pipBox.classList.add('stealth-mini');
            const targetPip = monitorStream || anyRemoteStream || localStream;
            assignVideoSrc(localVideo, targetPip);
            localVideo.style.transform = (monitorStream || anyRemoteStream) ? 'scaleX(1)' : 'scaleX(-1)';
            document.getElementById('pipLabel').innerText = (monitorStream || anyRemoteStream) ? 'MON' : 'MY CAM';
        } else {
            pipBox.classList.add('hidden-pip');
        }
        return;
    }

    // 2) VIEW 모드일 때:
    pipBox.classList.remove('stealth-mini');

    if (myRole === 'monitor') {
        // [모니터(뷰어) 화면]
        let mainTarget = (activeViewerChannel === 'aux' && auxStream)
            ? auxStream
            : (masterStream || anyRemoteStream || auxStream || null);

        let secondaryTarget = (auxStream && mainTarget !== auxStream) ? auxStream : null;

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

        // 모니터도 하단 PIP: ON/OFF 버튼으로 본인 PIP를 숨기거나 켤 수 있음
        if (isPipVisible) {
            pipBox.classList.remove('hidden-pip');
        } else {
            pipBox.classList.add('hidden-pip');
        }

        if (secondaryTarget && isPipVisible) {
            assignVideoSrc(auxPipVideo, secondaryTarget);
            auxPipBox.classList.remove('hidden-pip');
            document.getElementById('auxPipLabel').innerText = 'CAM 2';
        } else {
            auxPipBox.classList.add('hidden-pip');
        }
    } else {
        // [마스터(지휘자)가 VIEW 모드를 켰을 때]
        // 큰 화면 = 원격 접속자(모니터) 화면 (또는 내 카메라), PIP는 PIP: ON일 때만 표시!
        const targetRemote = monitorStream || anyRemoteStream || null;

        if (!isSwappedPip) {
            assignVideoSrc(remoteVideo, targetRemote || localStream);
            assignVideoSrc(localVideo, localStream);
            localVideo.style.transform = 'scaleX(-1)';
            document.getElementById('pipLabel').innerText = 'MY CAM';
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
        auxPipBox.classList.add('hidden-pip');
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

    setSyncStatus('connecting', 'LINKING...');

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
        setSyncStatus('online', 'SYNC LOCKED');
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
        setSyncStatus('connecting', 'STANDBY');
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
        setSyncStatus('online', 'SYNC LOCKED');
        updateVideoLayout();
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            setSyncStatus('online', 'SYNC LOCKED');
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
// 6. 카메라 센서 선택 모달 (마스터용)
// =====================================================
window.openCamModal = async function() {
    const modal = document.getElementById('camModal');
    const container = document.getElementById('camListContainer');
    container.innerHTML = '';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        const quickFront = document.createElement('button');
        quickFront.className = 'cam-item' + (currentFacingMode === 'user' && !currentVideoDeviceId ? ' selected' : '');
        quickFront.innerHTML = `<span>Front Sensor (지휘자 정면)</span><span>FRONT</span>`;
        quickFront.onclick = async () => {
            currentFacingMode = 'user';
            currentVideoDeviceId = null;
            closeCamModal();
            await acquireMediaStream(null, 'user');
        };
        container.appendChild(quickFront);

        const quickRear = document.createElement('button');
        quickRear.className = 'cam-item' + (currentFacingMode === 'environment' && !currentVideoDeviceId ? ' selected' : '');
        quickRear.innerHTML = `<span>Rear Sensor (합창단 방향)</span><span>REAR</span>`;
        quickRear.onclick = async () => {
            currentFacingMode = 'environment';
            currentVideoDeviceId = null;
            closeCamModal();
            await acquireMediaStream(null, 'environment');
        };
        container.appendChild(quickRear);

        videoDevices.forEach((dev, idx) => {
            const btn = document.createElement('button');
            const isSel = dev.deviceId && dev.deviceId === currentVideoDeviceId;
            btn.className = 'cam-item' + (isSel ? ' selected' : '');
            const name = dev.label || `Sensor #${idx + 1}`;
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
// 7. 뷰어(MONITOR) 상단 멀티캠 채널 전환
// =====================================================
window.selectViewerChannel = function(channel) {
    activeViewerChannel = channel;

    ['chMasterFront', 'chMasterRear', 'chAuxCam', 'ch360Sphere', 'chExt360'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });

    if (channel === 'master-front') {
        document.getElementById('chMasterFront').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'front' });
        updateVideoLayout();
        showFloatingMsg('CAM 1: 지휘자 정면 뷰');
    } else if (channel === 'master-rear') {
        document.getElementById('chMasterRear').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'rear-wide' });
        updateVideoLayout();
        showFloatingMsg('CAM 1-B: 합창단 뷰 전환');
    } else if (channel === 'aux') {
        document.getElementById('chAuxCam').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        updateVideoLayout();
        showFloatingMsg('CAM 2: 보조/X5 카메라 뷰');
    } else if (channel === '360-sphere') {
        document.getElementById('ch360Sphere').classList.add('active');
        hideExt360Embed();
        start360SphereViewer();
        showFloatingMsg('360° VR 모드');
    } else if (channel === 'ext-360') {
        document.getElementById('chExt360').classList.add('active');
        stop360SphereViewer();
        showExt360Embed();
        showFloatingMsg('X5 360° 라이브 스트림');
    }
};

window.swapAuxToMain = function() {
    if (activeViewerChannel === 'aux') {
        selectViewerChannel('master-front');
    } else {
        selectViewerChannel('aux');
    }
};

// =====================================================
// 8. WebGL 360° VR 구체 뷰어
// =====================================================
function start360SphereViewer() {
    const container = document.getElementById('vr360Container');
    container.style.display = 'block';
    vrIsActive = true;

    if (!vrRenderer) {
        vrScene = new THREE.Scene();
        vrCamera = new THREE.PerspectiveCamera(vrFov, window.innerWidth / window.innerHeight, 1, 1100);
        vrCamera.target = new THREE.Vector3(0, 0, 0);

        const geometry = new THREE.SphereGeometry(500, 60, 40);
        geometry.scale(-1, 1, 1);

        vrVideoTexture = new THREE.VideoTexture(remoteVideo);
        vrVideoTexture.minFilter = THREE.LinearFilter;
        vrVideoTexture.magFilter = THREE.LinearFilter;

        const material = new THREE.MeshBasicMaterial({ map: vrVideoTexture });
        vrSphereMesh = new THREE.Mesh(geometry, material);
        vrScene.add(vrSphereMesh);

        vrRenderer = new THREE.WebGLRenderer({ antialias: true });
        vrRenderer.setPixelRatio(window.devicePixelRatio);
        vrRenderer.setSize(window.innerWidth, window.innerHeight);
        container.appendChild(vrRenderer.domElement);

        setup360TouchControls(container);
        window.addEventListener('resize', () => {
            if (!vrCamera || !vrRenderer) return;
            vrCamera.aspect = window.innerWidth / window.innerHeight;
            vrCamera.updateProjectionMatrix();
            vrRenderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    animate360Sphere();
}

function stop360SphereViewer() {
    vrIsActive = false;
    document.getElementById('vr360Container').style.display = 'none';
}

function animate360Sphere() {
    if (!vrIsActive) return;
    requestAnimationFrame(animate360Sphere);

    vrLat = Math.max(-85, Math.min(85, vrLat));
    const phi = THREE.MathUtils.degToRad(90 - vrLat);
    const theta = THREE.MathUtils.degToRad(vrLon);

    vrCamera.target.x = 500 * Math.sin(phi) * Math.cos(theta);
    vrCamera.target.y = 500 * Math.cos(phi);
    vrCamera.target.z = 500 * Math.sin(phi) * Math.sin(theta);
    vrCamera.lookAt(vrCamera.target);

    if (vrRenderer && vrScene && vrCamera) {
        vrRenderer.render(vrScene, vrCamera);
    }
}

function setup360TouchControls(container) {
    let isDown = false;
    let startX = 0, startY = 0;
    let startLon = 0, startLat = 0;

    const onDown = (x, y) => {
        isDown = true;
        startX = x;
        startY = y;
        startLon = vrLon;
        startLat = vrLat;
    };
    const onMove = (x, y) => {
        if (!isDown) return;
        vrLon = (startX - x) * 0.25 + startLon;
        vrLat = (y - startY) * 0.25 + startLat;
    };
    const onUp = () => { isDown = false; };

    container.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);

    container.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            onDown(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: true });

    container.addEventListener('touchmove', e => {
        if (e.touches.length === 1 && isDown) {
            onMove(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: true });

    container.addEventListener('touchend', onUp);
}

// =====================================================
// 9. 깔끔한 비디오 회전 / 배율 / 반전
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
// 10. 외부 X5 360도 라이브 링크 연동
// =====================================================
window.open360LinkModal = function() {
    document.getElementById('ext360Input').value = currentExt360Url;
    document.getElementById('link360Modal').style.display = 'flex';
};

window.close360LinkModal = function() {
    document.getElementById('link360Modal').style.display = 'none';
};

window.applyExt360Url = function() {
    const raw = document.getElementById('ext360Input').value.trim();
    if (!raw) return;
    const embedUrl = convertToEmbedUrl(raw);
    currentExt360Url = embedUrl;
    socket.emit('room-event', { roomId, type: 'ext-360-url', url: embedUrl });
    syncExt360Button(embedUrl);
    close360LinkModal();
    showFloatingMsg('X5 360° 스트림 채널이 활성화되었습니다');
};

window.clearExt360Url = function() {
    currentExt360Url = '';
    document.getElementById('ext360Input').value = '';
    socket.emit('room-event', { roomId, type: 'ext-360-url', url: '' });
    syncExt360Button('');
    hideExt360Embed();
    close360LinkModal();
};

function convertToEmbedUrl(url) {
    try {
        if (url.includes('youtu.be/')) {
            const id = url.split('youtu.be/')[1].split(/[?&]/)[0];
            return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1`;
        }
        if (url.includes('youtube.com/watch')) {
            const u = new URL(url);
            const id = u.searchParams.get('v');
            if (id) return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1`;
        }
        if (url.includes('youtube.com/live/')) {
            const id = url.split('youtube.com/live/')[1].split(/[?&]/)[0];
            return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1`;
        }
    } catch (e) {}
    return url;
}

function syncExt360Button(url) {
    currentExt360Url = url || '';
    const btn = document.getElementById('chExt360');
    if (btn) {
        btn.style.display = currentExt360Url ? 'flex' : 'none';
    }
}

function showExt360Embed() {
    if (!currentExt360Url) return;
    const wrapper = document.getElementById('ext360Wrapper');
    const iframe = document.getElementById('ext360Iframe');
    if (iframe.src !== currentExt360Url) {
        iframe.src = currentExt360Url;
    }
    wrapper.style.display = 'block';
}

function hideExt360Embed() {
    const wrapper = document.getElementById('ext360Wrapper');
    wrapper.style.display = 'none';
}

// =====================================================
// 11. 절대 안전 오디오 제어
// =====================================================
window.toggleRemoteAudio = function() {
    isRemoteAudioMuted = !isRemoteAudioMuted;
    initAudioBooster();
    applyRemoteAudioState();
};

function applyRemoteAudioState() {
    remoteVideo.muted = isRemoteAudioMuted;
    localVideo.muted = true;
    auxPipVideo.muted = true;
    peekVideo.muted = true;

    if (remoteGainNode) {
        remoteGainNode.gain.value = isRemoteAudioMuted ? 0 : 2.0;
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
    document.getElementById('labelMusicMode').innerText = isMusicRawMode ? 'RAW: ON' : 'RAW: OFF';
}

// =====================================================
// 12. 스텔스 화면 모드 전환 (TIMER / VIEW / DIM)
// =====================================================
window.setDisplayMode = function(mode) {
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
        // 우측 회전/배율 툴바와 상단 채널 선택 바는 모니터(뷰어) 화면에서만 표시!
        viewerTools.style.display = (myRole === 'monitor') ? 'flex' : 'none';
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

let lastBlackoutTap = 0;
window.handleBlackoutTap = function() {
    const now = Date.now();
    if (now - lastBlackoutTap < 350) {
        setDisplayMode(myRole === 'monitor' ? 'video' : 'stealth');
    }
    lastBlackoutTap = now;
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
// 13. 무음 메모 & 원격 렌즈 전환
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
    } else if (payload.type === 'ext-360-url') {
        syncExt360Button(payload.url);
        if (payload.url) showFloatingMsg('X5 360° 채널이 연결되었습니다');
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
    const noteText = document.getElementById('stealthNoteText');
    if (noteText) noteText.innerText = msg;
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
    }, 4000);
}

// =====================================================
// 14. 리허설 타이머 & WakeLock
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
