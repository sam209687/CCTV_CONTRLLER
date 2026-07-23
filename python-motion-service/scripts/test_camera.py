# scripts/test_camera.py
"""Test camera connection and display video feed"""
import cv2
import sys

def test_camera(camera_id=0):
    """Test camera connection"""
    print(f"Testing camera: {camera_id}")
    print("Press 'Q' to quit\n")
    
    # Try to open camera
    cap = cv2.VideoCapture(camera_id)
    
    if not cap.isOpened():
        print(f"❌ Failed to open camera: {camera_id}")
        print("\nTroubleshooting:")
        print("1. Check if camera is connected")
        print("2. Try different camera IDs: 0, 1, 2")
        print("3. For RTSP: rtsp://username:password@ip:port/stream")
        return False
    
    print("✅ Camera opened successfully!")
    print(f"Resolution: {int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
    print(f"FPS: {int(cap.get(cv2.CAP_PROP_FPS))}")
    
    frame_count = 0
    
    while True:
        ret, frame = cap.read()
        
        if not ret:
            print("❌ Failed to read frame")
            break
        
        frame_count += 1
        
        # Add frame counter
        cv2.putText(
            frame,
            f"Frame: {frame_count}",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0, 255, 0),
            2
        )
        
        cv2.imshow('Camera Test - Press Q to quit', frame)
        
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
    
    cap.release()
    cv2.destroyAllWindows()
    print(f"\n✅ Test complete! Processed {frame_count} frames")
    return True

if __name__ == "__main__":
    camera = sys.argv[1] if len(sys.argv) > 1 else 0
    
    # Try to convert to int if it's a number
    try:
        camera = int(camera)
    except ValueError:
        pass  # It's an RTSP URL
    
    test_camera(camera)