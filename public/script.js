const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// 역할 및 방 상태
let roomId = '';
let myRole = 'master'; // 'master' (지휘자) | 'monitor' (뷰어) | 'aux' (합창단/X5 보조 카메라)
let localStream = null;

// 멀티 피어 및 스트림 관리
const peers = {};       // socketId -> RTCPeerConnection
const peerRoles = {};   // socketId -> 'master' | 'monitor' | 'aux'
const peerStreams = {}; // socketId -> MediaStream

// 오디오/비디오 상태
let isRemoteAudioMuted = true; // MASTER, AUX 입장 시 기본값 MUTE (연습실 소리 사고 100% 차단)
let isLocalMicEnabled = true;
let isMusicRawMode = true;
let currentVideoDeviceId = null;
let currentFacingMode = 'user';

// 뷰어 채널 및 화면 모드
let displayMode = 'stealth'; // 'stealth' | 'video' | 'blackout'
let activeViewerChannel = 'master-front'; // 'master-front' | 'master-rear' | 'aux' | '360-sphere' | 'ext-360'
let stealthPipVisible = false;
let isSwappedPip = false;
let currentExt360Url = '';

// 비디오 회전 / 줌 / 터치 패닝(드래그 이동) 상태
let remoteRotation = 0;
let remoteZoom = 1;
let remoteMirrored = false;
let isTouchPanEnabled = true;
let panX = 0;
let panY = 0;

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
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const auxPipVideo = document.getElementById('auxPipVideo');
const peekVideo = document.getElementById('peekVideo');
const pipBox = document.getElementById('pipBox');
const auxPipBox = document.getElementById('auxPipBox');

// =====================================================
// 1. 세션 시작 (MASTER / MONITOR / AUX)
// =====================================================
window.startSession = async function(role) {
    const inputVal = document.getElementById('sessionInput').value.trim();
    if (!inputVal) return alert('Enter Session Code');

    roomId = inputVal;
    myRole = role;

    if (myRole === 'master') {
        isRemoteAudioMuted = true; // 지휘자 아이폰은 절대 소리가 나면 안 됨
        isMusicRawMode = true;
        currentFacingMode = 'user';
        displayMode = 'stealth';
    } else if (myRole === 'aux') {
        // 합창단/X5 보조 카메라는 후면(외장) 카메라 기본 + 스피커 음소거 + 스텔스 타이머
        isRemoteAudioMuted = true;
        isMusicRawMode = true;
        currentFacingMode = 'environment';
        displayMode = 'stealth';
    } else {
        // MONITOR (뷰어)
        isRemoteAudioMuted = false;
        isMusicRawMode = false;
        currentFacingMode = 'user';
        displayMode = 'video';
    }

    document.getElementById('lobbyStatus').innerText = 'INITIALIZING SENSORS...';

    try {
        await acquireMediaStream(null, currentFacingMode);
        await requestWakeLock();

        document.getElementById('lobbyScreen').style.display = 'none';
        document.getElementById('mainScreen').style.display = 'block';

        applyRemoteAudioState();
        updateMicUI();
        updateMusicModeUI();
        setDisplayMode(displayMode);
        startTimers();
        setupPeekHoldEvents();
        setupVideoTouchPanAndPinch();

        setSyncStatus('connecting', 'WAIT SYNC');
        socket.emit('join-room', { roomId, role: myRole });
    } catch (err) {
        console.error('Media init error:', err);
        alert('카메라/마이크 접근 권한을 허용해주세요.');
        document.getElementById('lobbyStatus').innerText = 'PERMISSION DENIED';
    }
};

