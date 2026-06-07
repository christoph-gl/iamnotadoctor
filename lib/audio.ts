class AudioService {
  private ctx: AudioContext | null = null;
  private buffers: Record<string, AudioBuffer> = {};
  private isPreloading = false;

  async init() {
    if (typeof window === 'undefined') return;
    
    // Initialize AudioContext if not exists (must be called from user gesture)
    if (!this.ctx) {
      const AudioContextClass =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        this.ctx = new AudioContextClass();
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Only preload once
    if (!this.isPreloading && this.ctx) {
      this.isPreloading = true;
      try {
        await Promise.all([
          this.loadBuffer('notification', '/notification.mp3'),
          this.loadBuffer('coachMessage', '/coach-message.mp3'),
          this.loadBuffer('accelerate', '/accelerate.mp3'),
          this.loadBuffer('brake', '/brake.mp3')
        ]);
        console.log("Audio files prebuffered successfully.");
      } catch (e) {
        console.error("Error prebuffering audio files:", e);
        this.isPreloading = false;
      }
    }
  }

  private async loadBuffer(name: string, url: string) {
    if (!this.ctx) return;
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.buffers[name] = audioBuffer;
  }

  private playBuffer(name: string) {
    if (!this.ctx) {
      this.init();
      return; // Will play next time if called before init
    }
    
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const buffer = this.buffers[name];
    if (buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start(0);
    } else if (!this.isPreloading) {
      // If we somehow missed preloading, try again
      this.init();
    }
  }

  async playArrayBuffer(arrayBuffer: ArrayBuffer) {
    await this.init();
    if (!this.ctx) return;

    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    source.start(0);
  }

  playNotification() {
    this.playBuffer('notification');
  }

  playCoachMessage() {
    this.playBuffer('coachMessage');
  }

  playAcceleration() {
    this.playBuffer('accelerate');
  }

  playDeceleration() {
    this.playBuffer('brake');
  }
}

export const audioService = new AudioService();
