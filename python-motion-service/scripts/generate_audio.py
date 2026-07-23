# scripts/generate_audio.py
from gtts import gTTS
import os

def generate_welcome_message():
    """Generate welcome audio message using Google Text-to-Speech"""
    
    # The message to convert to speech
    text = "Welcome to our shop! Please wait, I will be there in 5 minutes."
    
    # Create audio directory if it doesn't exist
    audio_dir = os.path.join(os.path.dirname(__file__), '..', 'audio')
    os.makedirs(audio_dir, exist_ok=True)
    
    # Output file path
    output_file = os.path.join(audio_dir, 'welcome_message.mp3')
    
    # Generate speech
    print(f"Generating audio message...")
    print(f"Text: {text}")
    
    tts = gTTS(text=text, lang='en', slow=False)
    tts.save(output_file)
    
    print(f"✅ Audio file generated successfully!")
    print(f"📁 Location: {output_file}")
    print(f"📊 Size: {os.path.getsize(output_file)} bytes")

def generate_custom_message(text, filename='custom_message.mp3', lang='en'):
    """Generate custom audio message"""
    
    audio_dir = os.path.join(os.path.dirname(__file__), '..', 'audio')
    os.makedirs(audio_dir, exist_ok=True)
    
    output_file = os.path.join(audio_dir, filename)
    
    print(f"Generating audio: {text}")
    tts = gTTS(text=text, lang=lang, slow=False)
    tts.save(output_file)
    
    print(f"✅ Saved to: {output_file}")

if __name__ == "__main__":
    # Generate default welcome message
    generate_welcome_message()
    
    # You can also generate custom messages
    # Uncomment to use:
    # generate_custom_message("Hello! Someone will assist you shortly.", "custom1.mp3")
    # generate_custom_message("नमस्ते! कृपया प्रतीक्षा करें।", "hindi_message.mp3", lang='hi')