// =====================================================
// 2. 카메라 & 오디오 스트림 획득 (초광각 0.5x & X5 지원)
// =====================================================
async function acquireMediaStream(deviceId = null, facingMode = 'user') {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }

    const videoConstraints = {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 24, max: 30 }
    };

    if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
    } else {
        videoConstraints.facingMode = { ideal: facingMode };
    }

    const audioConstraints = isMusicRawMode
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

    localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints
    });

    localStream.getAudioTracks().forEach(track => {
        track.enabled = isLocalMicEnabled;
    });

    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) {
        const settings = vTrack.getSettings();
        currentVideoDeviceId = settings.deviceId || deviceId;
        const isFront = (!deviceId && facingMode === 'user') || (vTrack.label && vTrack.label.toLowerCase().includes('front'));
        localVideo.style.transform = isFront ? 'scaleX(-1)' : 'scaleX(1)';
        document.getElementById('labelCam').innerText = getShortCamName(vTrack.label, facingMode);
    }

    renderStreamsToVideoElements();

    // 연결된 모든 피어에 끊김 없이 트랙 교체
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

    optimizeSenderBitrate();
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
// 3. 카메라 센서 선택 모달 (전면 / 후면 / 초광각 0.5x / X5)
// =====================================================
window.openCamModal = async function() {
    const modal = document.getElementById('camModal');
    const container = document.getElementById('camListContainer');
    container.innerHTML = '';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        // 1) 전면(지휘자) 빠른 선택
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

        // 2) 후면(합창단) 빠른 선택
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

        // 3) 기기별 모든 렌즈 (아이폰 초광각 0.5x, 망원, 외장 X5 등)
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
// 4. 뷰어(MONITOR) 멀티캠 채널 전환 & 360° VR 구체 뷰어
// =====================================================
window.selectViewerChannel = function(channel) {
    activeViewerChannel = channel;

    // 버튼 활성화 표시
    ['chMasterFront', 'chMasterRear', 'chAuxCam', 'ch360Sphere', 'chExt360'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });

    if (channel === 'master-front') {
        document.getElementById('chMasterFront').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        // 지휘자 폰에 전면(지휘자 얼굴) 카메라 요청
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'front' });
        renderStreamsToVideoElements();
        showFloatingMsg('CAM 1: 지휘자 정면 뷰');
    } else if (channel === 'master-rear') {
        document.getElementById('chMasterRear').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        // 지휘자 폰에 후면 초광각(합창단 전체) 카메라 요청
        socket.emit('room-event', { roomId, type: 'set-master-cam', mode: 'rear-wide' });
        renderStreamsToVideoElements();
        showFloatingMsg('CAM 1-B: 합창단 뷰 전환');
    } else if (channel === 'aux') {
        document.getElementById('chAuxCam').classList.add('active');
        stop360SphereViewer();
        hideExt360Embed();
        renderStreamsToVideoElements();
        showFloatingMsg('CAM 2: 보조/X5 카메라 뷰');
    } else if (channel === '360-sphere') {
        document.getElementById('ch360Sphere').classList.add('active');
        hideExt360Embed();
        start360SphereViewer();
        showFloatingMsg('360° VR 모드: 화면을 드래그해 회전하세요');
    } else if (channel === 'ext-360') {
        document.getElementById('chExt360').classList.add('active');
        stop360SphereViewer();
        showExt360Embed();
        showFloatingMsg('X5 360° 라이브 스트림');
    }
};

function getStreamByRole(targetRole) {
    for (const id in peerStreams) {
        if (peerRoles[id] === targetRole) {
            return peerStreams[id];
        }
    }
    return null;
}

function getAnyRemoteStream() {
    const ids = Object.keys(peerStreams);
    return ids.length > 0 ? peerStreams[ids[0]] : null;
}

function renderStreamsToVideoElements() {
    const masterStream = getStreamByRole('master');
    const auxStream = getStreamByRole('aux');
    const monitorStream = getStreamByRole('monitor');

    // 배지 상태 업데이트
    const badgeMaster = document.getElementById('badgeMaster');
    const badgeAux = document.getElementById('badgeAux');
    if (badgeMaster) badgeMaster.classList.toggle('live', !!masterStream);
    if (badgeAux) badgeAux.classList.toggle('live', !!auxStream);

    if (displayMode === 'stealth') {
        updateStealthPipState();
        return;
    }

    // 지휘자(MASTER) 또는 AUX가 VIEW 모드를 볼 때: 상대방(MONITOR) 얼굴을 메인으로 표시
    if (myRole !== 'monitor') {
        const targetRemote = monitorStream || auxStream || masterStream;
        if (!isSwappedPip) {
            remoteVideo.srcObject = targetRemote || localStream;
            localVideo.srcObject = localStream;
            document.getElementById('pipLabel').innerText = 'MY CAM';
        } else {
            remoteVideo.srcObject = localStream;
            localVideo.srcObject = targetRemote;
            document.getElementById('pipLabel').innerText = 'REMOTE';
        }
        auxPipBox.classList.add('hidden-pip');
        applyRemoteAudioState();
        return;
    }

    // 뷰어(MONITOR) 화면 구성:
    // 메인 화면에 선택한 채널(CAM 1 지휘자 vs CAM 2 합창단/X5) 표시 + 다른 카메라는 PIP로 동시 표시!
    let mainTarget = masterStream || auxStream || getAnyRemoteStream();
    let secondaryTarget = null;

    if (activeViewerChannel === 'aux' && auxStream) {
        mainTarget = auxStream;
        secondaryTarget = masterStream;
    } else {
        mainTarget = masterStream || auxStream;
        secondaryTarget = auxStream && mainTarget !== auxStream ? auxStream : null;
    }

    if (!isSwappedPip) {
        remoteVideo.srcObject = mainTarget || localStream;
        localVideo.srcObject = localStream;
        document.getElementById('pipLabel').innerText = 'ME';
    } else {
        remoteVideo.srcObject = localStream;
        localVideo.srcObject = mainTarget;
        document.getElementById('pipLabel').innerText = 'STAGE';
    }

    // 세컨드 카메라(CAM 2)가 동시에 접속해 있으면 우측에 두 번째 PIP 카드로 동시 노출!
    if (secondaryTarget) {
        auxPipVideo.srcObject = secondaryTarget;
        auxPipBox.classList.remove('hidden-pip');
        document.getElementById('auxPipLabel').innerText = (mainTarget === auxStream) ? 'CAM 1' : 'CAM 2';
    } else {
        auxPipBox.classList.add('hidden-pip');
    }

    applyRemoteAudioState();
}

