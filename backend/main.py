import asyncio
import logging
import io
import numpy as np
from pydub import AudioSegment
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from ai_engine import TranslatorPipeline
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import make_asgi_app, Counter, Histogram

# Konfigurasi Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Inisialisasi Aplikasi FastAPI
app = FastAPI(title="Gistex AI Translator Enterprise", version="2.0.0")

translator = None

@app.on_event("startup")
async def startup_event():
    global translator
    logger.info("Starting up API, loading AI models...")
    # Loading model AI bisa memakan waktu cukup lama (hingga 10-30 detik)
    translator = TranslatorPipeline()

# Setup CORS (untuk web frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Ganti dengan domain frontend spesifik di production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Prometheus Metrics ---
# Endpoint metrics untuk Prometheus
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)

# Definisikan metrik contoh
CONNECTIONS_COUNTER = Counter("websocket_connections_total", "Total WebSocket connections")
AUDIO_CHUNKS_PROCESSED = Counter("audio_chunks_processed_total", "Total audio chunks processed")
LATENCY_HISTOGRAM = Histogram("end_to_end_latency_seconds", "End to end translation latency in seconds")

import base64
import httpx
from pydantic import BaseModel
from ai_engine import TranslatorPipeline, load_glossary, save_glossary

@app.get("/")
async def root():
    return {"status": "ok", "message": "Translator Pipeline Backend is running"}

# ----------------- GLOSSARY API ENDPOINTS -----------------
class GlossaryItem(BaseModel):
    term: str
    translation: str

@app.get("/api/glossary")
async def get_glossary_api():
    return load_glossary()

@app.post("/api/glossary")
async def add_glossary_api(item: GlossaryItem):
    items = load_glossary()
    items = [i for i in items if i.get("term", "").lower() != item.term.lower()]
    items.append({"term": item.term, "translation": item.translation})
    save_glossary(items)
    return {"status": "success", "glossary": items}

@app.delete("/api/glossary/{term}")
async def delete_glossary_api(term: str):
    items = load_glossary()
    items = [i for i in items if i.get("term", "").lower() != term.lower()]
    save_glossary(items)
    return {"status": "success", "glossary": items}

# ----------------- OLLAMA MEETING SUMMARY (MoM) API -----------------
class SummarizeRequest(BaseModel):
    transcript: list
    model: str = "qwen2.5:latest"

@app.post("/api/summarize")
async def summarize_api(req: SummarizeRequest):
    if not req.transcript:
        return {"status": "error", "detail": "Transkrip masih kosong."}

    lines = []
    for s in req.transcript:
        spk = s.get("speaker", "Speaker")
        time = s.get("timestamp", "")
        src = s.get("source", "")
        trans = s.get("translation", "")
        lines.append(f"[{time}] [{spk}]\nEnglish: {src}\nIndonesia: {trans}\n")

    full_text = "\n".join(lines)

    prompt = f"""Anda adalah Sekretaris Eksekutif AI profesional untuk tim IT dan Manufaktur Pabrik Tekstil.
Tugas Anda adalah menganalisis transkrip percakapan rapat berikut dan menghasilkan dokumen Minutes of Meeting (MoM) / Ringkasan Rapat yang sangat rapi, profesional, dan terstruktur dalam Bahasa Indonesia.

[TRANSKRIP PERCAKAPAN]:
{full_text}

Tolong hasilkan Ringkasan Rapat (MoM) dengan format Markdown berikut:
# 📋 RINGKASAN RAPAT (MINUTES OF MEETING)

## 📌 1. Ringkasan Eksekutif & Topik Utama
(Tuliskan ringkasan singkat 2-3 kalimat mengenai fokus percakapan).

## 👥 2. Peserta / Pembicara Terlibat
(Daftar pembicara yang aktif berbicara).

## 💡 3. Poin-Poin Diskusi Penting
(Bullet points pembahasan teknis IT, operasional pabrik, atau topik utama).

## 🛠️ 4. Kendala & Isu Teknis yang Dibahas
(Sebutkan kendala IT, masalah mesin, atau isu yang muncul).

## ✅ 5. Action Items & Langkah Selanjutnya
(Daftar tindakan yang harus diambil beserta penanggung jawab jika ada).
"""

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post("http://localhost:11434/api/generate", json={
                "model": req.model,
                "prompt": prompt,
                "stream": False
            })
            if resp.status_code == 200:
                result_json = resp.json()
                return {"status": "success", "summary": result_json.get("response", "")}
            else:
                return {"status": "error", "detail": f"Ollama error: {resp.text}"}
    except Exception as e:
        logger.error(f"Error calling Ollama API: {e}")
        return {"status": "error", "detail": f"Gagal menghubungi Ollama: {str(e)}"}


# --- WebSocket Endpoints ---

