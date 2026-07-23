# src/motion_detector.py
import cv2
import numpy as np
import requests
import threading
import time
from datetime import datetime
import pygame
import os
import logging
from config.settings import *

# Setup logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


class MotionDetector:
    def __init__(self, camera_id=None, api_endpoint=None):
        """Initialize Motion Detector"""
        self.camera_id = camera_id or CAMERA_ID
        self.api_endpoint = api_endpoint or API_ENDPOINT
        
        # Initialize camera
        logger.info(f"Initializing camera: {self.camera_id}")
        self.camera = cv2.VideoCapture(self.camera_id)
        
        if not self.camera.isOpened():
            logger.error(f"Failed to open camera: {self.camera_id}")
            raise RuntimeError(f"Cannot open camera: {self.camera_id}")
        
        # Set camera properties for better performance
        self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.camera.set(cv2.CAP_PROP_FPS, 30)
        
        # Motion detection state
        self.motion_detected = False
        self.last_notification_time = 0
        self.notification_cooldown = NOTIFICATION_COOLDOWN
        
        # Background subtractor
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=500,
            varThreshold=MOTION_SENSITIVITY,
            detectShadows=True
        )
        
        # Audio initialization
        if ENABLE_AUDIO:
            try:
                pygame.mixer.init()
                self.audio_message = AUDIO_MESSAGE_PATH
                logger.info(f"Audio initialized: {self.audio_message}")
            except Exception as e:
                logger.error(f"Audio initialization failed: {e}")
                self.audio_message = None
        else:
            self.audio_message = None
        
        # Detection parameters
        self.min_contour_area = MIN_CONTOUR_AREA
        self.sensitivity = MOTION_SENSITIVITY
        
        logger.info("Motion detector initialized successfully")
    
    def play_audio_message(self):
        """Play the welcome message"""
        if not ENABLE_AUDIO or not self.audio_message:
            return
        
        try:
            if os.path.exists(self.audio_message):
                pygame.mixer.music.load(self.audio_message)
                pygame.mixer.music.play()
                logger.info("Playing welcome message")
            else:
                logger.warning(f"Audio file not found: {self.audio_message}")
        except Exception as e:
            logger.error(f"Audio playback error: {e}")
    
    def send_notification(self, frame):
        """Send notification to backend via API"""
        try:
            current_time = time.time()
            
            # Check cooldown period
            if current_time - self.last_notification_time < self.notification_cooldown:
                logger.debug("Notification in cooldown period, skipping")
                return
            
            # Encode frame as JPEG
            _, buffer = cv2.imencode('.jpg', frame)
            
            # Prepare request
            files = {'image': ('motion.jpg', buffer.tobytes(), 'image/jpeg')}
            data = {
                'timestamp': datetime.now().isoformat(),
                'camera_id': 'shop_entrance',  # TODO: Make this configurable
                'message': 'Customer detected at entrance'
            }
            
            logger.info(f"Sending notification to: {self.api_endpoint}")
            
            # Send to Next.js API
            response = requests.post(
                self.api_endpoint,
                files=files,
                data=data,
                timeout=API_TIMEOUT
            )
            
            if response.status_code == 200:
                self.last_notification_time = current_time
                logger.info(f"Notification sent successfully at {datetime.now()}")
                result = response.json()
                logger.debug(f"API Response: {result}")
            else:
                logger.error(f"Notification failed: {response.status_code} - {response.text}")
        
        except requests.exceptions.Timeout:
            logger.error("Notification timeout - API not responding")
        except requests.exceptions.ConnectionError:
            logger.error("Connection error - Cannot reach API endpoint")
        except Exception as e:
            logger.error(f"Notification error: {e}")
    
    def detect_motion(self, frame):
        """Detect motion in frame"""
        # Apply background subtraction
        fg_mask = self.bg_subtractor.apply(frame)
        
        # Remove shadows (value 127 in MOG2)
        _, fg_mask = cv2.threshold(fg_mask, 250, 255, cv2.THRESH_BINARY)
        
        # Noise removal
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel)
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, kernel)
        
        # Find contours
        contours, _ = cv2.findContours(
            fg_mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        motion = False
        motion_areas = []
        
        for contour in contours:
            area = cv2.contourArea(contour)
            if area > self.min_contour_area:
                motion = True
                motion_areas.append(area)
                # Draw rectangle around motion
                x, y, w, h = cv2.boundingRect(contour)
                cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
                # Add text with area
                cv2.putText(
                    frame,
                    f"Area: {int(area)}",
                    (x, y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    (0, 255, 0),
                    2
                )
        
        if motion:
            logger.debug(f"Motion detected - Areas: {motion_areas}")
        
        return motion, frame
    
    def run(self):
        """Main detection loop"""
        logger.info("Starting motion detection...")
        logger.info(f"Camera: {self.camera_id}")
        logger.info(f"API Endpoint: {self.api_endpoint}")
        logger.info(f"Min Contour Area: {self.min_contour_area}")
        logger.info(f"Notification Cooldown: {self.notification_cooldown}s")
        logger.info(f"Show Video: {SHOW_VIDEO_WINDOW}")
        
        frame_count = 0
        motion_start_time = None
        motion_duration_threshold = MOTION_DURATION_THRESHOLD
        
        try:
            while True:
                ret, frame = self.camera.read()
                if not ret:
                    logger.error("Failed to grab frame")
                    break
                
                frame_count += 1
                
                # Process every N frames for performance
                if frame_count % PROCESS_EVERY_N_FRAMES == 0:
                    motion, annotated_frame = self.detect_motion(frame)
                    
                    if motion:
                        if motion_start_time is None:
                            motion_start_time = time.time()
                            logger.debug("Motion started")
                        
                        # Check if motion sustained for threshold duration
                        motion_duration = time.time() - motion_start_time
                        
                        if motion_duration > motion_duration_threshold and not self.motion_detected:
                            self.motion_detected = True
                            logger.info(f"⚠️  MOTION DETECTED at {datetime.now()}")
                            
                            # Play audio message in separate thread
                            if ENABLE_AUDIO:
                                threading.Thread(
                                    target=self.play_audio_message,
                                    daemon=True
                                ).start()
                            
                            # Send notification in separate thread
                            threading.Thread(
                                target=self.send_notification,
                                args=(frame.copy(),),
                                daemon=True
                            ).start()
                    else:
                        if motion_start_time is not None:
                            logger.debug("Motion ended")
                        motion_start_time = None
                        self.motion_detected = False
                    
                    # Display frame
                    if SHOW_VIDEO_WINDOW:
                        # Add status text
                        status_text = f"Motion: {'YES' if motion else 'NO'}"
                        color = (0, 255, 0) if motion else (0, 0, 255)
                        cv2.putText(
                            annotated_frame,
                            status_text,
                            (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            1,
                            color,
                            2
                        )
                        
                        # Add FPS
                        cv2.putText(
                            annotated_frame,
                            f"Frame: {frame_count}",
                            (10, 60),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.6,
                            (255, 255, 255),
                            1
                        )
                        
                        cv2.imshow('Motion Detection - Press Q to quit', annotated_frame)
                
                # Press 'q' to quit
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    logger.info("Quit signal received")
                    break
        
        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        except Exception as e:
            logger.error(f"Error in main loop: {e}")
        finally:
            self.cleanup()
    
    def cleanup(self):
        """Release resources"""
        logger.info("Cleaning up resources...")
        self.camera.release()
        cv2.destroyAllWindows()
        if ENABLE_AUDIO:
            pygame.mixer.quit()
        logger.info("Motion detector stopped")


if __name__ == "__main__":
    detector = MotionDetector()
    detector.run()