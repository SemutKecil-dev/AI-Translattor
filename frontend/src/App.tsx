import { useState, useEffect, useRef } from 'react'

interface SentenceBlock {
  id: string
  speaker: string
  source: string
  translation: string
  timestamp: string
  isLatest?: boolean
}

interface GlossaryItem {
  term: string
  translation: string
}

// Manajer Antrean Audio Sekuensial
class AudioQueueManager {
  private queue: string[] = []
  private isPlaying: boolean = false
  private currentAudio: HTMLAudioElement | null = null

  public enqueue(base64Audio: string) {
    this.queue.push(base64Audio)
    if (!this.isPlaying) {
      this.playNext()
    }
  }

  private playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false
      this.currentAudio = null
      return
    }

    this.isPlaying = true
    const nextB64 = this.queue.shift()!
    try {
      this.currentAudio = new Audio("data:audio/mp3;base64," + nextB64)
      this.currentAudio.onended = () => {
        this.playNext()
      }
      this.currentAudio.onerror = (e) => {
        console.error("Audio playback error:", e)
        this.playNext()
      }
      this.currentAudio.play().catch(e => {
        console.warn("Audio play blocked by browser policy:", e)
        this.playNext()
      })
    } catch (err) {
      console.error("Audio queue manager error:", err)
      this.playNext()
    }
  }

  public clear() {
    this.queue = []
    if (this.currentAudio) {
      this.currentAudio.pause()
      this.currentAudio = null
    }
    this.isPlaying = false
  }
}

const audioQueue = new AudioQueueManager()

// Component Effect Typing (Typewriter) dengan Callback Selesai mengetik (onComplete)
function TypewriterText({ text, speed = 18, onType, onComplete }: { text: string; speed?: number; onType?: () => void; onComplete?: () => void }) {
  const [displayedText, setDisplayedText] = useState('')

  useEffect(() => {
    let index = 0
    setDisplayedText('')

    const timer = setInterval(() => {
      if (index < text.length) {
        setDisplayedText(text.substring(0, index + 1))
        index++
        if (onType) onType()
      } else {
        clearInterval(timer)
        if (onComplete) onComplete()
      }
    }, speed)

    return () => clearInterval(timer)
  }, [text, speed, onType, onComplete])

  return (
    <span>
      {displayedText}
      {displayedText.length < text.length && <span className="typewriter-cursor">|</span>}
    </span>
  )
}

