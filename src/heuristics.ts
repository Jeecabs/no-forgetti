const EXPLICIT_MEMORY_SIGNALS: RegExp[] = [
  /\bremember\s+(?:that|this)\b/iu,
  /\b(?:from now on|going forward)\b/iu,
  /\b(?:i|we)\s+(?:always|never|prefer|use|expect)\b/iu,
  /\b(?:do not|don't|stop)\s+(?:use|doing|writing|running|calling)\b/iu,
];

const DURABLE_CORRECTION_SIGNALS: RegExp[] = [
  /\b(?:instead|correction|correct approach|project convention|repository convention)\b/iu,
  /\b(?:the project|this project|the repo|this repo|the codebase)\s+(?:uses|requires|expects|keeps|stores)\b/iu,
  /\b(?:canonical|standard|required)\s+(?:command|workflow|path|format|tool)\b/iu,
];

const DURABLE_TOPIC_SIGNALS: RegExp[] = [
  /\b(?:architecture|convention|workflow|verification|package manager|test command|build command)\b/iu,
  /\b(?:always|never|required|must)\b/iu,
];

const TRANSIENT_SIGNALS: RegExp[] = [
  /\b(?:for now|this time|today|temporary|temporarily|one[- ]off|just this once)\b/iu,
  /\b(?:current task|this task|current issue|this issue|current pr|this pr)\b/iu,
];

/** Score a completed user turn for durable-memory review value. */
export function scoreMemorySignal(text: string): number {
  const normalized = text.trim();
  if (normalized.length < 20) return 0;

  let score = 0;
  if (EXPLICIT_MEMORY_SIGNALS.some((pattern) => pattern.test(normalized))) score += 4;
  if (DURABLE_CORRECTION_SIGNALS.some((pattern) => pattern.test(normalized))) score += 3;
  if (DURABLE_TOPIC_SIGNALS.some((pattern) => pattern.test(normalized))) score += 1;
  if (TRANSIENT_SIGNALS.some((pattern) => pattern.test(normalized))) score -= 3;
  if (normalized.endsWith("?") && score < 4) score -= 1;

  return Math.max(0, Math.min(5, score));
}