@app.websocket("/ws/stream")
async def websocket_stream_endpoint(websocket: WebSocket):
    """
    Endpoint untuk menerima streaming audio input dari client (mikrofon/sharing web).
    """
    await websocket.accept()
    CONNECTIONS_COUNTER.inc()
    client_host = websocket.client.host
    logger.info(f"Client connected for input streaming: {client_host}")
    logger.info(f"Client connected to PCM WebSocket streaming: {websocket.client.host}")
    
    pcm_buffer = bytearray()
    SAMPLE_RATE = 16000
    BYTES_PER_SAMPLE = 4
    
    MIN_WINDOW_SEC = 1.0
    MAX_WINDOW_SEC = 10.0
    
    min_bytes_needed = int(SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_WINDOW_SEC)
    max_bytes_needed = int(SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_WINDOW_SEC)
    
    enable_tts = False
    tts_voice = "id-ID-ArdiNeural"
    source_lang = "en"
    target_lang = "id"
    last_processed_bytes = 0
    
    try:
        while True:
            data = await websocket.receive()
            
            if "text" in data:
                import json as json_lib
                try:
                    cfg = json_lib.loads(data["text"])
                    if "enable_tts" in cfg:
                        enable_tts = bool(cfg["enable_tts"])
                    if "tts_voice" in cfg:
                        tts_voice = str(cfg["tts_voice"])
                    if "source_lang" in cfg:
                        source_lang = str(cfg["source_lang"])
                    if "target_lang" in cfg:
                        target_lang = str(cfg["target_lang"])
                except Exception:
                    pass
                continue
                
            if "bytes" in data and data["bytes"]:
                chunk = data["bytes"]
                pcm_buffer.extend(chunk)
                AUDIO_CHUNKS_PROCESSED.inc()
                
                # Check for interim or final processing
                if len(pcm_buffer) - last_processed_bytes >= min_bytes_needed:
                    audio_array = np.frombuffer(bytes(pcm_buffer), dtype=np.float32)
                    
                    recent_samples = audio_array[-int(SAMPLE_RATE * 0.4):]
                    rms = np.sqrt(np.mean(recent_samples ** 2)) if len(recent_samples) > 0 else 0
                    
                    is_silence = rms < 0.008
                    is_max_length = len(pcm_buffer) >= max_bytes_needed
                    
                    if is_silence or is_max_length:
                        # FINAL PASS (Translation + TTS + Diarization)
                        audio_to_process = audio_array.copy()
                        pcm_buffer.clear()
                        last_processed_bytes = 0
                        
                        result = translator.process_pipeline(audio_to_process, source_lang, target_lang)
                        
                        if result["source_text"] or result["translated_text"]:
                            audio_b64 = None
                            if enable_tts and result["translated_text"]:
                                tts_bytes = await translator.synthesize_async(result["translated_text"], voice=tts_voice)
                                if tts_bytes:
                                    audio_b64 = base64.b64encode(tts_bytes).decode("utf-8")
                            
                            await websocket.send_json({
                                "status": "processed",
                                "speaker": result.get("speaker", "Speaker 1"),
                                "source_text": result["source_text"],
                                "translated_text": result["translated_text"],
                                "audio_b64": audio_b64,
                                "is_final": True
                            })
                    else:
                        # INTERIM PASS (STT Only, Fast)
                        last_processed_bytes = len(pcm_buffer)
                        audio_to_process = audio_array.copy()
                        
                        source_text = translator.transcribe(audio_to_process, source_lang=source_lang)
                        if source_text:
                            await websocket.send_json({
                                "status": "processed",
                                "speaker": "Speaker 1",
                                "source_text": source_text,
                                "translated_text": "",
                                "audio_b64": None,
                                "is_final": False
                            })
    except WebSocketDisconnect:
        logger.info(f"Client disconnected from input streaming: {websocket.client.host}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass

@app.websocket("/ws/output")
async def websocket_output_endpoint(websocket: WebSocket):
    """
    Endpoint untuk mengirimkan streaming audio hasil terjemahan (TTS) ke client.
    """
    await websocket.accept()
    client_host = websocket.client.host
    logger.info(f"Client connected for output streaming: {client_host}")
    
    try:
        while True:
            # Endpoint ini mungkin kebanyakan mengirim data ke client, 
            # tapi kita butuh trigger atau keeping connection alive
            msg = await websocket.receive_text()
            
            # TODO: 
            # 1. Ambil data audio TTS yang sudah jadi dari queue/buffer
            # 2. await websocket.send_bytes(audio_bytes)
            
            await websocket.send_json({"message": "Ready to send audio"})
            
    except WebSocketDisconnect:
        logger.info(f"Client disconnected from output streaming: {client_host}")
    except Exception as e:
        logger.error(f"Error in output endpoint: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    # Jalankan server tanpa string import agar tidak double-execution
    uvicorn.run(app, host="0.0.0.0", port=8001)
