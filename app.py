import cv2
import numpy as np
import time
from PIL import ImageFont, ImageDraw, Image
from flask import Flask, Response, render_template, jsonify

app = Flask(__name__)

MEDIA_PIPE_ERROR = None

# --- [1] MediaPipe Pose 초기화 (노트북 웹캠/상체 전용 옵션 적용) ---
try:
    import mediapipe as mp
    mp_pose = mp.solutions.pose
    mp_drawing = mp.solutions.drawing_utils

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,           # 0: 빠름, 1: 보통(권장), 2: 정밀
        min_detection_confidence=0.3, # 상체만 보여도 인식되도록 감도 조정
        min_tracking_confidence=0.3
    )
except Exception as exc:
    mp = None
    mp_pose = None
    mp_drawing = None
    pose = None
    MEDIA_PIPE_ERROR = str(exc)

# --- [2] 전역 상태 변수 ---
jump_count = 0
jump_state = "READY"  # READY -> JUMPING -> LANDING -> READY
baseline_torso_y = None
min_torso_y = 1.0
prev_time = time.time()
fps = 0

# --- [3] 한글 텍스트 출력 함수 (OpenCV 글자 깨짐 방지) ---
def draw_text(img, text, position, font_size=20, color=(255, 255, 255)):
    img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    
    try:
        font = ImageFont.truetype("malgun.ttf", font_size)
    except:
        try:
            font = ImageFont.truetype("AppleGothic.ttf", font_size)
        except:
            font = ImageFont.load_default()
            
    draw.text(position, text, font=font, fill=color)
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

# --- [4] 몸통 중심 좌표 계산 함수 (어깨 11,12 / 골반 23,24) ---
def calculate_torso_center(landmarks):
    l_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER.value]
    r_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER.value]
    l_hip = landmarks[mp_pose.PoseLandmark.LEFT_HIP.value]
    r_hip = landmarks[mp_pose.PoseLandmark.RIGHT_HIP.value]

    shoulder_center_y = (l_shoulder.y + r_shoulder.y) / 2.0
    hip_center_y = (l_hip.y + r_hip.y) / 2.0
    torso_center_y = (shoulder_center_y + hip_center_y) / 2.0
    return torso_center_y, shoulder_center_y, hip_center_y

# --- [5] 서버 측 카메라 영상 처리 및 AI 분석 메인 루프 ---
def generate_frames():
    global jump_count, jump_state, baseline_torso_y, min_torso_y, prev_time, fps

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        fallback_image = np.zeros((480, 640, 3), dtype=np.uint8)
        fallback_image[:] = (20, 20, 30)
        cv2.putText(fallback_image, "Camera unavailable", (120, 220), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
        cv2.putText(fallback_image, "Please allow webcam access", (90, 270), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
        ret, buffer = cv2.imencode('.jpg', fallback_image)
        frame_bytes = buffer.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        return

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break

        curr_time = time.time()
        fps = int(1 / (curr_time - prev_time + 1e-5))
        prev_time = curr_time

        if pose is None:
            image = frame.copy()
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
            image = draw_text(image, "MediaPipe unavailable", (20, 20), font_size=22, color=(255, 255, 255))
            if MEDIA_PIPE_ERROR:
                image = draw_text(image, MEDIA_PIPE_ERROR[:80], (20, 60), font_size=14, color=(255, 200, 200))
        else:
            image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = pose.process(image)
            image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)

            feedback_msg = ""
            msg_color = (255, 255, 255)

            if results.pose_landmarks:
                mp_drawing.draw_landmarks(
                    image, results.pose_landmarks, mp_pose.POSE_CONNECTIONS
                )

                landmarks = results.pose_landmarks.landmark
                torso_center_y, shoulder_center_y, hip_center_y = calculate_torso_center(landmarks)

                jump_threshold = 0.03

                # 최초 baseline_torso_y 설정
                if baseline_torso_y is None:
                    baseline_torso_y = torso_center_y

                # READY 상태에서 평지에 서있을 때 baseline 자동 이동 평균 업데이트
                if jump_state == "READY":
                    if abs(torso_center_y - baseline_torso_y) < (jump_threshold * 0.8):
                        baseline_torso_y = baseline_torso_y * 0.95 + torso_center_y * 0.05

                delta_y = baseline_torso_y - torso_center_y

                # 상태 머신 전이: READY -> JUMPING -> LANDING -> READY
                if jump_state == "READY":
                    if delta_y > jump_threshold:
                        jump_state = "JUMPING"
                        min_torso_y = torso_center_y
                        feedback_msg = "🚀 점프 상승 중 (JUMPING)"
                        msg_color = (0, 215, 255)
                elif jump_state == "JUMPING":
                    if torso_center_y < min_torso_y:
                        min_torso_y = torso_center_y
                    if (torso_center_y - min_torso_y) > (jump_threshold * 0.25) or delta_y <= (jump_threshold * 0.5):
                        jump_state = "LANDING"
                        feedback_msg = "🛬 착지 중 (LANDING)"
                        msg_color = (255, 165, 0)
                elif jump_state == "LANDING":
                    if torso_center_y >= (baseline_torso_y - jump_threshold * 0.35):
                        jump_count += 1
                        jump_state = "READY"
                        feedback_msg = f"🎉 점프 1회 성공! (총 {jump_count}회)"
                        msg_color = (50, 255, 50)

                # 디버그 텍스트 오버레이
                h, w, _ = image.shape
                base_py = int(baseline_torso_y * h)
                cv2.line(image, (0, base_py), (w, base_py), (0, 215, 255), 2)

                torso_py = int(torso_center_y * h)
                cv2.circle(image, (w // 2, torso_py), 8, (255, 255, 0), -1)

                image = draw_text(image, f"Torso Center Y: {torso_center_y:.4f}", (20, 20), font_size=20, color=(0, 255, 255))
                image = draw_text(image, f"Baseline Y: {baseline_torso_y:.4f}", (20, 50), font_size=20, color=(0, 215, 255))
                image = draw_text(image, f"State: {jump_state}", (20, 80), font_size=20, color=(50, 255, 50) if jump_state == "READY" else (0, 165, 255))
                image = draw_text(image, f"Jump Count: {jump_count} 회", (20, 110), font_size=22, color=(255, 255, 0))
                image = draw_text(image, f"FPS: {fps}", (w - 110, 20), font_size=18, color=(200, 200, 200))
            else:
                feedback_msg = "❓ 상체를 찾고 있습니다..."
                msg_color = (200, 200, 200)

        ret, buffer = cv2.imencode('.jpg', image)
        frame_bytes = buffer.tobytes()

        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')

# --- [6] 웹 브라우저 및 API 라우트 ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/health')
def health():
    return jsonify({
        "status": "success",
        "message": "AI Jump Rope Coach server is running.",
        "mediapipe_ready": pose is not None,
        "error": MEDIA_PIPE_ERROR,
    })

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)