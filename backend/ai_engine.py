import os
import json
import logging
import asyncio
import numpy as np
import torch
import edge_tts
from faster_whisper import WhisperModel
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

logger = logging.getLogger(__name__)

GLOSSARY_FILE = os.path.join(os.path.dirname(__file__), "glossary.json")

def load_glossary() -> list:
    if os.path.exists(GLOSSARY_FILE):
        try:
            with open(GLOSSARY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load glossary.json: {e}")
    return []

def save_glossary(items: list):
    try:
        with open(GLOSSARY_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save glossary.json: {e}")

class SpeakerDiarizer:
    def __init__(self, device="cuda"):
        self.device = device if torch.cuda.is_available() else "cpu"
        logger.info(f"Loading Speaker Diarization Model (SpeechBrain ECAPA) on {self.device}...")
        run_opts = {"device": "cuda:0"} if self.device == "cuda" else {"device": "cpu"}
        try:
            try:
                # SpeechBrain < 1.0
                from speechbrain.pretrained import EncoderClassifier
            except ImportError:
                # SpeechBrain >= 1.0
                from speechbrain.inference.speaker import EncoderClassifier
            
            self.classifier = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                run_opts=run_opts
            )
        except Exception as e:
            logger.error(f"Failed to load SpeechBrain ECAPA: {e}")
            self.classifier = None
            
        self.speaker_centroids = [] # List of (speaker_label, embedding_tensor)
        self.speaker_count = 0

    def identify_speaker(self, audio_array: np.ndarray, max_speakers: int = 0) -> str:
        if not self.classifier or len(audio_array) < 8000:
            return "Speaker 1"
            
        try:
            with torch.no_grad():
                signal = torch.tensor(audio_array).unsqueeze(0).to(self.device)
                embeddings = self.classifier.encode_batch(signal)
                emb = embeddings.squeeze().cpu()
                del signal
                del embeddings
            
            best_sim = -1.0
            best_idx = -1
            best_speaker = None
            
            for idx, (spk_label, centroid) in enumerate(self.speaker_centroids):
                sim = torch.nn.functional.cosine_similarity(emb, centroid, dim=0).item()
                if sim > best_sim:
                    best_sim = sim
                    best_idx = idx
                    best_speaker = spk_label
                    
            logger.info(f"[DIARIZATION] best_sim={best_sim:.3f} against {best_speaker}")
            # Threshold 0.45: standar akustik optimal untuk SpeechBrain ECAPA
            if best_sim >= 0.45 and best_speaker:
                # Update centroid secara adaptif (Exponential Moving Average)
                old_label, old_centroid = self.speaker_centroids[best_idx]
                updated_centroid = 0.8 * old_centroid + 0.2 * emb
                self.speaker_centroids[best_idx] = (old_label, updated_centroid)
                return best_speaker
            else:
                # Jika max_speakers ditentukan (> 0) dan batas telah tercapai, hubungkan ke pembicara terdekat
                if max_speakers > 0 and len(self.speaker_centroids) >= max_speakers and best_speaker:
                    old_label, old_centroid = self.speaker_centroids[best_idx]
                    updated_centroid = 0.85 * old_centroid + 0.15 * emb
                    self.speaker_centroids[best_idx] = (old_label, updated_centroid)
                    return best_speaker
                    
                self.speaker_count += 1
                new_speaker = f"Speaker {self.speaker_count}"
                self.speaker_centroids.append((new_speaker, emb))
                return new_speaker
        except Exception as e:
            logger.error(f"Error in speaker diarization: {e}")
            return "Speaker 1"

class TranslatorPipeline:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.compute_type = "float16" if self.device == "cuda" else "int8"
        
        logger.info(f"Initializing AI Models on {self.device} (compute type: {self.compute_type})...")
        
        # 1. Load STT Model (faster-whisper large-v3 model)
        logger.info("Loading STT (faster-whisper large-v3 model)...")
        self.stt_model = WhisperModel("large-v3", device=self.device, compute_type=self.compute_type)
        
        # 2. Load NMT Model (NLLB-200-3.3B)
        logger.info("Loading NMT (NLLB-200-3.3B)...")
        model_name = "facebook/nllb-200-3.3B"
        self.nmt_tokenizer = AutoTokenizer.from_pretrained(
            model_name, 
            src_lang="eng_Latn", 
            tgt_lang="ind_Latn"
        )
        self.nmt_model = AutoModelForSeq2SeqLM.from_pretrained(
            model_name, 
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32
        ).to(self.device)
        
        # 3. Load Speaker Diarizer
        self.diarizer = SpeakerDiarizer(device=self.device)
        
        logger.info("AI Models Initialization Complete.")

    def get_domain_prompt(self) -> str:
        glossary = load_glossary()
        terms = [item["term"] for item in glossary if "term" in item]
        base_prompt = "Technical IT and Textile Industry terminology: Kubernetes, Docker, Ansible, VLAN, BGP, Subnetting, Latency, CI/CD, API, ERP, MES, PLC, SCADA, IoT, Spinning, Weaving, Jacquard loom, Warp, Weft, Yarn count, Denier, Mercerization, GSM, Dyeing, Finishing, Fabric."
        if terms:
            custom_terms = ", ".join(terms)
            return f"{base_prompt} Custom terms: {custom_terms}"
        return base_prompt

    def transcribe(self, audio_array: np.ndarray, source_lang: str = "en") -> str:
        domain_prompt = self.get_domain_prompt()
        logger.debug(f"Transcribing audio chunk with prompt: {domain_prompt[:60]}...")
        segments, _ = self.stt_model.transcribe(
            audio_array, 
            beam_size=5, 
            language=source_lang,
            initial_prompt=domain_prompt,
            vad_filter=True,
            condition_on_previous_text=False
        )
        text = " ".join([segment.text for segment in segments])
        return text.strip()

    def translate(self, text: str, source_lang_nllb: str = "eng_Latn", target_lang_nllb: str = "ind_Latn") -> str:
        if not text:
            return ""
        
        logger.debug(f"Translating text: {text} from {source_lang_nllb} to {target_lang_nllb}")
        
        # Override source lang if not English (default is eng_Latn)
        self.nmt_tokenizer.src_lang = source_lang_nllb
        
        with torch.no_grad():
            inputs = self.nmt_tokenizer(text, return_tensors="pt").to(self.device)
            
            translated_tokens = self.nmt_model.generate(
                **inputs, 
                forced_bos_token_id=self.nmt_tokenizer.convert_tokens_to_ids(target_lang_nllb),
                num_beams=4,
                max_length=150
            )
            translated_text = self.nmt_tokenizer.batch_decode(translated_tokens, skip_special_tokens=True)[0]
            
            del inputs
            del translated_tokens
            
            # Optionally empty cache periodically if memory is a concern
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        
        # Apply glossary post-processing replacement
        glossary = load_glossary()
        for item in glossary:
            term = item.get("term", "")
            replacement = item.get("translation", "")
            if term and replacement and term.lower() in translated_text.lower():
                # Case-insensitive replacement
                import re
                translated_text = re.sub(re.escape(term), replacement, translated_text, flags=re.IGNORECASE)
                
        return translated_text

    async def synthesize_async(self, text: str, voice: str = "id-ID-ArdiNeural") -> bytes:
        if not text:
            return b""
        try:
            logger.debug(f"Synthesizing Natural SSML TTS via edge-tts ({voice}): {text[:30]}...")
            
            # Format text with SSML Prosody for natural human intonation and cadence
            # rate='-4%' gives a deliberate human speaking pace; pitch adjustment prevents robotic monotony
            clean_text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            ssml_payload = (
                f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='id-ID'>"
                f"<voice name='{voice}'>"
                f"<prosody rate='-4%' pitch='+0Hz'>{clean_text}</prosody>"
                f"</voice></speak>"
            )
            
            communicate = edge_tts.Communicate(text=ssml_payload, voice=voice)
            audio_data = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_data += chunk["data"]
            return audio_data
        except Exception as e:
            logger.warn(f"SSML synthesis fallback to plain text due to: {e}")
            try:
                communicate = edge_tts.Communicate(text=text, voice=voice)
                audio_data = b""
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_data += chunk["data"]
                return audio_data
            except Exception as ex:
                logger.error(f"Fallback TTS failed: {ex}")
                return b""

    def process_pipeline(self, audio_array: np.ndarray, source_lang: str = "en", target_lang: str = "id") -> dict:
        # Mapping languages
        nllb_map = {
            "en": "eng_Latn",
            "id": "ind_Latn",
            "ja": "jpn_Jpan",
            "ko": "kor_Hang",
            "zh": "zho_Hans",
            "es": "spa_Latn",
            "fr": "fra_Latn"
        }
        
        source_lang_nllb = nllb_map.get(source_lang, "eng_Latn")
        target_lang_nllb = nllb_map.get(target_lang, "ind_Latn")
        
        source_text = self.transcribe(audio_array, source_lang=source_lang)
        speaker = self.diarizer.identify_speaker(audio_array) if source_text else "Speaker 1"
        
        if source_lang == target_lang:
            translated_text = source_text
        else:
            translated_text = self.translate(source_text, source_lang_nllb, target_lang_nllb) if source_text else ""
        
        logger.info(f"[PIPELINE RESULT] [{speaker}] STT ({source_lang}): '{source_text}' -> NMT ({target_lang}): '{translated_text}'")
        
        return {
            "speaker": speaker,
            "source_text": source_text,
            "translated_text": translated_text,
        }
