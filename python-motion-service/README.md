# CCTV Motion Detection Service

Python-based motion detection service for CCTV cameras.

## Features

- Real-time motion detection using OpenCV
- Automatic audio message playback
- API integration with Next.js backend
- Telegram notifications via backend
- Support for USB cameras and IP cameras (RTSP)
- Configurable sensitivity and cooldown

## Installation
```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Generate audio message
python scripts/generate_audio.py
```

## Configuration

Edit `.env` file:
```env
CAMERA_ID=0                                    # 0 for USB, or RTSP URL
API_ENDPOINT=http://localhost:3000/api/motion
MOTION_SENSITIVITY=25
NOTIFICATION_COOLDOWN=300
```

## Usage
```bash
# Run motion detection
python main.py

# Test camera first
python scripts/test_camera.py

# Custom camera
python main.py --camera rtsp://admin:pass@192.168.1.100:554/stream

# Run without window (headless)
python main.py --no-window
```

## Troubleshooting

### Camera not working
```bash
python scripts/test_camera.py 0    # Test camera 0
python scripts/test_camera.py 1    # Test camera 1
```

### Audio not playing
Make sure pygame is installed and audio file exists:
```bash
ls -la audio/welcome_message.mp3
python scripts/generate_audio.py
```

### API connection failed
Check if Next.js backend is running:
```bash
curl http://localhost:3000/api/motion
```
