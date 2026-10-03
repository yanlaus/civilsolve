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
};

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
  for (const match of plainAnswer(answer).matchAll(NUMBER_WITH_UNIT)) {
    const [, sign, digits, exponent, rawUnit] = match;
    const value = Number(`${sign === "-" ? "-" : ""}${digits.replace(/,/g, "")}${exponent ? `e${exponent}` : ""}`);
    if (!Number.isFinite(value)) continue;
    let unit = rawUnit.replace(/[·/^-]+$/, "");
    if (NOT_UNITS.has(unit.toLowerCase())) unit = "";
    const parsed = unit ? parseUnit(unit) : null;
    const quantity: Quantity = {
      value,
      unit,
      si: parsed ? value * parsed.factor : null,
      dims: parsed ? parsed.dims : null,
    };
    // The same result stated twice ("= 142.9 N", later "142.9 N to the left").
    if (found.some((other) => matchQuantities(other, quantity) === "same")) continue;
    found.push(quantity);
  }
  return found;
}

function close(a: number, b: number) {
  return Math.abs(a - b) <= TOLERANCE * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-12;
}

/** Whether two numbers are the same result, the same but for the sign, or different. */
export function matchQuantities(a: Quantity, b: Quantity): "same" | "sign" | null {
  let x: number;
  let y: number;
  if (a.unit && b.unit && a.dims !== null && b.dims !== null) {
    if (a.dims !== b.dims) return null;
    x = a.si as number;
    y = b.si as number;
  } else if (!a.unit || !b.unit || a.unit.toLowerCase() === b.unit.toLowerCase()) {
    x = a.value;
    y = b.value;
  } else {
    return null;
  }
  if (close(x, y)) return "same";
  if (close(Math.abs(x), Math.abs(y))) return "sign";
  return null;
}

export type Comparison = {
  agreement: Agreement;
  /** Numbers matched exactly, and matched but for the sign (a sign convention). */
  same: number;
  sign: number;
  /** The larger of the two answers' counts. */
  total: number;
};

/**
 * How two answers compare: every number matched ("agree"), some matched or
 * only the signs differ ("partial"), none ("differ"), or one of them states
 * no number to compare ("unknown").
 */
export function compareAnswers(a: Quantity[], b: Quantity[]): Comparison {
  const total = Math.max(a.length, b.length);
  if (!a.length || !b.length) return { agreement: "unknown", same: 0, sign: 0, total };
  const used = new Set<number>();
  const pending: Quantity[] = [];
  let same = 0;
  for (const quantity of a) {
    const index = b.findIndex((other, at) => !used.has(at) && matchQuantities(quantity, other) === "same");
    if (index >= 0) {
      used.add(index);
      same += 1;
    } else {
      pending.push(quantity);
    }
  }
  let sign = 0;
  for (const quantity of pending) {
    const index = b.findIndex((other, at) => !used.has(at) && matchQuantities(quantity, other) === "sign");
    if (index >= 0) {
      used.add(index);
      sign += 1;
    }
  }
  const agreement: Agreement =
    same === total ? "agree" : same + sign > 0 ? "partial" : "differ";
  return { agreement, same, sign, total };
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
  const largest = indexGroups[0];
  comparable.forEach((entry, index) => {
    if (!largest || largest.length < 2) {
      status.set(entry.key, comparable.length > 1 ? "differ" : "unknown");
      return;
    }
    if (largest.includes(index)) {
      status.set(entry.key, "agree");
      return;
    }
    const leader = comparable[largest[0]];
    const { agreement } = compareAnswers(entry.quantities, leader.quantities);
    status.set(entry.key, agreement === "partial" ? "partial" : "differ");
  });
  return { groups, unknown, status };
}
