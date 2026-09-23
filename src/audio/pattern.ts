// A small reader for the melody notation the arranger writes: a sequence of
// note names and rests, with [] to subdivide a step, <> to alternate between
// cycles, @n to make a step longer, *n to repeat within a step, and ! to
// repeat a step. That is the whole language, and the sanitizer admits nothing
// else. Events are fractions of one cycle, so the engine can place them on
// the wall clock and every device plays the same note at the same moment.

export interface PatternEvent {
  start: number; // fraction of the cycle
  duration: number; // fraction of the cycle
  midi: number;
}

type Node =
  | { kind: 'rest'; weight: number; fast: number }
  | { kind: 'note'; midi: number; weight: number; fast: number }
  | { kind: 'seq'; items: Node[]; weight: number; fast: number }
  | { kind: 'alt'; items: Node[]; weight: number; fast: number };

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function noteToMidi(name: string): number {
  const m = /^([a-g])([#b]?)(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return PITCH[m[1]] + acc + 12 * (Number(m[3]) + 1);
}

function parse(src: string): Node {
  let i = 0;
  const s = src.trim();
  const peek = () => s[i];
  const skip = () => { while (i < s.length && s[i] === ' ') i++; };
  const modifiers = (node: Node): Node[] => {
    // @n, *n, ! in any order; ! duplicates the step
    let copies = 1;
    for (;;) {
      if (peek() === '@') { i++; const m = /^\d+(\.\d+)?/.exec(s.slice(i)); if (!m) throw new Error('@ needs a number'); node.weight = Number(m[0]); i += m[0].length; }
      else if (peek() === '*') { i++; const m = /^\d+/.exec(s.slice(i)); if (!m) throw new Error('* needs a number'); node.fast = Math.max(1, Math.min(16, Number(m[0]))); i += m[0].length; }
      else if (peek() === '!') { i++; copies++; }
      else break;
    }
    return Array.from({ length: Math.min(copies, 8) }, () => ({ ...node }));
  };
  const item = (): Node[] => {
    skip();
    const c = peek();
    if (c === '~') { i++; return modifiers({ kind: 'rest', weight: 1, fast: 1 }); }
    if (c === '[') { i++; const inner = seq(']'); return modifiers({ kind: 'seq', items: inner, weight: 1, fast: 1 }); }
    if (c === '<') { i++; const inner = seq('>'); return modifiers({ kind: 'alt', items: inner, weight: 1, fast: 1 }); }
    const m = /^[a-g][#b]?\d/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected "${c ?? 'end'}" at ${i}`);
    i += m[0].length;
    return modifiers({ kind: 'note', midi: noteToMidi(m[0]), weight: 1, fast: 1 });
  };
  const seq = (close: string | null): Node[] => {
    const items: Node[] = [];
    for (;;) {
      skip();
      if (i >= s.length) { if (close) throw new Error(`missing ${close}`); return items; }
      if (peek() === close) { i++; return items; }
      if (peek() === ']' || peek() === '>') throw new Error(`stray ${peek()}`);
      items.push(...item());
    }
  };
  const items = seq(null);
  if (items.length === 0) throw new Error('empty');
  return { kind: 'seq', items, weight: 1, fast: 1 };
}

function render(node: Node, cycle: number, start: number, dur: number, out: PatternEvent[]) {
  const slot = dur / node.fast;
  for (let r = 0; r < node.fast; r++) {
    const s0 = start + r * slot;
    if (node.kind === 'rest') continue;
    if (node.kind === 'note') { out.push({ start: s0, duration: slot, midi: node.midi }); continue; }
    if (node.kind === 'alt') {
      if (node.items.length === 0) continue;
      const pick = node.items[((cycle % node.items.length) + node.items.length) % node.items.length];
      render(pick, cycle, s0, slot, out);
      continue;
    }
    const total = node.items.reduce((a, n) => a + n.weight, 0) || 1;
    let t = s0;
    for (const child of node.items) {
      const d = (slot * child.weight) / total;
      render(child, cycle, t, d, out);
      t += d;
    }
  }
}

const cache = new Map<string, Node>();

/** Is this notation something the engine can play? */
export function parsePattern(notes: string): Node {
  let node = cache.get(notes);
  if (!node) {
    node = parse(notes);
    if (cache.size > 64) cache.clear();
    cache.set(notes, node);
  }
  return node;
}

/** The notes of cycle `cycle`, as fractions of the cycle. */
export function eventsForCycle(notes: string, cycle: number): PatternEvent[] {
  const out: PatternEvent[] = [];
  render(parsePattern(notes), cycle, 0, 1, out);
  return out;
}
