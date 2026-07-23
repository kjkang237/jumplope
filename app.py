import cv2
import mediapipe as mp
import numpy as np
import time
from PIL import ImageFont, ImageDraw, Image
from flask import Flask, Response, render_template_string

app = Flask(__name__)

# --- [1] MediaPipe Pose 초기화 (원거리/미인식 방지 옵션 적용) ---
mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils

pose = mp_pose.Pose(
    static_image_mode=False,
    model_complexity=1,           # 0: 빠름, 1: 보통(권장), 2: 정밀
    min_detection_confidence=0.3, # 멀어져도 잘 인식하도록 감도 조정 (기본 0.5 -> 0.3)
    min_tracking_confidence=0.3
)

# --- [2] 전역 상태 변수 ---
jump_count = 0
is_jumping = False
hip_y_baseline = None
prev_time = time.time()
fps = 0

# --- [3] 한글 텍스트 출력 함수 (OpenCV 글자 깨짐 방지) ---
def draw_text(img, text, position, font_size=20, color=(255, 255, 255)):
    img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    
    try:
        # 윈도우 기본 한글 폰트 (맑은 고딕)
        font = ImageFont.truetype("malgun.ttf", font_size)
    except:
        try:
            # 맥 OS 한글 폰트
            font = ImageFont.truetype("AppleGothic.ttf", font_size)
        except:
            font = ImageFont.load_default()
            
    draw.text(position, text, font=font, fill=color)
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

# --- [4] 관절 각도 계산 함수 (골반-무릎-발목) ---
def calculate_angle(a, b, c):
    a = np.array(a) # 골반
    b = np.array(b) # 무릎
    c = np.array(c) # 발목
    
    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)
    
    if angle > 180.0:
        angle = 360 - angle
        
    return angle

# --- [5] 카메라 영상 처리 및 AI 분석 메인 루프 ---
def generate_frames():
    global jump_count, is_jumping, hip_y_baseline, prev_time, fps
    
    # 카메라 연결 (0번: 기본 웹캠 / DroidCam 연결 시 해당 번호)
    cap = cv2.VideoCapture(0)
    
    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break
            
        # FPS 계산
        curr_time = time.time()
        fps = int(1 / (curr_time - prev_time + 1e-5))
        prev_time = curr_time
        
        # BGR -> RGB 변환 후 MediaPipe 연산
        image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = pose.process(image)
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        feedback_msg = ""
        msg_color = (255, 255, 255)
        
        if results.pose_landmarks:
            # 뼈대 그리기
            mp_drawing.draw_landmarks(
                image, results.pose_landmarks, mp_pose.POSE_CONNECTIONS
            )
            
            landmarks = results.pose_landmarks.landmark
            
            # 주요 관절 좌표 (왼쪽 기준)
            hip_left = [landmarks[mp_pose.PoseLandmark.LEFT_HIP.value].x, landmarks[mp_pose.PoseLandmark.LEFT_HIP.value].y]
            knee_left = [landmarks[mp_pose.PoseLandmark.LEFT_KNEE.value].x, landmarks[mp_pose.PoseLandmark.LEFT_KNEE.value].y]
            ankle_left = [landmarks[mp_pose.PoseLandmark.LEFT_ANKLE.value].x, landmarks[mp_pose.PoseLandmark.LEFT_ANKLE.value].y]
            
            hip_y = hip_left[1]
            ankle_vis = landmarks[mp_pose.PoseLandmark.LEFT_ANKLE.value].visibility # 발목 가시성
            
            # A. 기준 높이(서있는 상태) 잡기
            if hip_y_baseline is None:
                hip_y_baseline = hip_y
            else:
                if not is_jumping:
                    hip_y_baseline = hip_y_baseline * 0.95 + hip_y * 0.05
            
            # B. 점프 감지 (골반 Y축 위치 변화 기준 - 좁은 방/상체 전용)
            jump_threshold = 0.035 
            
            if hip_y < (hip_y_baseline - jump_threshold) and not is_jumping:
                is_jumping = True
            elif hip_y >= (hip_y_baseline - 0.01) and is_jumping:
                # 착지 완료 시점
                is_jumping = False
                jump_count += 1
                
                # C. [스마트 코칭 모드] 발목이 보일 때 착지 무릎 각도 검사
                if ankle_vis > 0.5:
                    knee_angle = calculate_angle(hip_left, knee_left, ankle_left)
                    if knee_angle > 165: # 무릎을 뻣뻣하게 편 채 착지
                        feedback_msg = "⚠️ 무릎 충격 주의! 착지 시 무릎을 살짝 구부리세요."
                        msg_color = (255, 50, 50) # 빨간색
                    else:
                        feedback_msg = "✅ 아주 좋은 착지 자세입니다!"
                        msg_color = (50, 255, 50) # 초록색

            # D. 화면에 전신 가시성 상태 안내
            if not feedback_msg:
                if ankle_vis <= 0.5:
                    feedback_msg = "💡 전신이 보이면 스마트 무릎 코칭이 활성화됩니다."
                    msg_color = (255, 200, 0) # 노란색
                else:
                    feedback_msg = "🎯 AI 스마트 코칭 가동 중 (전신 인식 완료)"
                    msg_color = (50, 255, 50)
        else:
            feedback_msg = "❓ 사람을 찾고 있습니다..."
            msg_color = (200, 200, 200)

        # --- [6] 화면 UI 오버레이 ---
        # 횟수 및 FPS
        image = draw_text(image, f"점프 횟수: {jump_count} 회", (20, 20), font_size=26, color=(255, 255, 0))
        image = draw_text(image, f"FPS: {fps}", (image.shape[1] - 110, 20), font_size=18, color=(200, 200, 200))
        # 실시간 코칭 자막
        image = draw_text(image, feedback_msg, (20, image.shape[0] - 45), font_size=20, color=msg_color)

        # 웹 출력용 JPEG 변환
        ret, buffer = cv2.imencode('.jpg', image)
        frame_bytes = buffer.tobytes()
        
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')

# --- [7] 웹 브라우저 UI 페이지 ---
@app.route('/')
def index():
    return render_template_string('''
        <!DOCTYPE html>
        <html>
        <head>
            <title>AI 줄넘기 스마트 코칭</title>
            <style>
                body {
                    background-color: #121212;
                    color: white;
                    font-family: 'Malgun Gothic', sans-serif;
                    text-align: center;
                    margin: 0;
                    padding: 20px;
                }
                .container {
                    display: inline-block;
                    position: relative;
                    border: 3px solid #333;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 8px 20px rgba(0,0,0,0.6);
                }
                img {
                    width: 100%;
                    max-width: 800px;
                    height: auto;
                    display: block;
                }
            </style>
        </head>
        <body>
            <h2>🏃‍♂️ AI 줄넘기 스마트 코칭 시스템</h2>
            <div class="container">
                <img src="/video_feed" />
            </div>
        </body>
        </html>
    ''')

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)