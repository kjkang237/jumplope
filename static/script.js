/**
 * AI 줄넘기 코치 (AI Jump Rope Coach) - Client JavaScript
 * =========================================================
 * 노트북 카메라 환경 최적화: 상체 중심(Torso Center) 점프 감지 엔진
 * - 사용 랜드마크: 어깨(11, 12), 골반(23, 24)
 * - 하체/발목 미인식 시에도 상체 움직임만으로 안정적 점프 측정
 * - 상태 머신: READY -> JUMPING -> LANDING -> READY
 * - 디버깅 오버레이: Torso Center Y, Baseline Y, State, Jump Count 실시간 표시
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
    const torsoYCounter = document.getElementById('torso-y-counter');
    const baselineYCounter = document.getElementById('baseline-y-counter');

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
    let currentConf = 0; // 실시간 평균 상체 인식률 (%)
    let isProcessingFrame = false;

    // 3단계 점프 상태 머신 (State Machine: READY -> JUMPING -> LANDING -> READY)
    const JUMP_STATES = {
        READY: 'READY',
        JUMPING: 'JUMPING',
        LANDING: 'LANDING'
    };

    let currentState = JUMP_STATES.READY;
    let baselineY = null;
    let minTorsoY = 1.0;
    let lastStateRendered = '';
    let debugInfo = { torsoCenterY: 0, baselineY: 0, deltaY: 0 };

    // 상체 중심 POSE CONNECTIONS 구조 정의 (어깨, 골반, 팔)
    const POSE_CONNECTIONS = (typeof window !== 'undefined' && window.POSE_CONNECTIONS) ? window.POSE_CONNECTIONS : [
        [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
        [11, 23], [12, 24], [23, 24]
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
            console.log('서버 API 대기 중 또는 오프라인 모드:', error);
            if (serverStatus) {
                serverStatus.textContent = '웹캠 클라이언트 모드 가동 중';
            }
        }
    }

    checkServerHealth();

    // --------------------------------------------------------------------------
    // 4. [요구사항 5] 노트북 카메라 최적화 MediaPipe Pose 설정
    // --------------------------------------------------------------------------
    function initMediaPipePose() {
        if (typeof window.Pose === 'undefined') {
            console.error('MediaPipe Pose 라이브러리가 로드되지 않았습니다.');
            return null;
        }

        const poseInstance = new window.Pose({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });

        // 노트북 카메라 / 멀리 있는 사람 / 상체 전용 캡처를 위한 confidence 설정 (0.3)
        poseInstance.setOptions({
            modelComplexity: 1,           // 중형 모델
            smoothLandmarks: true,        // 지수 평활화 보정
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.3,  // 상체만 보여도 인식 가능하도록 0.3 설정
            minTrackingConfidence: 0.3    // 이동 중 추적 유지 0.3 설정
        });

        poseInstance.onResults(onResults);
        return poseInstance;
    }

    // --------------------------------------------------------------------------
    // 5. onResults(results) - 프레임 처리 및 디버깅 오버레이 렌더링
    // --------------------------------------------------------------------------
    function onResults(results) {
        if (!isCameraActive) return;

        // FPS 계산
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

        // 캔버스 크기 동기화
        if (outputCanvas && webcamVideo.videoWidth > 0) {
            if (outputCanvas.width !== webcamVideo.videoWidth || outputCanvas.height !== webcamVideo.videoHeight) {
                outputCanvas.width = webcamVideo.videoWidth;
                outputCanvas.height = webcamVideo.videoHeight;
            }
        }

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

        if (results && results.poseLandmarks && results.poseLandmarks.length > 0) {
            const landmarks = results.poseLandmarks;

            // [요구사항 1] 상체 주요 랜드마크만 사용 (어깨 11, 12 / 골반 23, 24)
            const torsoIndices = [11, 12, 23, 24];
            let validCount = 0;
            let totalVis = 0;

            for (const idx of torsoIndices) {
                if (landmarks[idx]) {
                    const vis = landmarks[idx].visibility || 0;
                    totalVis += vis;
                    if (vis > 0.15) validCount++;
                }
            }

            const avgVisRatio = torsoIndices.length > 0 ? (totalVis / torsoIndices.length) : 0;
            currentConf = Math.min(100, Math.round(avgVisRatio * 100));

            if (confCounter) {
                confCounter.textContent = `CONF: ${currentConf}%`;
                confCounter.style.color = currentConf < 30 ? '#f59e0b' : '#10b981';
            }

            // 상체 랜드마크 중 2개 이상 인식되면 감지 성공
            const isPersonDetected = validCount >= 2 || avgVisRatio >= 0.15;

            if (isPersonDetected) {
                // 1. 관절 연결선 그려주기 (상체 위주)
                if (typeof window.drawConnectors === 'function') {
                    window.drawConnectors(canvasCtx, landmarks, POSE_CONNECTIONS, {
                        color: '#00FF88',
                        lineWidth: 3
                    });
                } else {
                    canvasCtx.lineWidth = 3;
                    canvasCtx.strokeStyle = '#00FF88';
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

                // 2. 어깨(11,12) 및 골반(23,24) 관절 노드 포인트 표시
                for (const idx of torsoIndices) {
                    const lm = landmarks[idx];
                    if (lm && (lm.visibility || 0) > 0.15) {
                        const x = lm.x * outputCanvas.width;
                        const y = lm.y * outputCanvas.height;
                        canvasCtx.beginPath();
                        canvasCtx.arc(x, y, 6, 0, 2 * Math.PI);
                        canvasCtx.fillStyle = '#00E5FF';
                        canvasCtx.fill();
                        canvasCtx.lineWidth = 2;
                        canvasCtx.strokeStyle = '#FFFFFF';
                        canvasCtx.stroke();
                    }
                }

                // "사람 인식" 뱃지 활성화
                if (noPersonAlert) noPersonAlert.style.display = 'none';
                if (aiStatusBadge) {
                    aiStatusBadge.className = 'overlay-badge active';
                    aiStatusBadge.innerHTML = `<i class="fa-solid fa-user-check"></i> 상체 감지 완료 (${currentConf}%)`;
                }

                // [요구사항 2, 3, 4] 몸통 중심 계산 및 상태 머신 실행
                const info = processJumpStateMachine(landmarks);
                if (info) {
                    debugInfo = info;
                    // [요구사항 6] 디버깅 화면 오버레이 그려주기
                    renderDebugOverlay(canvasCtx, outputCanvas.width, outputCanvas.height, debugInfo);
                }
            } else {
                handleNoPersonDetected();
            }

        } else {
            handleNoPersonDetected();
        }

        canvasCtx.restore();
    }

    /**
     * 사람이 감지되지 않았을 때의 처리
     */
    function handleNoPersonDetected() {
        if (confCounter) {
            confCounter.textContent = 'CONF: 0%';
            confCounter.style.color = '#ef4444';
        }
        if (torsoYCounter) torsoYCounter.textContent = 'Torso Y: --';
        if (baselineYCounter) baselineYCounter.textContent = 'Base Y: --';

        if (noPersonAlert) {
            noPersonAlert.style.display = 'flex';
            noPersonAlert.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span>상체 미인식 (카메라 중앙에 위치해주세요)</span>';
        }

        if (aiStatusBadge) {
            aiStatusBadge.className = 'overlay-badge warning';
            aiStatusBadge.innerHTML = '<i class="fa-solid fa-user-slash"></i> 상체 미인식';
        }

        updateJumpStateUI(JUMP_STATES.READY);
        updateFeedback('warning', '상체가 인식되지 않았습니다. 노트북 화면 중앙에 어깨와 골반이 보이도록 서주세요.');
    }

    // --------------------------------------------------------------------------
    // 6. [요구사항 1, 2, 3, 4] 몸통 중심 점프 상태 머신 (READY -> JUMPING -> LANDING -> READY)
    // --------------------------------------------------------------------------
    function processJumpStateMachine(landmarks) {
        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];

        // [요구사항 2] 어깨 중심 및 골반 중심 좌표 계산
        let shoulderCenterY = null;
        let hipCenterY = null;

        if (leftShoulder && rightShoulder) {
            shoulderCenterY = (leftShoulder.y + rightShoulder.y) / 2;
        }
        if (leftHip && rightHip) {
            hipCenterY = (leftHip.y + rightHip.y) / 2;
        }

        // [요구사항 2] 몸통 중심(Torso Center Y) 좌표 계산
        let torsoCenterY = null;
        if (shoulderCenterY !== null && hipCenterY !== null) {
            torsoCenterY = (shoulderCenterY + hipCenterY) / 2;
        } else if (shoulderCenterY !== null) {
            torsoCenterY = shoulderCenterY;
        } else if (hipCenterY !== null) {
            torsoCenterY = hipCenterY;
        }

        if (torsoCenterY === null) return null;

        // [요구사항 3] 점프 판단 임계값 (baseline - torsoCenterY > 0.03)
        const jumpThreshold = 0.03;

        // Baseline (기준 위치) 최초 설정 및 자동 보정
        if (baselineY === null) {
            baselineY = torsoCenterY;
        }

        // READY 상태에서 사용자가 평지에 서있을 때 baseline을 정밀 유지
        if (currentState === JUMP_STATES.READY) {
            if (Math.abs(torsoCenterY - baselineY) < (jumpThreshold * 0.8)) {
                baselineY = baselineY * 0.95 + torsoCenterY * 0.05; // 지수 이동 평균
            }
        }

        // Y축 특성상 위로 상승하면 torsoCenterY 값이 감소하므로 (baselineY - torsoCenterY > 0)
        const deltaY = baselineY - torsoCenterY;

        // [요구사항 4] 상태 머신 전이 (READY -> JUMPING -> LANDING -> READY)
        switch (currentState) {
            case JUMP_STATES.READY:
                // [요구사항 3] torsoCenterY가 baseline보다 0.03 이상 위로 이동하면 JUMPING 시작
                if (deltaY > jumpThreshold) {
                    currentState = JUMP_STATES.JUMPING;
                    minTorsoY = torsoCenterY;
                    updateFeedback('info', '🚀 점프 상승 중! (JUMPING)');
                }
                break;

            case JUMP_STATES.JUMPING:
                if (torsoCenterY < minTorsoY) {
                    minTorsoY = torsoCenterY; // 최고점 위치 기록
                }
                // 최고점을 지나 하강하기 시작하면 LANDING으로 전환
                if ((torsoCenterY - minTorsoY) > (jumpThreshold * 0.25) || deltaY <= (jumpThreshold * 0.5)) {
                    currentState = JUMP_STATES.LANDING;
                    updateFeedback('info', '🛬 착지 진행 중... (LANDING)');
                }
                break;

            case JUMP_STATES.LANDING:
                // [요구사항 3] 원래 높이 부근으로 내려오면 (torsoCenterY >= baseline - threshold) 착지 완료
                if (torsoCenterY >= (baselineY - jumpThreshold * 0.35)) {
                    currentJumpCount++;
                    updateUI();

                    currentState = JUMP_STATES.READY;
                    updateFeedback('info', `🎉 점프 착지 완료! (총 ${currentJumpCount}회 점프)`);
                }
                break;
        }

        updateJumpStateUI(currentState);

        // 태그에 Y 값 실시간 갱신
        if (torsoYCounter) torsoYCounter.textContent = `Torso Y: ${torsoCenterY.toFixed(3)}`;
        if (baselineYCounter) baselineYCounter.textContent = `Base Y: ${baselineY.toFixed(3)}`;

        return {
            torsoCenterY: torsoCenterY,
            baselineY: baselineY,
            deltaY: deltaY,
            jumpThreshold: jumpThreshold,
            shoulderCenterY: shoulderCenterY,
            hipCenterY: hipCenterY
        };
    }

    // --------------------------------------------------------------------------
    // 7. [요구사항 6] 디버깅 화면 오버레이 (Torso Center Y, Baseline Y, State, Count)
    // --------------------------------------------------------------------------
    function renderDebugOverlay(ctx, width, height, info) {
        if (!info || !ctx) return;

        const { torsoCenterY, baselineY } = info;

        // A. Baseline Y 기준선 (가로 점선)
        const baseYPixel = baselineY * height;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([8, 4]);
        ctx.moveTo(0, baseYPixel);
        ctx.lineTo(width, baseYPixel);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFD700'; // 골드 노란색
        ctx.stroke();

        // Baseline Y 텍스트 표기
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.fillStyle = '#FFD700';
        ctx.fillText(`--- Baseline Y (${baselineY.toFixed(4)}) ---`, width - 210, baseYPixel - 6);

        // B. Torso Center Y 좌표 포인트 (Cyan 빛나는 점)
        const torsoYPixel = torsoCenterY * height;
        const centerXPixel = width / 2;

        ctx.beginPath();
        ctx.arc(centerXPixel, torsoYPixel, 9, 0, 2 * Math.PI);
        ctx.fillStyle = '#00FFFF';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();

        ctx.font = 'bold 13px Inter, sans-serif';
        ctx.fillStyle = '#00FFFF';
        ctx.fillText(`● Torso Center Y (${torsoCenterY.toFixed(4)})`, centerXPixel + 15, torsoYPixel + 4);
        ctx.restore();

        // C. 좌측 상단 통합 디버그 패널 (요구사항 6: Torso Center Y, Baseline, State, Jump Count)
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'; // 글래스모피즘 어두운 배경
        ctx.fillRect(15, 55, 230, 110);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.strokeRect(15, 55, 230, 110);

        ctx.font = 'bold 13px Outfit, sans-serif';
        ctx.fillStyle = '#38BDF8';
        ctx.fillText('📊 AI DEBUG PANEL', 25, 75);

        ctx.font = '500 12px Inter, sans-serif';
        ctx.fillStyle = '#E2E8F0';
        ctx.fillText(`Torso Center Y:  ${torsoCenterY.toFixed(4)}`, 25, 95);
        ctx.fillText(`Baseline Y:      ${baselineY.toFixed(4)}`, 25, 113);

        // 상태별 컬러 매핑
        let stateBg = '#10B981'; // READY - Green
        if (currentState === JUMP_STATES.JUMPING) stateBg = '#F59E0B'; // JUMPING - Orange
        if (currentState === JUMP_STATES.LANDING) stateBg = '#3B82F6'; // LANDING - Blue

        ctx.fillStyle = stateBg;
        ctx.fillText(`State:  ${currentState}`, 25, 133);

        ctx.fillStyle = '#FACC15';
        ctx.fillText(`Count: ${currentJumpCount} 회`, 140, 133);
        ctx.restore();
    }

    function updateJumpStateUI(state) {
        if (lastStateRendered === state) return;
        lastStateRendered = state;

        if (jumpStateText) jumpStateText.textContent = state;
        if (jumpStateBadge) jumpStateBadge.className = `jump-state-badge state-${state.toLowerCase()}`;
    }

    // --------------------------------------------------------------------------
    // 8. 웹캠 제어 및 처리 루프
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
            aiStatusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 상체 AI 추적 중...';
            fpsCounter.textContent = 'FPS: 계산 중';
            if (confCounter) confCounter.textContent = 'CONF: 측정 중';

            startTimer();
            updateFeedback('info', '노트북 카메라가 연결되었습니다. 화면 중앙에 서면 상체 기반 줄넘기 측정이 시작됩니다!');

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
            detailGuide = '카메라 장치가 PC/모바일에 올바르게 연결되어 있는지 확인해 주세요.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            errorMessage = '카메라 장치를 시작할 수 없습니다 (이미 사용 중).';
            detailGuide = '다른 프로그램(Zoom, Teams 등)에서 카메라를 사용 중인지 확인 후 종료해 주세요.';
        } else {
            errorMessage = `카메라 연결 오류 (${error.name || 'Unknown'})`;
            detailGuide = error.message || '웹캠 설정을 점검해 주세요.';
        }

        updateFeedback('danger', `${errorMessage} ${detailGuide}`);
        alert(`[카메라 연결 실패]\n${errorMessage}\n\n조치 방법:\n${detailGuide}`);
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
        if (torsoYCounter) torsoYCounter.textContent = 'Torso Y: --';
        if (baselineYCounter) baselineYCounter.textContent = 'Base Y: --';

        currentState = JUMP_STATES.READY;
        baselineY = null;
        updateJumpStateUI(JUMP_STATES.READY);

        stopTimer();
        updateFeedback('info', '카메라가 일시 정지되었습니다.');
    }

    // --------------------------------------------------------------------------
    // 9. 카운트 리셋
    // --------------------------------------------------------------------------
    btnResetCounter.addEventListener('click', () => {
        currentJumpCount = 0;
        elapsedSeconds = 0;
        currentState = JUMP_STATES.READY;
        baselineY = null;
        updateUI();
        updateJumpStateUI(JUMP_STATES.READY);
        updateFeedback('info', '줄넘기 카운트 및 기준(Baseline) 위치가 리셋되었습니다.');
    });

    // --------------------------------------------------------------------------
    // 10. 타이머 및 UI 유틸리티
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
