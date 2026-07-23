# main.py
#!/usr/bin/env python3
"""
CCTV Motion Detection Service
Entry point for the motion detection system
"""

import os
import sys
import argparse
import logging
from src.motion_detector import MotionDetector
from config.settings import *

# Setup logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """Main function"""
    parser = argparse.ArgumentParser(
        description='CCTV Motion Detection Service'
    )
    parser.add_argument(
        '--camera',
        type=str,
        default=None,
        help='Camera ID or RTSP URL (default: from .env)'
    )
    parser.add_argument(
        '--api',
        type=str,
        default=None,
        help='API endpoint URL (default: from .env)'
    )
    parser.add_argument(
        '--no-window',
        action='store_true',
        help='Run without video window'
    )
    
    args = parser.parse_args()
    
    # Override settings from command line
    camera_id = args.camera if args.camera else CAMERA_ID
    api_endpoint = args.api if args.api else API_ENDPOINT
    
    # Create logs directory
    os.makedirs('logs', exist_ok=True)
    
    # Display startup information
    print("=" * 60)
    print("🎥 CCTV MOTION DETECTION SERVICE")
    print("=" * 60)
    print(f"Camera: {camera_id}")
    print(f"API Endpoint: {api_endpoint}")
    print(f"Motion Sensitivity: {MOTION_SENSITIVITY}")
    print(f"Min Contour Area: {MIN_CONTOUR_AREA}")
    print(f"Notification Cooldown: {NOTIFICATION_COOLDOWN}s")
    print(f"Audio Enabled: {ENABLE_AUDIO}")
    print(f"Show Window: {SHOW_VIDEO_WINDOW and not args.no_window}")
    print("=" * 60)
    print("\nPress 'Q' in video window to quit")
    print("Or press Ctrl+C to stop\n")
    
    try:
        # Initialize and run detector
        detector = MotionDetector(
            camera_id=camera_id,
            api_endpoint=api_endpoint
        )
        detector.run()
    
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        sys.exit(0)
    
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()