# 🏃 AI 줄넘기 코치 (AI Jump Rope Coach)

![Python](https://img.shields.io/badge/Python-3.9%2B-blue?logo=python)
![Flask](https://img.shields.io/badge/Flask-3.0%2B-green?logo=flask)
![OpenCV](https://img.shields.io/badge/OpenCV-4.8%2B-red?logo=opencv)
![MediaPipe](https://img.shields.io/badge/MediaPipe-0.10%2B-orange)

> **AI 줄넘기 코치**는 웹캠을 통해 사용자의 움직임을 실시간으로 감지하고, 컴퓨터 비전(OpenCV) 및 AI 포즈 추정(MediaPipe) 기술을 활용하여 줄넘기 횟수 측정 및 자세 피드백을 제공하는 웹 애플리케이션입니다.

---

## 📁 프로젝트 폴더 구조

```text
jumplope/
├── app.py                  # Flask 웹 서버 메인 애플리케이션
├── requirements.txt        # 프로젝트 의존성 라이브러리 목록
├── README.md               # 프로젝트 설명 및 구동 가이드문서
├── templates/
│   └── index.html          # 메인 대시보드 HTML 템플릿
├── static/
│   ├── style.css           # 모던 다크 테마 및 글래스모피즘 CSS
│   └── script.js           # 프론트엔드 인터랙션 및 비디오 제어 JS
├── utils/                  # [향후 구현] 영상 처리 및 포즈 추정 유틸리티
│   └── __init__.py
└── assets/                 # 이미지, 영상, 모델 리소스 폴더
    └── .gitkeep
```

---

## 🚀 시작하기 및 VS Code 실행 방법

### 1. 사전 요구 사항 (Prerequisites)
- **Python 3.9** 이상 설치
- **VS Code (Visual Studio Code)** 설치

### 2. 가상환경 생성 및 활성화 (선택 사항 권장)
VS Code 터미널(`Ctrl + ~`)을 열고 아래 명령어를 실행합니다:

```bash
# Windows
python -m venv venv
.\venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. 의존성 패키지 설치
```bash
pip install -r requirements.txt
```

### 4. Flask 서버 실행
```bash
python app.py
```

### 5. 브라우저 접속
서버 실행 후 브라우저에서 아래 주소로 접속합니다:
- **URL**: `http://127.0.0.1:5000`

---

## 🛠️ 주요 개발 기술 스택

- **Backend**: Python 3.9+, Flask
- **Frontend**: HTML5, CSS3 (Modern Glassmorphism Design System), JavaScript (ES6+)
- **AI / Computer Vision** *(다음 단계 적용 예정)*: OpenCV, MediaPipe Pose
