# 🐳 panduan Docker Deploy & Migrasi Gistex AI Translator

Aplikasi **Gistex AI Translator** telah dilengkapi dengan konfigurasi kontainerisasi Docker lengkap yang mendukung **NVIDIA GPU CUDA Acceleration (RTX 3090)**, persisten data kamus `glossary.json`, cache model HuggingFace, dan Nginx Production Server.

---

## 🚀 Cara Menjalankan dengan Docker Compose

### 1. Prasyarat System
Pastikan server tujuan memiliki:
- **Docker Engine** & **Docker Compose**
- **NVIDIA Container Toolkit** (`nvidia-ctk` untuk GPU passthrough)

### 2. Menjalankan Kontainer
Jalankan perintah berikut di direktori proyek:

```bash
docker compose up -d --build
```

### 3. Akses Aplikasi
- **Frontend App**: `http://<IP-SERVER>:5173`
- **Backend API**: `http://<IP-SERVER>:8001`

---

## 📦 Cara Migrasi Server (Migration Guide)

Untuk memindahkan aplikasi ini ke server baru (misal server pabrik baru):

1. **Copy Seluruh Folder Proyek**:
   ```bash
   rsync -avz /home/gistex/translator/ user@server-baru:/home/gistex/translator/
   ```

2. **Jalankan Docker di Server Baru**:
   ```bash
   cd /home/gistex/translator
   docker compose up -d
   ```

Tampilan, model AI, kamus teknis `glossary.json`, dan seluruh fitur akan langsung aktif 100% di server baru tanpa perlu instalasi dependencies ulang!