window.swapAuxToMain = function() {
    if (activeViewerChannel === 'aux') {
        selectViewerChannel('master-front');
    } else {
        selectViewerChannel('aux');
    }
};

// =====================================================
// 5. WebGL 360° VR 인터랙티브 구체 뷰어 (Three.js)
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
        geometry.scale(-1, 1, 1); // 구체 안쪽에서 바라보도록 반전

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
    let initialPinchDist = null;
    let initialFov = 75;

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
    const onUp = () => { isDown = false; initialPinchDist = null; };

    container.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);

    container.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            onDown(e.touches[0].clientX, e.touches[0].clientY);
        } else if (e.touches.length === 2) {
            isDown = false;
            initialPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialFov = vrFov;
        }
    }, { passive: true });

    container.addEventListener('touchmove', e => {
        if (e.touches.length === 1 && isDown) {
            onMove(e.touches[0].clientX, e.touches[0].clientY);
        } else if (e.touches.length === 2 && initialPinchDist) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const scale = initialPinchDist / dist;
            vrFov = Math.max(30, Math.min(100, initialFov * scale));
            vrCamera.fov = vrFov;
            vrCamera.updateProjectionMatrix();
        }
    }, { passive: true });

    container.addEventListener('touchend', onUp);
}

// =====================================================
// 6. 일반/광각 영상 터치 드래그 이동(Pan) & 핀치 줌
// =====================================================
function setupVideoTouchPanAndPinch() {
    const stage = document.getElementById('videoStage');
    let isDragging = false;
    let startX = 0, startY = 0;
    let startPanX = 0, startPanY = 0;
    let initPinch = null;
    let initZoom = 1;

    stage.addEventListener('touchstart', e => {
        if (!isTouchPanEnabled) return;
        if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startPanX = panX;
            startPanY = panY;
        } else if (e.touches.length === 2) {
            isDragging = false;
            initPinch = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initZoom = remoteZoom;
        }
    }, { passive: true });

    stage.addEventListener('touchmove', e => {
        if (!isTouchPanEnabled) return;
        if (e.touches.length === 1 && isDragging) {
            panX = startPanX + (e.touches[0].clientX - startX);
            panY = startPanY + (e.touches[0].clientY - startY);
            applyVideoTransform();
        } else if (e.touches.length === 2 && initPinch) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            remoteZoom = Math.max(1, Math.min(3.5, +(initZoom * (dist / initPinch)).toFixed(2)));
            document.getElementById('zoomBtn').innerText = Math.round(remoteZoom * 10) / 10 + 'x';
            applyVideoTransform();
        }
    }, { passive: true });

    stage.addEventListener('touchend', () => {
        isDragging = false;
        initPinch = null;
    });

    // PC 마우스 드래그 지원
    stage.addEventListener('mousedown', e => {
        if (!isTouchPanEnabled) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startPanX = panX;
        startPanY = panY;
    });
    window.addEventListener('mousemove', e => {
        if (!isDragging || !isTouchPanEnabled) return;
        panX = startPanX + (e.clientX - startX);
        panY = startPanY + (e.clientY - startY);
        applyVideoTransform();
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
}

window.toggleTouchPanMode = function() {
    isTouchPanEnabled = !isTouchPanEnabled;
    document.getElementById('btnPanMode').classList.toggle('active', isTouchPanEnabled);
    showFloatingMsg(isTouchPanEnabled ? '터치 드래그 화각 이동: ON' : '터치 드래그 화각 이동: OFF');
};

window.resetPanAndZoom = function() {
    panX = 0;
    panY = 0;
    remoteZoom = 1;
    remoteRotation = 0;
    document.getElementById('zoomBtn').innerText = '1x';
    applyVideoTransform();
};

window.rotateRemoteVideo = function() {
    remoteRotation = (remoteRotation + 90) % 360;
    applyVideoTransform();
};

window.zoomRemoteVideo = function() {
    const levels = [1, 1.5, 2.0, 2.8];
    const nextIdx = (levels.indexOf(remoteZoom) + 1) % levels.length;
    remoteZoom = levels[nextIdx];
    if (remoteZoom === 1) { panX = 0; panY = 0; }
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
    remoteVideo.style.transform = `translate(${panX}px, ${panY}px) rotate(${remoteRotation}deg) scale(${scaleX}, ${scaleY})`;
}

// =====================================================
// 7. 외부 X5 360도 라이브 링크 (YouTube 360 등) 연동
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
    // YouTube 단축 URL 또는 일반 라이브 URL을 임베드 URL로 자동 변환
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
// 8. 절대 안전 오디오 제어 (상대 소리 Mute & 내 마이크 Mute)
// =====================================================
window.toggleRemoteAudio = function() {
    isRemoteAudioMuted = !isRemoteAudioMuted;
    applyRemoteAudioState();
};

function applyRemoteAudioState() {
    remoteVideo.muted = isRemoteAudioMuted;
    localVideo.muted = true;
    auxPipVideo.muted = true;
    peekVideo.muted = true;

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
// 9. 스텔스 화면 모드 전환 (TIMER / VIEW / DIM)
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
        auxPipBox.classList.add('hidden-pip');
        updateStealthPipState();
    } else if (mode === 'video') {
        stealthDeck.style.display = 'none';
        blackoutOverlay.style.display = 'none';
        viewerTools.style.display = 'flex';
        channelBar.style.display = 'flex';
        document.getElementById('btnPanMode').classList.toggle('active', isTouchPanEnabled);
        pipBox.classList.remove('stealth-mini', 'hidden-pip');
        renderStreamsToVideoElements();
    } else if (mode === 'blackout') {
        blackoutOverlay.style.display = 'flex';
    }
};

