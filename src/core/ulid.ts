// Minimal monotonic ULID (Crockford base32, 26 chars).
// Time-sortable: lexicographic order == chronological order. We exploit this so the
// SAME id doubles as the git-bus replay cursor (files named <ulid>.json sort by time).

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
let lastRand: number[] = [];

function randPart(): number[] {
  const out: number[] = [];
  for (let i = 0; i < RAND_LEN; i++) out.push(Math.floor(Math.random() * 32));
  return out;
}

function incrementRand(rand: number[]): number[] {
  const out = rand.slice();
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (out[i] < 31) {
      out[i]++;
      return out;
    }
    out[i] = 0;
  }
  return out; // overflow (astronomically unlikely within 1ms) — wraps, still unique enough
}

/** Decode a ULID's 48-bit millisecond timestamp, or NaN if malformed. */
export function decodeUlidTime(id: string): number {
  if (typeof id !== "string" || id.length !== TIME_LEN + RAND_LEN) return NaN;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ENCODING.indexOf(id[i].toUpperCase());
    if (v < 0) return NaN;
    t = t * 32 + v;
  }
  // Validate the random part is in-alphabet too.
  for (let i = TIME_LEN; i < TIME_LEN + RAND_LEN; i++) if (ENCODING.indexOf(id[i].toUpperCase()) < 0) return NaN;
  return t;
}

export function ulid(time: number = Date.now()): string {
  let rand: number[];
  if (time === lastTime) {
    rand = incrementRand(lastRand);
  } else {
    rand = randPart();
  }
  lastTime = time;
  lastRand = rand;

  let t = time;
  const timeChars: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    timeChars[i] = ENCODING[t % 32];
    t = Math.floor(t / 32);
  }
  return timeChars.join("") + rand.map((r) => ENCODING[r]).join("");
}
