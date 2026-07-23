/**
 * AI 줄넘기 코치 (AI Jump Rope Coach) - Client JavaScript
 * =========================================================
 * 원거리(2~3m) 인체 감지 최적화 (minDetectionConfidence: 0.35, minTrackingConfidence: 0.35)
 * 실시간 인식률(Confidence %) 표시 및 가동성 가중치 완화를 적용한 피지컬 AI 엔진
 */

document.addEventListener('DOMContentLoaded', () => {
    // --------------------------------------------------------------------------
    // 1. DOM 엘리먼트 참조
    // --------------------------------------------------------------------------
    const btnToggleCam = document.getElementById('btn-toggle-cam');
    const btnResetCounter = document.getElementById('btn-reset-counter');
    const webcamVideo = document.getElementById('webcam-video');
    const outputCanvas = document.getElementById('output-canvas');
    const canvasCtx = outputCanvas ? outputCanvas.getContext('2d') : null;
    const videoPlaceholder = document.getElementById('video-placeholder');
    const aiStatusBadge = document.getElementById('ai-status-badge');
    const jumpStateBadge = document.getElementById('jump-state-badge');
    const jumpStateText = document.getElementById('jump-state-text');
    const noPersonAlert = document.getElementById('no-person-alert');
    const serverStatus = document.getElementById('server-status');
    const fpsCounter = document.getElementById('fps-counter');
    const confCounter = document.getElementById('conf-counter');

    // 대시보드 통계 엘리먼트
    const jumpCountEl = document.getElementById('jump-count');
    const goalProgressEl = document.getElementById('goal-progress');
    const progressPercentEl = document.getElementById('progress-percent');
    const valCaloriesEl = document.getElementById('val-calories');
    const valTimerEl = document.getElementById('val-timer');
    const valSpeedEl = document.getElementById('val-speed');
    const feedbackBox = document.getElementById('feedback-box');

    // --------------------------------------------------------------------------
    // 2. 상태 변수 설정
    // --------------------------------------------------------------------------
    let isCameraActive = false;
    let mediaStream = null;
    let timerInterval = null;
    let elapsedSeconds = 0;
    let currentJumpCount = 0;
    const targetGoal = 100;

    // MediaPipe & Performance 변수
    let pose = null;
    let lastFrameTime = performance.now();
    let currentFps = 0;
    let currentConf = 0; // 실시간 평균 인식률 (%)
    let isProcessingFrame = false;

    // 4단계 점프 상태 머신 (State Machine)
    const JUMP_STATES = {
        READY: 'READY',
        JUMPING: 'JUMPING',
        PEAK: 'PEAK',
        LANDING: 'LANDING'
    };

    let currentState = JUMP_STATES.READY;
    let baselineY = null;
    let minCenterY = 1.0;
    let lastStateRendered = '';

    // MediaPipe POSE CONNECTIONS 구조 정의
    const POSE_CONNECTIONS = (typeof window !== 'undefined' && window.POSE_CONNECTIONS) ? window.POSE_CONNECTIONS : [
        [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
        [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
        [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
        [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
        [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32]
    ];

    // --------------------------------------------------------------------------
    // 3. 서버 헬스 체크 API
    // --------------------------------------------------------------------------
    async function checkServerHealth() {
        try {
            const response = await fetch('/api/health');
            const data = await response.json();
            if (data.status === 'success' && serverStatus) {
                serverStatus.textContent = '서버 연결됨 (정상)';
            }
        } catch (error) {
            console.error('서버 연결 실패:', error);
            if (serverStatus) {
                serverStatus.textContent = '서버 연결 안 됨';
                if (serverStatus.previousElementSibling) {
                    serverStatus.previousElementSibling.classList.remove('online');
                }
            }
        }
    }

    checkServerHealth();

    // --------------------------------------------------------------------------
    // 4. [요구사항 1 & 2] 원거리(2~3m) 인식을 위한 MediaPipe Pose 최적화 설정
    // --------------------------------------------------------------------------
    function initMediaPipePose() {
        if (typeof window.Pose === 'undefined') {
            console.error('MediaPipe Pose 라이브러리가 로드되지 않았습니다.');
            return null;
        }

        const poseInstance = new window.Pose({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });

        // 원거리(2~3m) 소형 랜드마크도 놓치지 않도록 Detection/Tracking Confidence를 0.35로 조정
        poseInstance.setOptions({
            modelComplexity: 1,           // 중형 모델 (속도와 정밀도 최적 균형)
            smoothLandmarks: true,        // 랜드마크 부드럽게 지수 보정
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.35, // 0.5 -> 0.35 (원거리 사람 캡처율 대폭 향상)
            minTrackingConfidence: 0.35   // 0.5 -> 0.35 (원거리 트래킹 유지력 대폭 향상)
        });

        poseInstance.onResults(onResults);
        return poseInstance;
    }

    // --------------------------------------------------------------------------
    // 5. [요구사항 3, 4, 5] onResults(results) - 인식 조건 완화 및 인식률(Confidence %) 표시
    // --------------------------------------------------------------------------
    function onResults(results) {
        if (!isCameraActive) return;

        // 실시간 FPS 계산
        const now = performance.now();
        const delta = (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        if (delta > 0) {
            const instantFps = Math.round(1 / delta);
            currentFps = currentFps === 0 ? instantFps : Math.round(currentFps * 0.8 + instantFps * 0.2);
            if (fpsCounter) {
                fpsCounter.textContent = `FPS: ${currentFps}`;
            }
        }

        // 캔버스 크기 조정
        if (outputCanvas && webcamVideo.videoWidth > 0) {
            if (outputCanvas.width !== webcamVideo.videoWidth || outputCanvas.height !== webcamVideo.videoHeight) {
                outputCanvas.width = webcamVideo.videoWidth;
                outputCanvas.height = webcamVideo.videoHeight;
            }
        }

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

        // 랜드마크 검출 여부 및 완화된 판단 기준 (가시성 0.15 이상인 주요 랜드마크 존재 여부)
        if (results && results.poseLandmarks && results.poseLandmarks.length > 0) {
            const landmarks = results.poseLandmarks;

            // [요구사항 4] 평균 인식률(Confidence %) 계산 (주요 상하체 랜드마크 기준)
            const checkIndices = [11, 12, 23, 24, 25, 26, 27, 28]; // 어깨, 엉덩이, 무릎, 발목
            let validCount = 0;
            let totalVis = 0;

            for (const idx of checkIndices) {
                if (landmarks[idx]) {
                    const vis = landmarks[idx].visibility || 0;
                    totalVis += vis;
                    if (vis > 0.15) validCount++; // 원거리 인식을 위한 완화된 threshold (0.15)
                }
            }

            const avgVisRatio = checkIndices.length > 0 ? (totalVis / checkIndices.length) : 0;
            currentConf = Math.min(100, Math.round(avgVisRatio * 100));

            // [요구사항 4] 화면 상단 디버깅 태그에 Confidence % 실시간 표시
            if (confCounter) {
                confCounter.textContent = `CONF: ${currentConf}% (Det: 0.35/Trk: 0.35)`;
                if (currentConf < 40) {
                    confCounter.style.color = '#f59e0b'; // 경고 주황
                } else {
                    confCounter.style.color = '#10b981'; // 초록
                }
            }

            // [요구사항 3] 사람 미인식 완화 조건: 주요 관절 중 3개 이상 감지되면 인식 성공으로 처리 (2~3m 완벽 지원)
            const isPersonDetected = validCount >= 3 || avgVisRatio >= 0.2;

            if (isPersonDetected) {
                // 초록색(#00FF00) 관절과 연결선 드로잉
                if (typeof window.drawConnectors === 'function') {
                    window.drawConnectors(canvasCtx, landmarks, POSE_CONNECTIONS, {
                        color: '#00FF00',
                        lineWidth: 4
                    });
                } else {
                    canvasCtx.lineWidth = 4;
                    canvasCtx.strokeStyle = '#00FF00';
                    for (const conn of POSE_CONNECTIONS) {
                        const p1 = landmarks[conn[0]];
                        const p2 = landmarks[conn[1]];
                        if (p1 && p2 && (p1.visibility || 0) > 0.15 && (p2.visibility || 0) > 0.15) {
                            canvasCtx.beginPath();
                            canvasCtx.moveTo(p1.x * outputCanvas.width, p1.y * outputCanvas.height);
                            canvasCtx.lineTo(p2.x * outputCanvas.width, p2.y * outputCanvas.height);
                            canvasCtx.stroke();
                        }
                    }
                }

                if (typeof window.drawLandmarks === 'function') {
                    window.drawLandmarks(canvasCtx, landmarks, {
                        color: '#00FF00',
                        fillColor: '#00FF00',
                        lineWidth: 2,
                        radius: 5
                    });
                } else {
                    for (let i = 0; i < landmarks.length; i++) {
                        const lm = landmarks[i];
                        if (lm && (lm.visibility || 0) > 0.15) {
                            const x = lm.x * outputCanvas.width;
                            const y = lm.y * outputCanvas.height;
                            canvasCtx.beginPath();
                            canvasCtx.arc(x, y, 5, 0, 2 * Math.PI);
                            canvasCtx.fillStyle = '#00FF00';
                            canvasCtx.fill();
                            canvasCtx.lineWidth = 2;
                            canvasCtx.strokeStyle = '#FFFFFF';
                            canvasCtx.stroke();
                        }
                    }
                }

                // "사람 인식" 상태 표시
                if (noPersonAlert) noPersonAlert.style.display = 'none';
                if (aiStatusBadge) {
                    aiStatusBadge.className = 'overlay-badge active';
                    aiStatusBadge.innerHTML = `<i class="fa-solid fa-user-check"></i> 사람 인식 (${currentConf}%)`;
                }

                // 4단계 점프 상태 머신 실행
                processJumpStateMachine(landmarks);
            } else {
                handleNoPersonDetected();
            }

        } else {
            handleNoPersonDetected();
        }

        canvasCtx.restore();
    }

    /**
     * 사람이 감지되지 않았을 때의 상태 표시
     */
    function handleNoPersonDetected() {
        if (confCounter) {
            confCounter.textContent = 'CONF: 0%';
            confCounter.style.color = '#ef4444';
        }

        if (noPersonAlert) {
            noPersonAlert.style.display = 'flex';
            noPersonAlert.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span>사람 미인식</span>';
        }

        if (aiStatusBadge) {
            aiStatusBadge.className = 'overlay-badge warning';
            aiStatusBadge.innerHTML = '<i class="fa-solid fa-user-slash"></i> 사람 미인식';
        }

        updateJumpStateUI(JUMP_STATES.READY);
        updateFeedback('warning', '사람 미인식: 화면 2~3m 거리 중앙에 전신이 보이도록 서주세요.');
    }

    // --------------------------------------------------------------------------
    // 6. 원거리(2~3m) 자동 스케일링 점프 4단계 상태 머신 (READY -> JUMPING -> PEAK -> LANDING)
    // --------------------------------------------------------------------------
    function processJumpStateMachine(landmarks) {
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];
        const leftKnee = landmarks[25];
        const rightKnee = landmarks[26];
        const leftAnkle = landmarks[27];
        const rightAnkle = landmarks[28];

        if (!leftHip || !rightHip || !leftKnee || !rightKnee || !leftAnkle || !rightAnkle) return;

        // 중심 Y좌표 계산
        const hipY = (leftHip.y + rightHip.y) / 2;
        const kneeY = (leftKnee.y + rightKnee.y) / 2;
        const ankleY = (leftAnkle.y + rightAnkle.y) / 2;
        const currentCenterY = (hipY * 0.4) + (kneeY * 0.3) + (ankleY * 0.3);

        // 2~3m 원거리 인체 크기 자동 스케일링: 엉덩이-발목 높이를 기준으로 점프 임계값(jumpThreshold) 자동 보정
        const bodyHeight = Math.max(0.1, Math.abs(ankleY - hipY));
        const jumpThreshold = Math.max(0.018, bodyHeight * 0.12); // 원거리 소형 인체도 쉽게 인지 가능하도록 동적 설정

        if (baselineY === null) {
            baselineY = currentCenterY;
        }

        if (currentState === JUMP_STATES.READY) {
            if (Math.abs(currentCenterY - baselineY) < (jumpThreshold * 1.5)) {
                baselineY = baselineY * 0.95 + currentCenterY * 0.05;
            }
        }

        const deltaY = baselineY - currentCenterY;

        switch (currentState) {
            case JUMP_STATES.READY:
                if (deltaY > jumpThreshold) {
                    currentState = JUMP_STATES.JUMPING;
                    minCenterY = currentCenterY;
                    updateFeedback('info', '상승 도약 중 (JUMPING)');
                }
                break;

            case JUMP_STATES.JUMPING:
                if (currentCenterY < minCenterY) {
                    minCenterY = currentCenterY;
                }
                if (currentCenterY - minCenterY > (jumpThreshold * 0.3)) {
                    currentState = JUMP_STATES.PEAK;
                    updateFeedback('info', '점프 최고점 도달! (PEAK)');
                }
                break;

            case JUMP_STATES.PEAK:
                currentState = JUMP_STATES.LANDING;
                updateFeedback('info', '착지 하강 중 (LANDING)');
                break;

            case JUMP_STATES.LANDING:
                if (currentCenterY >= (baselineY - jumpThreshold * 0.35)) {
                    currentJumpCount++;
                    updateUI();

                    currentState = JUMP_STATES.READY;
                    updateFeedback('info', `착지 완료! (총 ${currentJumpCount}회 점프)`);
                }
                break;
        }

        updateJumpStateUI(currentState);
    }

    function updateJumpStateUI(state) {
        if (lastStateRendered === state) return;
        lastStateRendered = state;

        if (jumpStateText) jumpStateText.textContent = state;
        if (jumpStateBadge) jumpStateBadge.className = `jump-state-badge state-${state.toLowerCase()}`;
    }

    // --------------------------------------------------------------------------
    // 7. 웹캠 제어 및 프레임 전송 루프
    // --------------------------------------------------------------------------
    btnToggleCam.addEventListener('click', async () => {
        if (!isCameraActive) {
            await startCamera();
        } else {
            stopCamera();
        }
    });

    async function startCamera() {
        if (!pose) {
            pose = initMediaPipePose();
        }

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: false
            });

            webcamVideo.srcObject = mediaStream;
            await webcamVideo.play();

            webcamVideo.style.display = 'block';
            if (outputCanvas) outputCanvas.style.display = 'block';
            videoPlaceholder.style.display = 'none';

            isCameraActive = true;
            btnToggleCam.innerHTML = '<i class="fa-solid fa-stop"></i> 카메라 중지';
            btnToggleCam.classList.remove('btn-primary');
            btnToggleCam.classList.add('btn-secondary');

            aiStatusBadge.className = 'overlay-badge';
            aiStatusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 감지 동작 중...';
            fpsCounter.textContent = 'FPS: 계산 중';
            if (confCounter) confCounter.textContent = 'CONF: 측정 중';

            startTimer();
            updateFeedback('info', '카메라가 연결되었습니다. 2~3m 거리에서 서서 점프 모니터링을 시작하세요!');

            startPoseProcessingLoop();

        } catch (error) {
            console.error('카메라 접근 에러:', error);
            handleCameraError(error);
        }
    }

    function startPoseProcessingLoop() {
        async function processFrame() {
            if (!isCameraActive) return;

            if (pose && webcamVideo.readyState >= 2 && !isProcessingFrame) {
                isProcessingFrame = true;
                try {
                    await pose.send({ image: webcamVideo });
                } catch (e) {
                    console.error('MediaPipe pose.send 오류:', e);
                }
                isProcessingFrame = false;
            }

            requestAnimationFrame(processFrame);
        }

        requestAnimationFrame(processFrame);
    }

    function handleCameraError(error) {
        let errorMessage = '카메라 연결에 실패했습니다.';
        let detailGuide = '';

        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMessage = '카메라 접근 권한이 거부되었습니다.';
            detailGuide = '브라우저 주소창 좌측의 [자물쇠] 아이콘을 눌러 카메라 권한을 [허용]으로 변경 후 새로고침해 주세요.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            errorMessage = '연결된 웹캠 카메라 장치를 찾을 수 없습니다.';
            detailGuide = '카메라 장치가 PC/모바일에 올바르게 연결되어 있는지 연결 상태를 확인해 주세요.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            errorMessage = '카메라 장치를 시작할 수 없습니다 (이미 사용 중).';
            detailGuide = '다른 프로그램(Zoom, Teams, Skype 등)에서 카메라를 사용 중인지 확인하고 종료해 주세요.';
        } else if (error.name === 'SecurityError') {
            errorMessage = '보안 웹 환경(HTTPS 또는 localhost)에서만 카메라 접근이 허용됩니다.';
            detailGuide = '안전한 HTTPS 연결 주소로 접속해 주시기 바랍니다.';
        } else {
            errorMessage = `카메라 연결 오류 (${error.name || 'Unknown'})`;
            detailGuide = error.message || '웹캠 설정을 다시 점검해 주세요.';
        }

        updateFeedback('danger', `${errorMessage} ${detailGuide}`);
        alert(`[카메라 연결 실패]\n${errorMessage}\n\n원인 및 조치 방법:\n${detailGuide}`);
        stopCamera();
    }

    function stopCamera() {
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        webcamVideo.srcObject = null;
        webcamVideo.style.display = 'none';
        if (outputCanvas) outputCanvas.style.display = 'none';
        videoPlaceholder.style.display = 'flex';
        if (noPersonAlert) noPersonAlert.style.display = 'none';

        isCameraActive = false;
        btnToggleCam.innerHTML = '<i class="fa-solid fa-play"></i> 카메라 시작';
        btnToggleCam.classList.remove('btn-secondary');
        btnToggleCam.classList.add('btn-primary');

        aiStatusBadge.className = 'overlay-badge';
        aiStatusBadge.innerHTML = '<i class="fa-solid fa-brain"></i> AI 감지 대기 중';
        fpsCounter.textContent = 'FPS: --';
        if (confCounter) confCounter.textContent = 'CONF: --%';

        currentState = JUMP_STATES.READY;
        baselineY = null;
        updateJumpStateUI(JUMP_STATES.READY);

        stopTimer();
        updateFeedback('info', '카메라가 일시 정지되었습니다.');
    }

    // --------------------------------------------------------------------------
    // 8. 카운트 리셋 핸들러
    // --------------------------------------------------------------------------
    btnResetCounter.addEventListener('click', () => {
        currentJumpCount = 0;
        elapsedSeconds = 0;
        currentState = JUMP_STATES.READY;
        baselineY = null;
        updateUI();
        updateJumpStateUI(JUMP_STATES.READY);
        updateFeedback('info', '줄넘기 카운트 및 운동 타이머가 리셋되었습니다.');
    });

    // --------------------------------------------------------------------------
    // 9. 타이머 및 UI 업데이트 유틸리티
    // --------------------------------------------------------------------------
    function startTimer() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            elapsedSeconds++;
            updateUI();
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    function formatTime(totalSeconds) {
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function updateUI() {
        if (jumpCountEl) jumpCountEl.textContent = currentJumpCount;

        const percent = Math.min(100, Math.round((currentJumpCount / targetGoal) * 100));
        if (goalProgressEl) goalProgressEl.style.width = `${percent}%`;
        if (progressPercentEl) progressPercentEl.textContent = `${percent}% 달성`;

        if (valTimerEl) valTimerEl.textContent = formatTime(elapsedSeconds);

        const calories = (currentJumpCount * 0.15).toFixed(1);
        if (valCaloriesEl) valCaloriesEl.innerHTML = `${calories} <small>kcal</small>`;

        const minutes = elapsedSeconds / 60;
        const rpm = minutes > 0 ? Math.round(currentJumpCount / minutes) : 0;
        if (valSpeedEl) valSpeedEl.innerHTML = `${rpm} <small>/min</small>`;
    }

    function updateFeedback(type, message) {
        if (!feedbackBox) return;

        let iconClass = 'fa-circle-info';
        if (type === 'warning') iconClass = 'fa-triangle-exclamation';
        if (type === 'danger') iconClass = 'fa-circle-xmark';

        feedbackBox.innerHTML = `
            <div class="feedback-message ${type}">
                <i class="fa-solid ${iconClass}"></i>
                <span>${message}</span>
            </div>
        `;
    }
});
