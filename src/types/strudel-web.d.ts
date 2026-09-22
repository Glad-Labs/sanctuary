// The @strudel/web bundle, loaded from a script tag on the web build and read
// from window. Only the surface the melody layer touches.
export interface StrudelPattern {
  s(name: string): StrudelPattern;
  attack(x: number): StrudelPattern;
  release(x: number): StrudelPattern;
  lpf(x: number): StrudelPattern;
  room(x: number): StrudelPattern;
  roomsize(x: number): StrudelPattern;
  gain(x: number): StrudelPattern;
  analyze(id: string): StrudelPattern;
  early(cycles: number): StrudelPattern;
  play(): StrudelPattern;
}
export interface StrudelRepl {
  setCps(cps: number): void;
  stop(): void;
  scheduler: { started: boolean };
}
export interface StrudelWindow {
  initStrudel(options?: Record<string, unknown>): Promise<StrudelRepl>;
  initAudio(options?: Record<string, unknown>): Promise<void>;
  note(pattern: string): StrudelPattern;
  hush(): void;
  getAnalyserById(id: string, fftSize?: number): AnalyserNode;
  getAudioContext(): AudioContext;
}
