// Final answers compared across solvers, without a model call: the numbers
// each one states, with their units, matched within a tolerance. It tells a
// student at a glance whether the solvers agree - not whether they are
// right: on the B.8 fixture four different models gave the same wrong
// -38 N / +4 N (AGENTS.md), so agreement is a hint and the cross-check is
// the test.
//
// Pure string logic for the answer summary and the history. No DOM, no
// Workers APIs.

/** One number an answer states. */
export type Quantity = {
  /** As written, in the answer's own unit. */
  value: number;
  /** The unit as written ("kN", "N/mm^2"), "" when there is none. */
  unit: string;
  /** The value in base units, when the unit was understood. */
  si: number | null;
  /** The unit's dimensions over base units ("m-2·N1"), when understood. */
  dims: string | null;
  /** Written with a sign ("-29.99", "+30.0"), not as a bare size. */
  signed: boolean;
  /** The direction the words after it give ("to the right", "downward", "+y"), when they give one. */
  direction: Direction | null;
};

/** A direction along an axis: x to the right (the inlet flow), y upward. */
export type Direction = { axis: "x" | "y"; sign: 1 | -1 };

/** How two answers compare. */
export type Agreement = "agree" | "partial" | "differ" | "unknown";

/** Two numbers within 2% are the same answer: rounding, not a different result. */
const TOLERANCE = 0.02;

const PREFIXES: Record<string, number> = {
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  c: 1e-2,
  m: 1e-3,
  "µ": 1e-6,
  "μ": 1e-6,
  u: 1e-6,
  n: 1e-9,
};

type Base = { factor: number; dims: Record<string, number> };

// The units civil engineering answers use, over N, kg, m, s and rad. A
// symbol is looked up whole first ("m" metre, "min", "h" hour), then as a
// prefix and a base ("mm", "kN", "hPa").
const BASES: Record<string, Base> = {
  N: { factor: 1, dims: { N: 1 } },
  Nm: { factor: 1, dims: { N: 1, m: 1 } },
  Nmm: { factor: 1e-3, dims: { N: 1, m: 1 } },
  Pa: { factor: 1, dims: { N: 1, m: -2 } },
  bar: { factor: 1e5, dims: { N: 1, m: -2 } },
  m: { factor: 1, dims: { m: 1 } },
  g: { factor: 1e-3, dims: { kg: 1 } },
  t: { factor: 1e3, dims: { kg: 1 } },
  tonne: { factor: 1e3, dims: { kg: 1 } },
  tonnes: { factor: 1e3, dims: { kg: 1 } },
  s: { factor: 1, dims: { s: 1 } },
  sec: { factor: 1, dims: { s: 1 } },
  min: { factor: 60, dims: { s: 1 } },
  h: { factor: 3600, dims: { s: 1 } },
  hr: { factor: 3600, dims: { s: 1 } },
  W: { factor: 1, dims: { N: 1, m: 1, s: -1 } },
  J: { factor: 1, dims: { N: 1, m: 1 } },
  L: { factor: 1e-3, dims: { m: 3 } },
  l: { factor: 1e-3, dims: { m: 3 } },
  Hz: { factor: 1, dims: { s: -1 } },
  rad: { factor: 1, dims: { rad: 1 } },
  deg: { factor: Math.PI / 180, dims: { rad: 1 } },
  "°": { factor: Math.PI / 180, dims: { rad: 1 } },
  "%": { factor: 0.01, dims: {} },
};

function resolveSymbol(symbol: string): { factor: number; base: Base } | null {
  if (BASES[symbol]) return { factor: 1, base: BASES[symbol] };
  const prefix = PREFIXES[symbol.charAt(0)];
  const base = BASES[symbol.slice(1)];
  return prefix && base && symbol.length > 1 ? { factor: prefix, base } : null;
}