window.toggleStealthPip = function() {
    stealthPipVisible = !stealthPipVisible;
    document.getElementById('pipToggleBtn').innerText = stealthPipVisible ? 'PIP: ON' : 'PIP: OFF';
    updateStealthPipState();
};

function updateStealthPipState() {
    if (displayMode !== 'stealth') return;
    const monitorStream = getStreamByRole('monitor') || getAnyRemoteStream();
    if (stealthPipVisible) {
        pipBox.classList.remove('hidden-pip');
        pipBox.classList.add('stealth-mini');
        localVideo.srcObject = monitorStream || localStream;
        document.getElementById('pipLabel').innerText = monitorStream ? 'MON' : 'CAM';
    } else {
        pipBox.classList.add('hidden-pip');
    }
}

function setupPeekHoldEvents() {
    const timerEl = document.getElementById('elapsedTimer');
    const peekOverlay = document.getElementById('peekOverlay');

    const showPeek = (e) => {
        if (e.cancelable) e.preventDefault();
        const monitorStream = getStreamByRole('monitor') || getAnyRemoteStream();
        peekVideo.srcObject = monitorStream || localStream;
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
    renderStreamsToVideoElements();
};

// =====================================================
// 10. WebRTC 멀티피어 시그널링 & 원격 카메라 제어
// =====================================================
socket.on('connect', () => {
    if (roomId) {
        setSyncStatus('connecting', 'RE-SYNCING');
        socket.emit('join-room', { roomId, role: myRole });
    }
});

socket.on('existing-peers', async (data) => {
    const peerList = Array.isArray(data) ? data : (data.peers || []);
    if (data && data.ext360Url) {
        syncExt360Button(data.ext360Url);
    }
    for (const peer of peerList) {
        peerRoles[peer.id] = peer.role;
        await initiateCall(peer.id);
    }
});

socket.on('user-connected', (peer) => {
    peerRoles[peer.id] = peer.role;
    setSyncStatus('connecting', 'LINKING...');
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
    renderStreamsToVideoElements();
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
    if (payload.role) peerRoles[payload.caller] = payload.role;
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
    if (payload.role) peerRoles[payload.caller] = payload.role;
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
            console.error('ICE error:', e);
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
            peerStreams[targetId] = event.streams[0];
            setSyncStatus('online', 'SYNC LOCKED');
            renderStreamsToVideoElements();
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
                    params.encodings[0].maxBitrate = 1500 * 1000; // 1.5 Mbps
                    params.encodings[0].maxFramerate = 30;
                    await sender.setParameters(params);
                } catch (e) {}
            }
        }
    }
}

function setSyncStatus(state, text) {
    document.getElementById('syncDot').className = 'sync-dot ' + state;
    document.getElementById('syncText').innerText = text;
}

// =====================================================
// 11. 무음 메모 & 원격 렌즈 전환 (초광각 후면 자동 탐색 포함)
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
        // 뷰어가 [CAM 1 (지휘자)] vs [CAM 1-B (후면/합창단)] 클릭 시 자동 렌즈 전환!
        if (payload.mode === 'front') {
            currentFacingMode = 'user';
            currentVideoDeviceId = null;
            await acquireMediaStream(null, 'user');
        } else if (payload.mode === 'rear-wide') {
            // 아이폰 후면 초광각(0.5x Ultra Wide) 렌즈가 있으면 우선 선택!
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
