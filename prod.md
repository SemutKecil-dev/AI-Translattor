Prod.md: Pipeline MVP Inggris → Indonesia (web-first, on-premise)

Tujuan dan ruang lingkup

Fokus utama: live translation real-time dari bahasa Inggris (berbagai aksen) ke bahasa Indonesia, versi web-first dan on-premise.

MVP on-premise di satu PC dengan GPU RTX 3090 24GB; latency end-to-end target: 1.5–2.5 detik per kanal untuk 1–3 kanal awal.

Input audio dari web: mikrofon langsung dan sharing audio dari aplikasi lain di PC via Web Audio API / Audio Capture API (jika browser mendukung).

Arsitektur high-level

Komponen utama:

Ingestor audio web: halaman web dengan Web Audio API untuk capture mikrofon, plus kemampuan memilih sumber audio lain melalui AudioContext/MediaStreamDestination.

STT Inggris (streaming): WhisperX/faster-whisper dengan VAD (jika menggunakan WhisperX, integrasi VAD sudah terpasang).

NMT Inggris → Indonesia: NLLB-200 baseline (1.3B/600M untuk MVP; quantization 8-bit sebagai opsi).

TTS Indonesia: XTTS Indonesian voice (opsional fallback Piper TTS jika latency tinggi).

Observability: Prometheus + Grafana untuk latency, throughput, memori GPU, dan error rate.

Orchestrator/Serving: backend lokal (FastAPI + WebSocket) dengan multi-kanal batching.

Alur data:
Audio input web → STT Inggris → Teks Inggris → NMT Inggris-Indonesia → Teks Indonesia → TTS Indonesia → Audio output di browser.

Stack teknis yang direkomendasikan

Frontend web:

Teknologi: React (atau Vue) + WebSocket untuk streaming; Web Audio API untuk capture mikrofon dan sharing audio.

Fitur: pilihan input device (mikrofon, virtual audio cable/loopback), pengaturan latency, status koneksi, kontrol volume.

Backend/serving:

FastAPI + WebSocket endpoints untuk streaming audio dan audio output.

Inference stack: WhisperX/faster-whisper (STT), NLLB-200 (1.3B/600M dengan quantization), XTTS Indonesia.

Optimisasi: FP16; quantization 8-bit untuk NLLB-200 MVP; batch streaming 2–4 detik.

Infrastruktur lokal:

CUDA driver terbaru untuk RTX 3090; cuDNN terbaru.

Packaging: Docker untuk konsistensi lingkungan; Nvidia-docker jika diperlukan.

Observability/Logs:

Prometheus endpoint; Grafana dashboard untuk latency per kanal, GPU memori, throughput, dan error rate.

Logging per sesi dengan timestamp, input source, latency, dan metadata kanal.

MVP pipeline detail

Step 1: Input audio lewat halaman web dengan opsi input device; streaming ke backend via WebSocket.

Step 2: STT Inggris menghasilkan teks sumber secara streaming.

Step 3: NMT Inggris→Indonesia menghasilkan teks Indonesia.

Step 4: TTS Indonesia menghasilkan audio output; streaming balik ke klien.

Step 5: Sinkronisasi lip-sync dasar dan playback di browser.

Step 6: Logging performa di backend dan metrics di dashboard.

Konfigurasi model (awal)

STT Inggris: WhisperX/faster-whisper (mode streaming) dengan chunk 2–4 detik.

NMT Inggris→Indonesia: NLLB-200 (1.3B/600M) dengan quantization 8-bit untuk MVP; evaluasi jika perlu.

TTS Indonesia: XTTS Indonesian voice; fallback Piper TTS jika latensi terlalu tinggi.

Perangkat keras: satu RTX 3090 24GB; dukung 1–3 kanal paralel.

Setup lingkungan (langkah praktis)

Browser:

Pastikan izin mikrofon diberikan; jika ingin sharing audio sistem, gunakan virtual audio device (mis. VB-Audio Virtual Cable) dan pilih sebagai input di halaman web.

Backend:

Buat environment Python 3.11+, virtualenv.

Pasang paket: transformers, accelerate, onnxruntime-gpu (jika menggunakan ONNX), librosa, soundfile, uvicorn, fastapi, websockets, prometheus-client.

Sharing audio setup:

Install virtual audio device pada OS; konfigurasikan input sebagai perangkat streaming untuk web input.

Endpoints utama:

/ws/stream untuk audio input

/ws/output untuk audio output (jika streaming balik ke client)

/metrics untuk Prometheus

Uji coba:

Uji end-to-end latency dengan audio contoh; ukur time-stamps di tiap tahap.

Verifikasi bahwa multi-kanal bisa berjalan tanpa swap memori berlebih.

Observability:

Jalankan Prometheus dan Grafana; buat dashboard latency kanal, GPU memory, dan throughput.

Diagram arsitektur (Mermaid)

Diagram berikut bisa ditempelkan langsung di prod.md. Copy-paste blok ini sesuai konteks.



flowchart TD
  A[Input Audio Web<br/>(Mikrofon + Sharing Audio via Virtual Device)] --> B[Web Audio Capture]
  B --> C{WhisperX streaming}
  C --> D[STT Inggris]
  D --> E[NMT Inggris→Indonesia]
  E --> F[TTS Indonesia]
  F --> G[Output Audio to Web]
  G --> H[User/Client]
  subgraph Observability
    I[Prometheus endpoint]
    J[Grafana dashboard]
  end
  G --> I
  I --> J
  style A fill:#f9f,stroke:#333,stroke-width:1px
  style B fill:#eaf,stroke:#333,stroke-width:1px
  style C fill:#ffd6a5,stroke:#333,stroke-width:1px
  style D fill:#c1e1c5,stroke:#333,stroke-width:1px
  style E fill:#d0e4f9,stroke:#333,stroke-width:1px
  style F fill:#f9d6e5,stroke:#333,stroke-width:1px
  style G fill:#d9f7d9,stroke:#333,stroke-width:1px
  style H fill:#fff,stroke:#333,stroke-width:1px
  style I fill:#cfe2ff,stroke:#333,stroke-width:1px
  style J fill:#ffd9e8,stroke:#333,stroke-width:1px
Pengujian dan kualitas

Target end-to-end latency MVP: < 2 detik per kanal untuk 1–3 kanal.

Evaluasi: WER untuk bahasa Inggris (opsional) dan kualitas TTS Indonesia.

Uji sumber audio beragam: mikrofon jarak dekat/jauh, noise, dan kemampuan sharing audio browser.

Rencana ekspansi pasca-MVP

Tambah aksen Inggris (AS/UK/AU) jika diperlukan dengan data input tambahan.

Tambah bahasa lain (Mandarin/Korea) jika diperlukan dengan fallback mode offline ringan.

UX: opsi bahasa input/output, preferensi suara Indonesia, dan dashboards lanjutan.

Risiko dan mitigasi

Browser support untuk sharing audio: variasi antar browser; mitigasi dengan virtual audio device yang stabil.

Latensi saat menambah kanal: gunakan dynamic batching, model ukuran adaptif, dan fallback ke model lebih ringan saat beban tinggi.

Privasi data audio: enkripsi, retensi data minimal, dan kebijakan akses lokal.