/** A unit as factor and dimensions over base units, or null when it is not understood. */
export function parseUnit(unit: string): { factor: number; dims: string } | null {
  const text = unit
    .replace(/[⋅*]/g, "·")
    .replace(/(?<=[A-Za-zµμ])[.-](?=[A-Za-zµμ])/g, "·")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁻¹/g, "^-1");
  if (!text) return null;
  const [numerator, ...denominators] = text.split("/");
  const dims: Record<string, number> = {};
  let factor = 1;
  const parts = [
    ...numerator.split("·").map((part) => ({ part, sign: 1 })),
    ...denominators.flatMap((group) => group.split("·").map((part) => ({ part, sign: -1 }))),
  ];
  for (const { part, sign } of parts) {
    if (!part) return null;
    const match = /^([A-Za-zµμ°%]+?)(?:\^?\(?(-?\d+)\)?)?$/.exec(part);
    if (!match) return null;
    const resolved = resolveSymbol(match[1]);
    if (!resolved) return null;
    const exponent = (match[2] ? Number(match[2]) : 1) * sign;
    factor *= (resolved.factor * resolved.base.factor) ** exponent;
    for (const [dim, power] of Object.entries(resolved.base.dims)) {
      dims[dim] = (dims[dim] ?? 0) + power * exponent;
    }
  }
  const signature = Object.keys(dims)
    .filter((dim) => dims[dim] !== 0)
    .sort()
    .map((dim) => `${dim}${dims[dim]}`)
    .join("·");
  return { factor, dims: signature };
}

/**
 * The answer as plain text: LaTeX wrappers, Markdown, subscripts and labels
 * taken out, units joined up, scientific notation as "1.5e6" - so what is
 * left is numbers and the units after them.
 */
