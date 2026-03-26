"use client";

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function playTone(frequency: number, duration: number, startTime: number): void {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  gain.gain.setValueAtTime(0.3, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
}

export function playApprovalAlert(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    // 3-beep alert: 440Hz, 880Hz, 440Hz
    playTone(440, 0.15, now);
    playTone(880, 0.15, now + 0.2);
    playTone(440, 0.15, now + 0.4);
  } catch {
    // AudioContext not available
  }
}

export function playSuccessChime(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    // Ascending chime: C5, E5, G5
    playTone(523, 0.2, now);
    playTone(659, 0.2, now + 0.15);
    playTone(784, 0.3, now + 0.3);
  } catch {
    // AudioContext not available
  }
}

export function playErrorTone(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    // Descending tone: G4, D4
    playTone(392, 0.3, now);
    playTone(294, 0.4, now + 0.25);
  } catch {
    // AudioContext not available
  }
}
