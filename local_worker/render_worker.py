"""
Local PC On-Demand Render Worker
--------------------------------
Polls Supabase for jobs in status 'ready_for_pc'.
Downloads the script and assets, generates narration audio (Edge-TTS),
and uses GPU-accelerated FFmpeg (or CPU libx264) to produce the final .mp4 video.
Updates Supabase to 'completed'.
"""

import os
import sys
import json
import time
import shutil
import asyncio
import argparse
import subprocess
from pathlib import Path
from dotenv import load_dotenv

# Try importing supabase
try:
    from supabase import create_client, Client
except ImportError:
    print("Error: Missing supabase library. Run: pip install -r requirements.txt")
    sys.exit(1)

# Load environment from root .env or local .env
load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] Missing SUPABASE_URL or SUPABASE_KEY in environment variables.")
    print("Create a .env file with your Supabase credentials.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR = Path(__file__).resolve().parent / "temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)


def check_ffmpeg() -> bool:
    """Verifies that ffmpeg is available in the system PATH."""
    return shutil.which("ffmpeg") is not None


def get_encoder() -> str:
    """Checks if NVIDIA NVENC GPU encoder is available, otherwise falls back to libx264."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True
        )
        if "h264_nvenc" in result.stdout:
            print("[FFmpeg] NVIDIA NVENC GPU hardware acceleration detected.")
            return "h264_nvenc"
    except Exception:
        pass
    print("[FFmpeg] Using CPU encoder libx264.")
    return "libx264"


async def generate_narration_audio(text: str, output_path: Path, voice: str = "es-ES-AlvaroNeural"):
    """Generates Spanish voiceover narration using Edge-TTS."""
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(output_path))


def create_placeholder_image(output_path: Path, text: str, width: int = 1920, height: int = 1080):
    """Creates a stylized placeholder card image if no image URL is provided."""
    from PIL import Image, ImageDraw, ImageFont
    
    img = Image.new("RGB", (width, height), color=(15, 23, 42)) # Slate 900
    draw = ImageDraw.Draw(img)
    
    # Simple centered text
    lines = [text[i:i+50] for i in range(0, min(len(text), 250), 50)]
    y = height // 2 - (len(lines) * 30)
    for line in lines:
        draw.text((width // 4, y), line, fill=(241, 245, 249))
        y += 60

    img.save(str(output_path))


async def process_job(job: dict, encoder: str):
    job_id = job["id"]
    topic = job.get("topic", "video")
    title = job.get("title") or topic
    script_data = job.get("script_data") or {}
    scenes = script_data.get("scenes", [])

    print(f"\n========================================================")
    print(f"🎬 Processing Video Job: {title}")
    print(f"ID: {job_id} | Total Scenes: {len(scenes)}")
    print(f"========================================================")

    job_temp = TEMP_DIR / job_id
    job_temp.mkdir(parents=True, exist_ok=True)
    video_segments = []

    try:
        for idx, scene in enumerate(scenes, start=1):
            scene_num = scene.get("scene_number", idx)
            narration = scene.get("narration", "")
            visual_desc = scene.get("visual_description", "")
            duration = scene.get("duration_seconds", 6)

            audio_file = job_temp / f"scene_{scene_num}.mp3"
            image_file = job_temp / f"scene_{scene_num}.png"
            segment_video = job_temp / f"scene_{scene_num}.mp4"

            # 1. Audio generation
            print(f"  [{scene_num}/{len(scenes)}] Generando locución TTS...")
            if narration.strip():
                try:
                    await generate_narration_audio(narration, audio_file)
                except Exception as e:
                    print(f"    [Warn] TTS generation failed: {e}. Using silence.")
                    subprocess.run([
                        "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
                        "-t", str(duration), str(audio_file)
                    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run([
                    "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
                    "-t", str(duration), str(audio_file)
                ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            # 2. Image generation / placeholder
            create_placeholder_image(image_file, f"Escena {scene_num}\n{visual_desc}")

            # 3. Render segment with FFmpeg
            print(f"  [{scene_num}/{len(scenes)}] Renderizando segmento con FFmpeg ({encoder})...")
            cmd = [
                "ffmpeg", "-y",
                "-loop", "1", "-i", str(image_file),
                "-i", str(audio_file),
                "-c:v", encoder,
                "-tune", "stillimage",
                "-c:a", "aac",
                "-b:a", "192k",
                "-pix_fmt", "yuv420p",
                "-shortest",
                str(segment_video)
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            video_segments.append(segment_video)

        # 4. Concatenate all segments into final video
        concat_list_file = job_temp / "concat_list.txt"
        with open(concat_list_file, "w", encoding="utf-8") as f:
            for seg in video_segments:
                f.write(f"file '{seg.name}'\n")

        safe_title = "".join(c for c in title if c.isalnum() or c in (" ", "-", "_")).strip()[:50]
        final_video_name = f"{safe_title}_{job_id[:8]}.mp4"
        final_output_path = OUTPUT_DIR / final_video_name

        print(f"\n📦 Ensamblando vídeo final: {final_output_path.name}...")
        concat_cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_file),
            "-c", "copy",
            str(final_output_path)
        ]
        subprocess.run(concat_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        print(f"✅ ¡Renderizado completado con éxito! Guardado en:\n{final_output_path}")

        # 5. Update Supabase status to 'completed'
        supabase.table("youtube_pipeline").update({
            "status": "completed",
            "video_url": str(final_output_path),
            "error_message": None
        }).eq("id", job_id).execute()

        print(f"✨ Supabase actualizado a status='completed'.")

    except Exception as err:
        print(f"❌ Error durante el renderizado del job {job_id}: {err}")
        supabase.table("youtube_pipeline").update({
            "status": "error",
            "error_message": f"PC Render error: {str(err)}"
        }).eq("id", job_id).execute()
    finally:
        # Cleanup temp directory
        shutil.rmtree(job_temp, ignore_errors=True)


def fetch_ready_jobs():
    """Queries Supabase for jobs in status 'ready_for_pc'."""
    res = supabase.table("youtube_pipeline")\
        .select("*")\
        .eq("status", "ready_for_pc")\
        .order("created_at", desc=False)\
        .execute()
    return res.data or []


def main():
    parser = argparse.ArgumentParser(description="YouTube AI Local Render Worker")
    parser.add_argument("--once", action="store_true", help="Procesa los vídeos pendientes una sola vez y termina.")
    parser.add_argument("--poll-interval", type=int, default=30, help="Segundos entre consultas a Supabase en modo continuo (default: 30s).")
    args = parser.parse_args()

    if not check_ffmpeg():
        print("[ERROR] FFmpeg no está instalado o no se encuentra en el PATH del sistema.")
        print("Por favor, instala FFmpeg para continuar.")
        sys.exit(1)

    encoder = get_encoder()
    print("🚀 Iniciando Local Render Worker para YouTube Pipeline...")
    print(f"Conectado a Supabase: {SUPABASE_URL}")
    print(f"Carpeta de salida: {OUTPUT_DIR}")

    while True:
        try:
            jobs = fetch_ready_jobs()
            if jobs:
                print(f"🎯 Se encontraron {len(jobs)} vídeo(s) listos para renderizar.")
                for job in jobs:
                    asyncio.run(process_job(job, encoder))
            else:
                if args.once:
                    print("No hay vídeos en estado 'ready_for_pc'. Finalizando.")
                    break
                print(f"[{time.strftime('%H:%M:%S')}] Sin trabajo pendiente (esperando {args.poll_interval}s)...")

            if args.once:
                break

            time.sleep(args.poll_interval)

        except KeyboardInterrupt:
            print("\nDeteniendo worker por el usuario...")
            break
        except Exception as e:
            print(f"[Error en loop] {e}")
            time.sleep(10)


if __name__ == "__main__":
    main()