function plainAnswer(answer: string) {
  let text = answer;
  // Formatting commands with their braces, innermost first.
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(
      /\\(?:text|mathrm|mathbf|mathit|mathsf|textrm|textbf|operatorname|boldsymbol)\s*\{([^{}]*)\}/g,
      " $1 ",
    );
  }
  text = text
    .replace(/\^\s*\{?\s*\\circ\s*\}?/g, "°")
    .replace(/\\(?:circ|degree)\b/g, "°")
    .replace(/\\%/g, "%")
    .replace(/\\mu\b/g, "µ")
    .replace(/\s*\\(?:times|cdot)\s*10\s*\^\s*\{?\s*([-−+]?\d+)\s*\}?/g, "e$1")
    .replace(/\s*[×x]\s*10\s*\^\s*\{?\s*([-−+]?\d+)\s*\}?/g, "e$1")
    .replace(/\\(?:cdot|times)|[·⋅]/g, "·")
    .replace(/\\(?:left|right|displaystyle|quad|qquad)/g, " ")
    .replace(/\\[,;:! ]|~/g, " ")
    .replace(/\{,\}/g, "")
    .replace(/[−–]/g, "-")
    .replace(/\\approx|≈/g, "=")
    .replace(/\$/g, " ")
    .replace(/\*\*|__|`/g, " ")
    // Subscripts belong to a symbol's name, not to the answer: F_x, V_{1}.
    .replace(/_\s*\{[^{}]*\}/g, "")
    .replace(/_[A-Za-z0-9]+/g, "")
    // Labels: "Q2", "Part (b)", "Step 3", "Fig. B.8", "Eq. 4".
    .replace(
      /\b(?:Part|Question|Q|Step|Problem|Case|Fig\.?|Figure|Table|Eq\.?|Equation)\s*\(?[A-Za-z]?\d+(?:\.\d+)?[A-Za-z]?\)?[.:)]?/gi,
      " ",
    )
    // Unit exponents and joins stay with the unit: m^{2}, kN · m, kN / m.
    .replace(/\s*\^\s*\{\s*(-?\d+)\s*\}/g, "^$1")
    .replace(/(?<=[A-Za-zµμ])\s+\^/g, "^")
    .replace(/\s*·\s*/g, "·")
    .replace(/(?<=[A-Za-zµμ°]|\^-?\d)\s*\/\s*(?=[A-Za-zµμ])/g, "/")
    .replace(/[{}]/g, " ");
  // Labels that open a line: "(a)", "ii)", "1. ", "- ".
  return text
    .split("\n")
    .map((line) =>
      line.replace(/^\s*(?:[-*•+]\s+)?(?:#+\s*)?(?:\(?(?:[a-h]|i{1,3}|iv|vi{0,3})\)|\(?\d{1,2}[.)](?=\s))?\s*/i, ""),
    )
    .join("\n");
}

// A number not glued to a name, an exponent or another number ("V1", "m^2",
// "B.8"), with its sign and scientific notation, then the unit after it.
const NUMBER_WITH_UNIT =
  /(?<![A-Za-z0-9_^.\\])([-+]?)(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE]([-+]?\d+))?\s*((?:[A-Za-zµμ°%][A-Za-z0-9µμ°%·/^\-]*)?)/g;

/** Words that follow a number but are not a unit: "2.33 m from A" is "m", "5 at" is nothing. */
const NOT_UNITS = new Set([
  "at",
  "from",
  "to",
  "and",
  "or",
  "of",
  "in",
  "on",
  "the",
  "is",
  "acting",
  "upward",
  "upwards",
  "downward",
  "downwards",
  "left",
  "right",
  "below",
  "above",
  "approx",
  "for",
  "with",
  "per",
]);

/** Every number an answer states, with its unit; repeats of the same value dropped. */
export function extractQuantities(answer: string): Quantity[] {
  const found: Quantity[] = [];
  const text = plainAnswer(answer);
  const matches = [...text.matchAll(NUMBER_WITH_UNIT)];
  matches.forEach((match, at) => {
    const [whole, sign, digits, exponent, rawUnit] = match;
    const value = Number(`${sign === "-" ? "-" : ""}${digits.replace(/,/g, "")}${exponent ? `e${exponent}` : ""}`);
    if (!Number.isFinite(value)) return;
    let unit = rawUnit.replace(/[·/^-]+$/, "");
    if (NOT_UNITS.has(unit.toLowerCase())) unit = "";
    const parsed = unit ? parseUnit(unit) : null;
    // The words after it, up to the next number or the end of the line,
    // say which way it acts.
    const start = (match.index ?? 0) + whole.length;
    const end = Math.min(matches[at + 1]?.index ?? text.length, text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start));
    const quantity: Quantity = {
      value,
      unit,
      si: parsed ? value * parsed.factor : null,
      dims: parsed ? parsed.dims : null,
      signed: sign === "-" || sign === "+",
      direction: directionIn(text.slice(start, end)),
    };
    // The same result stated twice ("= 142.9 N", later "142.9 N to the left"),
    // or as the equal and opposite force ("177.1 kN to the right", then
    // "R_x = -177.1 kN" on the fluid): the first time it is stated is the
    // answer. Only a near-exact repeat: within the 2% of a match, a
    // resultant of 180 kN was dropped as a repeat of a 177 kN component
    // (9 October 2026).
    if (found.some((other) => (magnitudeGap(other, quantity) ?? Infinity) <= REPEAT_TOLERANCE)) return;
    found.push(quantity);
  });
  return found;
}

/**
 * Words that give a direction, with the axis they are on: x to the right,
 * as the inlet flow usually runs - so "upstream" is to the left - and y
 * upward. "Above" and "below" are left out: they say where, not which way.
 */
const DIRECTION_WORDS: Array<{ pattern: RegExp; direction: Direction }> = [
  {
    pattern: /\bto the right\b|\brightwards?\b|\bright\b|(?<![A-Za-z0-9])\+\s*x\b|\bpositive x\b|\bdownstream\b/i,
    direction: { axis: "x", sign: 1 },
  },
  {
    pattern:
      /\bto the left\b|\bleftwards?\b|\bleft\b|(?<![A-Za-z0-9])-\s*x\b|\bnegative x\b|\bupstream\b|\bopposite to (?:the )?(?:inlet )?flow\b|\bagainst the (?:inlet )?flow\b/i,
    direction: { axis: "x", sign: -1 },
  },
  {
    pattern: /\bupwards?\b|\bup\b(?!\s+to\b)|(?<![A-Za-z0-9])\+\s*y\b|\bpositive y\b/i,
    direction: { axis: "y", sign: 1 },
  },
  {
    pattern: /\bdownwards?\b|\bdown\b|(?<![A-Za-z0-9])-\s*y\b|\bnegative y\b/i,
    direction: { axis: "y", sign: -1 },
  },
];

/** The first direction the words give, if any. */
function directionIn(words: string): Direction | null {
  let first: { at: number; direction: Direction } | null = null;
  for (const { pattern, direction } of DIRECTION_WORDS) {
    const match = pattern.exec(words);
    if (match && (!first || match.index < first.at)) first = { at: match.index, direction };
  }
  return first?.direction ?? null;
}

/**
 * Whether two numbers of the same size point the same way (since 9 October
 * 2026, the owner's rule: a difference in direction is a difference). Words
 * come first - Gemini's "-29.99 kN (downward)" and DeepSeek's "30.0 kN
 * downward" point the same way, Muse Spark's "30.0 kN in +y" the other - and
 * a sign counts when there are no words. A bare size ("210 kN") says no
 * direction, so it is not held against one in words. Two numbers in words
 * on different axes are not the same thing at all.
 */
function directionRelation(a: Quantity, b: Quantity): "same" | "opposite" | "other" {
  const signOf = (quantity: Quantity) => (quantity.value < 0 ? -1 : 1);
  if (a.direction && b.direction) {
    if (a.direction.axis !== b.direction.axis) return "other";
    return a.direction.sign === b.direction.sign ? "same" : "opposite";
  }
  const worded = a.direction ?? b.direction;
  if (worded) {
    const plain = a.direction ? b : a;
    if (!plain.signed) return "same";
    return worded.sign === signOf(plain) ? "same" : "opposite";
  }
  return signOf(a) === signOf(b) ? "same" : "opposite";
}

function close(a: number, b: number) {
  return Math.abs(a - b) <= TOLERANCE * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-12;
}

/** The two numbers to weigh against each other, in the same units; null when they cannot be. */
function comparable(a: Quantity, b: Quantity): [number, number] | null {
  if (a.unit && b.unit && a.dims !== null && b.dims !== null) {
    return a.dims === b.dims ? [a.si as number, b.si as number] : null;
  }
  if (!a.unit || !b.unit || a.unit.toLowerCase() === b.unit.toLowerCase()) return [a.value, b.value];
  return null;
}

/** How far apart two numbers' sizes are, relative to the larger; null when they cannot be weighed. */
function magnitudeGap(a: Quantity, b: Quantity): number | null {
  const pair = comparable(a, b);
  if (!pair) return null;
  const [x, y] = pair.map(Math.abs);
  const larger = Math.max(x, y);
  return larger < 1e-12 ? 0 : Math.abs(x - y) / larger;
}

/** Within one answer, a number this close to another is the same result stated again. */
const REPEAT_TOLERANCE = 0.005;

/** Whether two numbers are the same result, the same size pointing the other way, or different. */
export function matchQuantities(a: Quantity, b: Quantity): "same" | "opposite" | null {
  const pair = comparable(a, b);
  if (!pair) return null;
  const [x, y] = pair;
  if (!close(Math.abs(x), Math.abs(y))) return null;
  const relation = directionRelation(a, b);
  return relation === "other" ? null : relation;
}

export type Comparison = {
  agreement: Agreement;
  /** Numbers matched, and matched in size but pointing the other way. */
  same: number;
  opposite: number;
  /** Numbers of the same kind that both answers state and that do not match: real disagreements. */
  conflicts: number;
};

/** What a number can be weighed against: its dimensions, or else its unit as written ("" for a bare number). */
function kindOf(quantity: Quantity) {
  return quantity.dims !== null ? `dims:${quantity.dims}` : `unit:${quantity.unit.toLowerCase()}`;
}

/** How many of each kind are left over. */
function countKinds(quantities: Quantity[]) {
  const counts = new Map<string, number>();
  for (const quantity of quantities) counts.set(kindOf(quantity), (counts.get(kindOf(quantity)) ?? 0) + 1);
  return counts;
}

/**
 * How two answers compare, on what both of them state. Until 6 October 2026
 * every number had to match, so an answer that also gave its working - a
 * moment, a mass, a lever arm the other left out - "differed" from one with
 * the same results (the owner saw two gate answers, both W = 210 kN, F_oil
 * 165 kN and F_water 31.1 kN, marked as differing). Now a number one answer
 * states and the other does not is no disagreement; a disagreement is a
 * number of the same kind (a force, a length...) that both state and that
 * does not match:
 * - "agree": something matched, and nothing disagrees;
 * - "partial": something matched in size, and something disagrees - a
 *   value, or a direction;
 * - "differ": nothing matched, and something disagrees;
 * - "unknown": nothing to weigh against each other.
 * Directions count (directionRelation): the same size pointing the other
 * way is a disagreement - the owner's rule, 9 October 2026.
 */
export function compareAnswers(a: Quantity[], b: Quantity[]): Comparison {
  if (!a.length || !b.length) return { agreement: "unknown", same: 0, opposite: 0, conflicts: 0 };
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  // Numbers are paired closest first, over both answers at once, and only
  // then is each pair the same or the other way. Paired one by one in
  // order, a 180 kN resultant within 2% of a 177.1 kN component took it
  // before the 177 kN component it belongs with (9 October 2026).
  const candidates: Array<{ at: number; bt: number; gap: number; relation: "same" | "opposite" }> = [];
  a.forEach((quantity, at) => {
    b.forEach((other, bt) => {
      const relation = matchQuantities(quantity, other);
      if (relation) candidates.push({ at, bt, gap: magnitudeGap(quantity, other) ?? Infinity, relation });
    });
  });
  // The closest first; at an equal distance, a pair pointing the same way.
  candidates.sort((x, y) => x.gap - y.gap || (x.relation === "same" ? -1 : 1) - (y.relation === "same" ? -1 : 1));
  let same = 0;
  let opposite = 0;
  for (const { at, bt, relation } of candidates) {
    if (usedA.has(at) || usedB.has(bt)) continue;
    usedA.add(at);
    usedB.add(bt);
    if (relation === "same") same += 1;
    else opposite += 1;
  }
  // Left over on both sides and of the same kind: the two answers give
  // different values for the same thing.
  const leftA = countKinds(a.filter((_, at) => !usedA.has(at)));
  const leftB = countKinds(b.filter((_, at) => !usedB.has(at)));
  let conflicts = 0;
  for (const [kind, count] of leftA) conflicts += Math.min(count, leftB.get(kind) ?? 0);
  // Matched in size but pointing the other way: matched, and a disagreement.
  const agreement: Agreement =
    same + opposite === 0
      ? conflicts > 0
        ? "differ"
        : "unknown"
      : conflicts === 0 && opposite === 0
        ? "agree"
        : "partial";
  return { agreement, same, opposite, conflicts };
}

export type AnswerGroups<K> = {
  /** Answers that agree with each other, largest group first; a lone answer is a group of one. */
  groups: K[][];
  /** Answers with no number to compare. */
  unknown: K[];
  /** Each answer against the largest group (its own group counts as "agree"). */
  status: Map<K, Agreement>;
};

/** The answers sorted into groups that agree, for the summary's headline. */
export function groupAnswers<K>(entries: Array<{ key: K; quantities: Quantity[] }>): AnswerGroups<K> {
  const comparable = entries.filter((entry) => entry.quantities.length > 0);
  const unknown = entries.filter((entry) => entry.quantities.length === 0).map((entry) => entry.key);
  const parent = comparable.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  comparable.forEach((left, i) => {
    comparable.forEach((right, j) => {
      if (j <= i) return;
      if (compareAnswers(left.quantities, right.quantities).agreement === "agree") {
        parent[find(j)] = find(i);
      }
    });
  });
  const byRoot = new Map<number, number[]>();
  comparable.forEach((_, index) => {
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
  });
  const indexGroups = [...byRoot.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const groups = indexGroups.map((group) => group.map((index) => comparable[index].key));

  const status = new Map<K, Agreement>();
  for (const key of unknown) status.set(key, "unknown");
  const largest = indexGroups[0] ?? [];
  // An answer outside the largest group of agreeing answers - or every
  // answer, when no two agree - gets its closest relation to the answers it
  // is measured against: partly agreeing with one of them beats differing.
  // (When no two agreed, every answer used to be "differ", even ones that
  // partly matched.)
  const RANK: Record<Agreement, number> = { agree: 3, partial: 2, differ: 1, unknown: 0 };
  comparable.forEach((entry, index) => {
    if (largest.length >= 2 && largest.includes(index)) {
      status.set(entry.key, "agree");
      return;
    }
    const against = largest.length >= 2 ? largest : comparable.map((_, other) => other).filter((other) => other !== index);
    let best: Agreement = "unknown";
    for (const other of against) {
      const { agreement } = compareAnswers(entry.quantities, comparable[other].quantities);
      // Agreeing with one answer that is not in the largest group is still
      // only partly agreeing with the rest.
      const seen: Agreement = agreement === "agree" ? "partial" : agreement;
      if (RANK[seen] > RANK[best]) best = seen;
    }
    status.set(entry.key, best);
  });
  return { groups, unknown, status };
}