function App() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [activeSource, setActiveSource] = useState<'system' | 'mic'>('system')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  
  // TTS Settings
  const [isTtsEnabled, setIsTtsEnabled] = useState<boolean>(false)
  const [ttsVoice, setTtsVoice] = useState<string>('id-ID-GadisNeural')
  
  // Modals
  const [showGlossaryModal, setShowGlossaryModal] = useState<boolean>(false)
  const [glossaryItems, setGlossaryItems] = useState<GlossaryItem[]>([])
  const [newTerm, setNewTerm] = useState('')
  const [newTranslation, setNewTranslation] = useState('')
  
  const [showMomModal, setShowMomModal] = useState<boolean>(false)
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>('qwen2.5:latest')
  const [momResult, setMomResult] = useState<string>('')
  const [isGeneratingMom, setIsGeneratingMom] = useState<boolean>(false)
  
  const [sentences, setSentences] = useState<SentenceBlock[]>([])
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [isPresenterMode, setIsPresenterMode] = useState<boolean>(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  
  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  
  const gridScrollRef = useRef<HTMLDivElement | null>(null)
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null)
  const presenterAnchorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("Browser tidak mendukung Web Audio API.");
      setDevices([{ deviceId: "none", kind: "audioinput", label: "Perangkat Audio Tidak Ditemukan", groupId: "" } as MediaDeviceInfo]);
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(() => {
        navigator.mediaDevices.enumerateDevices()
          .then(deviceList => {
            const audioInputs = deviceList.filter(d => d.kind === 'audioinput')
            setDevices(audioInputs)
            if (audioInputs.length > 0) {
              setSelectedDevice(audioInputs[0].deviceId)
            }
          })
      })
      .catch(err => {
        console.error("Gagal mendapatkan izin mikrofon:", err)
      })

    return () => stopStreaming()
  }, [])

  // Auto-scroll ke paling bawah
  const scrollToBottom = () => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    if (presenterAnchorRef.current) {
      presenterAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  useEffect(() => {
    scrollToBottom();
  }, [sentences]);

  // Flush audio queue & turn off active highlights when TTS is disabled
  useEffect(() => {
    if (!isTtsEnabled) {
      audioQueue.clear()
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        enable_tts: isTtsEnabled,
        tts_voice: ttsVoice
      }))
    }
  }, [isTtsEnabled, ttsVoice])

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 2500)
  }

  const [audioPauseWarning, setAudioPauseWarning] = useState<boolean>(false)
  const lastAudioTimeRef = useRef<number>(Date.now())

  // Check if audio input has gone silent/paused for more than 5 seconds
  useEffect(() => {
    let interval: any = null;
    if (isStreaming) {
      interval = setInterval(() => {
        if (Date.now() - lastAudioTimeRef.current > 5000) {
          setAudioPauseWarning(true);
        } else {
          setAudioPauseWarning(false);
        }
      }, 2000);
    } else {
      setAudioPauseWarning(false);
    }
    return () => clearInterval(interval);
  }, [isStreaming]);

  // Callback ketika animasi ketikan kalimat tertentu selesai
  const handleTypingComplete = (id: string) => {
    setSentences(prev => prev.map(s => s.id === id ? { ...s, isLatest: false } : s))
  }

  const startStreaming = (useSystemAudio = activeSource === 'system') => {
    try {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/stream`;
      wsRef.current = new WebSocket(wsUrl)
      
      wsRef.current.onopen = async () => {
        setIsConnected(true)
        setIsStreaming(true)
        audioQueue.clear()
        lastAudioTimeRef.current = Date.now()
        
        if (wsRef.current) {
          wsRef.current.send(JSON.stringify({
            enable_tts: isTtsEnabled,
            tts_voice: ttsVoice
          }))
        }
        
        try {
          let stream: MediaStream;
          if (useSystemAudio) {
            stream = await navigator.mediaDevices.getDisplayMedia({ 
              audio: true,
              video: true
            });
          } else {
            stream = await navigator.mediaDevices.getUserMedia({ 
              audio: { 
                deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
                echoCancellation: true,
                noiseSuppression: true
              } 
            });
          }
          
          const audioStream = new MediaStream(stream.getAudioTracks());
          const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
          audioContextRef.current = audioContext;
          
          const source = audioContext.createMediaStreamSource(audioStream);
          const processor = audioContext.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          
          processor.onaudioprocess = (e) => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              if (rms > 0.005) {
                lastAudioTimeRef.current = Date.now();
              }
              wsRef.current.send(inputData.buffer);
            }
          };
          
          const gainNode = audioContext.createGain();
          gainNode.gain.value = 0;
          
          source.connect(processor);
          processor.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          if (useSystemAudio) {
            stream.getVideoTracks()[0].onended = () => {
              showToast("Sharing tab/video dihentikan oleh pengguna.");
              stopStreaming();
            };
          }
        } catch (err) {
          console.error("Gagal membuka audio stream:", err);
          setIsStreaming(false)
          setIsConnected(false)
        }
      }
      
      wsRef.current.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.status === "processed") {
          if (response.source_text || response.translated_text) {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            const newBlock: SentenceBlock = {
              id: Math.random().toString(36).substring(2, 9),
              speaker: response.speaker || "Speaker 1",
              source: response.source_text || "",
              translation: response.translated_text || "",
              timestamp: timeStr,
              isLatest: true
            }

            setSentences(prev => {
              const updated = prev.map(s => ({ ...s, isLatest: false }))
              return [...updated, newBlock]
            })

            if (isTtsEnabled && response.audio_b64) {
              audioQueue.enqueue(response.audio_b64)
            }
          }
        }
      }

      wsRef.current.onclose = () => {
        setIsConnected(false)
        setIsStreaming(false)
        audioQueue.clear()
        setSentences(prev => prev.map(s => ({ ...s, isLatest: false })))
      }
      
      wsRef.current.onerror = (error) => {
        console.error("WebSocket error:", error)
        setIsConnected(false)
        setIsStreaming(false)
        audioQueue.clear()
        setSentences(prev => prev.map(s => ({ ...s, isLatest: false })))
      }
      
    } catch (e) {
      console.error("Koneksi gagal", e)
    }
  }

  const stopStreaming = () => {
    audioQueue.clear()
    setSentences(prev => prev.map(s => ({ ...s, isLatest: false })))
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close()
    }
    setIsStreaming(false)
    setIsConnected(false)
  }

  // Glossary Functions
  const fetchGlossary = async () => {
    try {
      const res = await fetch("/api/glossary");
      const data = await res.json();
      setGlossaryItems(data);
    } catch (err) {
      console.error("Failed to fetch glossary:", err);
    }
  }

  const handleAddGlossary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTerm.trim() || !newTranslation.trim()) return;
    try {
      const res = await fetch("/api/glossary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: newTerm.trim(), translation: newTranslation.trim() })
      });
      const data = await res.json();
      if (data.status === "success") {
        setGlossaryItems(data.glossary);
        setNewTerm('');
        setNewTranslation('');
        showToast(`Istilah "${newTerm}" berhasil ditambahkan.`);
      }
    } catch (err) {
      console.error("Failed to add glossary:", err);
    }
  }

  const handleDeleteGlossary = async (term: string) => {
    try {
      const res = await fetch(`/api/glossary/${encodeURIComponent(term)}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.status === "success") {
        setGlossaryItems(data.glossary);
        showToast(`Istilah "${term}" dihapus.`);
      }
    } catch (err) {
      console.error("Failed to delete glossary:", err);
    }
  }

  // MoM Summarizer Function
  const handleGenerateMom = async () => {
    if (sentences.length === 0) {
      showToast("Transkrip masih kosong. Mulai stream percakapan terlebih dahulu.");
      return;
    }
    setIsGeneratingMom(true);
    setMomResult('');
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: sentences,
          model: selectedOllamaModel
        })
      });
      const rawText = await res.text();
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        setMomResult(`Error Response (HTTP ${res.status}): ${rawText.substring(0, 150)}`);
        return;
      }
      
      if (data.status === "success") {
        setMomResult(data.summary);
      } else {
        setMomResult(`Error: ${data.detail || "Gagal membuat ringkasan."}`);
      }
    } catch (err: any) {
      setMomResult(`Gagal menghubungi server Ollama: ${err.message}`);
    } finally {
      setIsGeneratingMom(false);
    }
  }

  const handleCopy = (type: 'source' | 'translation' | 'mom') => {
    let text = "";
    if (type === 'mom') {
      text = momResult;
    } else {
      text = sentences
        .map(s => type === 'source' ? `[${s.speaker}] ${s.source}` : `[${s.speaker}] ${s.translation}`)
        .filter(Boolean)
        .join("\n");
    }

    if (!text) return;
    navigator.clipboard.writeText(text);
    showToast("Teks berhasil disalin ke clipboard.");
  }

  const handleExportTxt = () => {
    if (sentences.length === 0) return;
    const content = sentences
      .map(s => `[${s.timestamp}] [${s.speaker}]\nEN: ${s.source}\nID: ${s.translation}\n`)
      .join("\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `translator-export-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("File transkrip (.txt) berhasil di-export.");
  }

  const handleClear = () => {
    setSentences([]);
    audioQueue.clear();
    showToast("Riwayat percakapan dibersihkan.");
  }

  const filteredSentences = sentences.filter(s => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return s.source.toLowerCase().includes(q) || s.translation.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q);
  });

  const getSpeakerClass = (speaker?: string) => {
    if (!speaker) return "spk-1";
    if (speaker.endsWith("1")) return "spk-1";
    if (speaker.endsWith("2")) return "spk-2";
    if (speaker.endsWith("3")) return "spk-3";
    return "spk-4";
  }

  return (
    <div className="enterprise-container">
      {/* Toast Alert */}
      {toastMessage && <div className="ep-toast">{toastMessage}</div>}

      {/* GLOSSARY MODAL */}
      {showGlossaryModal && (
        <div className="ep-modal-overlay">
          <div className="ep-modal-card">
            <div className="ep-modal-header">
              <div className="ep-modal-title">📖 Kamus Teknis IT & Tekstil (Custom Glossary)</div>
              <button className="ep-icon-btn" onClick={() => setShowGlossaryModal(false)}>✕</button>
            </div>
            <div className="ep-modal-body">
              <form onSubmit={handleAddGlossary} className="ep-glossary-form">
                <input 
                  type="text" 
                  className="ep-input" 
                  placeholder="Istilah Inggris (misal: Warp)"
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                />
                <input 
                  type="text" 
                  className="ep-input" 
                  placeholder="Terjemahan Kustom (misal: Benang Lusi)"
                  value={newTranslation}
                  onChange={(e) => setNewTranslation(e.target.value)}
                />
                <button type="submit" className="ep-btn-start" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                  + Tambah
                </button>
              </form>

              <table className="ep-glossary-table">
                <thead>
                  <tr>
                    <th>Istilah Teknis (Source)</th>
                    <th>Terjemahan Kustom (Target)</th>
                    <th style={{ width: '80px', textAlign: 'center' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {glossaryItems.map((item, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600, color: 'var(--primary)' }}>{item.term}</td>
                      <td>{item.translation}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button className="ep-icon-btn" style={{ color: 'var(--danger)' }} onClick={() => handleDeleteGlossary(item.term)}>
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-icon-btn" onClick={() => setShowGlossaryModal(false)}>Tutup</button>
            </div>
          </div>
        </div>
      )}

      {/* OLLAMA MoM MODAL */}
      {showMomModal && (
        <div className="ep-modal-overlay">
          <div className="ep-modal-card" style={{ maxWidth: '800px' }}>
            <div className="ep-modal-header">
              <div className="ep-modal-title">✨ Ringkasan Rapat AI (Ollama MoM Generator)</div>
              <button className="ep-icon-btn" onClick={() => setShowMomModal(false)}>✕</button>
            </div>
            <div className="ep-modal-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Model Ollama:</span>
                <select 
                  className="ep-select"
                  value={selectedOllamaModel}
                  onChange={(e) => setSelectedOllamaModel(e.target.value)}
                >
                  <option value="qwen2.5:latest">Qwen 2.5 (7.6B) - Recommended</option>
                  <option value="llama3.1:8b">Llama 3.1 (8B)</option>
                  <option value="mistral-nemo:latest">Mistral Nemo (12.2B)</option>
                  <option value="deepseek-r1:latest">DeepSeek R1 (8.2B Reasoning)</option>
                </select>
                <button 
                  className="ep-btn-start" 
                  style={{ padding: '0.45rem 1.2rem', fontSize: '0.85rem' }} 
                  onClick={handleGenerateMom}
                  disabled={isGeneratingMom}
                >
                  {isGeneratingMom ? "⏳ Membuat Ringkasan..." : "🔄 Generate MoM"}
                </button>
              </div>

              {isGeneratingMom ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary)', fontStyle: 'italic' }}>
                  Ollama AI sedang merangkum transkrip percakapan rapat... Mohon tunggu beberapa detik.
                </div>
              ) : momResult ? (
                <pre className="ep-mom-container">{momResult}</pre>
              ) : (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-faint)', fontStyle: 'italic' }}>
                  Klik "Generate MoM" untuk membuat dokumen Minutes of Meeting terstruktur dari transkrip rapat.
                </div>
              )}
            </div>
            <div className="ep-modal-footer">
              {momResult && (
                <button className="ep-icon-btn" onClick={() => handleCopy('mom')}>
                  📋 Salin MoM
                </button>
              )}
              <button className="ep-icon-btn" onClick={() => setShowMomModal(false)}>Tutup</button>
            </div>
          </div>
        </div>
      )}

      {/* Presenter / Subtitle Overlay Mode */}
      {isPresenterMode && (
        <div className="ep-presenter-overlay">
          <div className="ep-presenter-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className="ep-badge-pro">LIVE SUBTITLE MODE</span>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Auto-scrolling Presentation View</span>
            </div>
            <button className="ep-icon-btn" style={{ fontSize: '0.9rem', padding: '0.5rem 1rem' }} onClick={() => setIsPresenterMode(false)}>
              ✕ Keluar Presenter Mode
            </button>
          </div>
          <div className="ep-presenter-content">
            {sentences.length > 0 ? (
              sentences.map(s => (
                <div key={s.id} style={{ marginBottom: '1.25rem' }}>
                  <span className={`ep-speaker-badge ${getSpeakerClass(s.speaker)}`} style={{ fontSize: '1rem', padding: '0.2rem 0.6rem' }}>
                    👤 {s.speaker}
                  </span>
                  {s.isLatest ? (
                    <TypewriterText text={s.translation} speed={15} onType={scrollToBottom} onComplete={() => handleTypingComplete(s.id)} />
                  ) : (
                    <span>{s.translation}</span>
                  )}
                </div>
              ))
            ) : (
              <span style={{ opacity: 0.4 }}>Menunggu terjemahan langsung...</span>
            )}
            <div ref={presenterAnchorRef} />
          </div>
        </div>
      )}

      {/* Top Enterprise Header */}
      <header className="ep-header">
        <div className="ep-brand">
          <div className="ep-logo-badge">G</div>
          <div className="ep-title-box">
            <h1 className="ep-title">Gistex AI Translator</h1>
            <span className="ep-badge-pro">ENTERPRISE PRO</span>
          </div>
        </div>

        <div className="ep-header-metrics">
          <div className="ep-metric-item">
            <span>Hardware:</span> <strong>NVIDIA RTX 3090</strong>
          </div>
          <div className="ep-metric-item">
            <span>Ollama AI:</span> <strong>Active (MoM Enabled)</strong>
          </div>
          {audioPauseWarning && (
            <div className="ep-status-pill" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#b45309', fontWeight: 700 }}>
              ⚠️ AUDIO HENING / VIDEO DI-PAUSE
            </div>
          )}
          <div className={`ep-status-pill ${isConnected ? 'online' : ''}`}>
            <div className="ep-dot"></div>
            <span>{isConnected ? 'STREAMING ACTIVE' : 'ENGINE READY'}</span>
          </div>
        </div>
      </header>

      {/* Control Hub Bar */}
      <section className="ep-control-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Segmented Source Selector */}
          <div className="ep-segmented-control">
            <button 
              className={`ep-segment-btn ${activeSource === 'system' ? 'active' : ''}`}
              onClick={() => !isStreaming && setActiveSource('system')}
              disabled={isStreaming}
            >
              🖥️ System Audio (YouTube / Zoom / Apps)
            </button>
            <button 
              className={`ep-segment-btn ${activeSource === 'mic' ? 'active' : ''}`}
              onClick={() => !isStreaming && setActiveSource('mic')}
              disabled={isStreaming}
            >
              🎙️ Direct Microphone
            </button>
          </div>

          {/* Device Dropdown for Mic */}
          {activeSource === 'mic' && (
            <select 
              className="ep-select"
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              disabled={isStreaming}
            >
              {devices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${d.deviceId.substring(0, 6)}...`}
                </option>
              ))}
            </select>
          )}

          {/* TTS Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-subtle)', padding: '0.25rem 0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
            <button 
              className={`ep-segment-btn ${isTtsEnabled ? 'active' : ''}`} 
              style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }}
              onClick={() => setIsTtsEnabled(!isTtsEnabled)}
            >
              {isTtsEnabled ? "🔊 TTS Suara: ON" : "🔇 TTS Suara: OFF"}
            </button>

            {isTtsEnabled && (
              <select 
                className="ep-select"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
              >
                <option value="id-ID-GadisNeural">👩 Gadis (Wanita - Alami & Ekspresif)</option>
                <option value="id-ID-ArdiNeural">👨 Ardi (Pria - Indonesia)</option>
                <option value="en-US-AvaNeural">👩 Ava (Humanoid Expressive - EN)</option>
                <option value="en-US-AndrewNeural">👨 Andrew (Humanoid Expressive - EN)</option>
                <option value="en-US-BrianNeural">🎙️ Brian (Penyiar Podcast - EN)</option>
              </select>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="ep-actions">
          <button className="ep-icon-btn" onClick={() => { fetchGlossary(); setShowGlossaryModal(true); }}>
            📖 Kamus Teknis
          </button>
          <button className="ep-icon-btn" onClick={() => setShowMomModal(true)} style={{ color: 'var(--primary)' }}>
            ✨ Ringkasan Rapat (MoM)
          </button>
          {isStreaming ? (
            <button className="ep-btn-stop" onClick={stopStreaming}>
              🛑 Hentikan Stream
            </button>
          ) : (
            <button className="ep-btn-start" onClick={() => startStreaming(activeSource === 'system')}>
              ▶ Mulai Stream Terjemahan
            </button>
          )}
        </div>
      </section>

      {/* Synchronized Row Workspace Grid */}
      <main className="ep-row-workspace">
        {/* Header Row */}
        <div className="ep-grid-header">
          <div className="ep-grid-header-cell">
            <span>🇺🇸 English Source Transcript</span>
            <div className="ep-grid-tools">
              <input 
                type="text" 
                className="ep-search-input" 
                placeholder="Cari kata/speaker..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button className="ep-icon-btn" onClick={() => handleCopy('source')}>
                📋 Salin EN
              </button>
            </div>
          </div>

          <div className="ep-grid-header-cell">
            <span style={{ color: 'var(--primary)' }}>🇮🇩 Hasil Terjemahan (Bahasa Indonesia)</span>
            <div className="ep-grid-tools">
              <button className="ep-icon-btn" title="Layar Penuh Subtitle" onClick={() => setIsPresenterMode(true)}>
                📺 Subtitle Mode
              </button>
              <button className="ep-icon-btn" title="Export Transkrip" onClick={handleExportTxt}>
                💾 Export TXT
              </button>
              <button className="ep-icon-btn" onClick={() => handleCopy('translation')}>
                📋 Salin ID
              </button>
            </div>
          </div>
        </div>

        {/* Synchronized Scrollable Row Grid */}
        <div className="ep-grid-scroll-area" ref={gridScrollRef}>
          {filteredSentences.length > 0 ? (
            filteredSentences.map(s => (
              <div key={s.id} className={`ep-grid-row ${s.isLatest ? 'is-latest' : ''}`}>
                {/* Left Cell: English Source */}
                <div className="ep-cell ep-cell-source">
                  <span className={`ep-speaker-badge ${getSpeakerClass(s.speaker)}`}>
                    👤 {s.speaker}
                  </span>
                  <span className="ep-timestamp-inline">{s.timestamp}</span>
                  {s.isLatest ? (
                    <TypewriterText text={s.source} speed={15} onType={scrollToBottom} onComplete={() => handleTypingComplete(s.id)} />
                  ) : (
                    <span>{s.source}</span>
                  )}
                </div>

                {/* Right Cell: Indonesian Translation */}
                <div className="ep-cell ep-cell-target">
                  <span className={`ep-speaker-badge ${getSpeakerClass(s.speaker)}`}>
                    👤 {s.speaker}
                  </span>
                  {s.isLatest ? (
                    <TypewriterText text={s.translation} speed={15} onType={scrollToBottom} onComplete={() => handleTypingComplete(s.id)} />
                  ) : (
                    <span>{s.translation}</span>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-faint)', fontStyle: 'italic' }}>
              {searchQuery ? "Tidak ada percakapan yang cocok dengan pencarian." : "Sistem siap mendengarkan audio secara real-time..."}
            </div>
          )}
          {/* Scroll Anchor */}
          <div ref={bottomAnchorRef} style={{ height: 1 }} />
        </div>
      </main>

      {/* Footer Status */}
      <footer className="ep-footer">
        <div className="ep-footer-group">
          <span>Speed: <strong>Real-time (~0.8s)</strong></span>
          <span>•</span>
          <span>STT: <strong>Whisper Large-v3</strong></span>
          <span>•</span>
          <span>NMT: <strong>NLLB-200 1.3B</strong></span>
          <span>•</span>
          <span>TTS: <strong>{isTtsEnabled ? ttsVoice : 'Disabled'}</strong></span>
          <span>•</span>
          <span>Total Baris: <strong>{sentences.length}</strong></span>
        </div>

        <div className="ep-footer-group">
          <button className="ep-icon-btn" onClick={handleClear}>
            🗑️ Bersihkan Layar
          </button>
        </div>
      </footer>
    </div>
  )
}

export default App
