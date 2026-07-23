# config/settings.py
import os
from dotenv import load_dotenv

load_dotenv()

# Camera Settings
CAMERA_ID = os.getenv('CAMERA_ID', '0')
# Convert to int if it's a number, otherwise keep as string (RTSP URL)
try:
    CAMERA_ID = int(CAMERA_ID)
except ValueError:
    pass

# API Settings
API_ENDPOINT = os.getenv('API_ENDPOINT', 'http://localhost:3000/api/motion')
API_TIMEOUT = int(os.getenv('API_TIMEOUT', '10'))

# Motion Detection Settings
MOTION_SENSITIVITY = int(os.getenv('MOTION_SENSITIVITY', '25'))
MIN_CONTOUR_AREA = int(os.getenv('MIN_CONTOUR_AREA', '5000'))
NOTIFICATION_COOLDOWN = int(os.getenv('NOTIFICATION_COOLDOWN', '300'))  # seconds
MOTION_DURATION_THRESHOLD = float(os.getenv('MOTION_DURATION_THRESHOLD', '1.0'))  # seconds

# Audio Settings
AUDIO_MESSAGE_PATH = os.getenv('AUDIO_MESSAGE_PATH', 'audio/welcome_message.mp3')
ENABLE_AUDIO = os.getenv('ENABLE_AUDIO', 'true').lower() == 'true'

# Display Settings
SHOW_VIDEO_WINDOW = os.getenv('SHOW_VIDEO_WINDOW', 'true').lower() == 'true'
PROCESS_EVERY_N_FRAMES = int(os.getenv('PROCESS_EVERY_N_FRAMES', '2'))

# Logging
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
LOG_FILE = os.getenv('LOG_FILE', 'logs/motion_detector.log')