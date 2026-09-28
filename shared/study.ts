// Study notes: written after the solutions, for a student to learn from
// rather than to copy - the owner's two features of 28 September 2026. Both
// are optional and made on request, each by the model the user picks:
//
// - "approach": 題型解題思路 - the type of problem, how problems of that type
//   are solved, and the key formulas;
// - "explain": the question and its solution explained simply, for a student
//   who has not understood much of the subject yet.
//
// The user picks what the notes start from: one solver's solution, or the
// cross-check's verified answer - the verdict, with the solutions it graded
// for their working. The model gets the question and that. The notes are
// never sent to the cross-check.
//
// Pure string logic shared by the Worker (parsing the response) and the
// client (rendering it). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import {
  cleanModelText,
  normalizeJsonCandidate,
  sanitizeText,
  stripThinkTags,
  textOf,
  type ParseOptions,
} from "./solution";

export type StudyKind = "approach" | "explain";

export const STUDY_KINDS: StudyKind[] = ["approach", "explain"];

export function isStudyKind(value: unknown): value is StudyKind {
  return typeof value === "string" && (STUDY_KINDS as string[]).includes(value);
}

/**
 * Each kind's parts, in order: the bold label that opens the part, in the
 * English notes and in the Chinese ones. What goes in each part is in the
 * prompt (buildStudyPrompt in prompt.ts).
 */
export const STUDY_PARTS: Record<StudyKind, ReadonlyArray<{ label: string; chinese: string }>> = {
  approach: [
    { label: "Problem type", chinese: "題型" },
    { label: "Approach", chinese: "解題思路" },
    { label: "Key formulas", chinese: "關鍵公式" },
    { label: "Common mistakes", chinese: "常見錯誤" },
  ],
  // A tutor's run-through, and in Cantonese in the Chinese (the owner's
  // example of 28 September 2026 - see the explain brief in prompt.ts).
  explain: [
    { label: "What's going on", chinese: "發生咩事" },
    { label: "The key idea", chinese: "關鍵諗法" },
    { label: "Step by step", chinese: "逐步計" },
    { label: "Wrap-up", chinese: "總結" },
  ],
};

/**
 * A label as models actually write it: any case, "The" or not, a plural or
 * not, a space or a hyphen between words, straight or curly apostrophes, the
 * question mark optional - "Key idea" for "The key idea", "Step-by-step",
 * "Key formula" (DeepSeek wrote "Key idea", 28 September 2026).
 */
function labelPattern(label: string) {
  const core = label.replace(/^the\s+/i, "").replace(/[?？]$/, "").replace(/s$/, "");
  const body = core
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/'/g, "['’]")
    .replace(/[ -]/g, "[\\s-]?");
  return `(?:the\\s+)?${body}s?[?？]?`;
}

const LABEL_PATTERNS = Object.values(STUDY_PARTS)
  .flatMap((parts) => parts.flatMap((part) => [part.label, part.chinese]))
  .map((label) => {
    // "**Approach**", "- **Approach:**", "**Approach** -", at a line's start.
    const opening = `^[ \\t]*(?:[-*][ \\t]+)?\\*\\*${labelPattern(label)}[ \\t]*[:：]?\\*\\*[ \\t]*[-–—:：]?[ \\t]*`;
    return {
      label,
      alone: new RegExp(`${opening}$`, "gim"),
      inline: new RegExp(`${opening}(?=\\S)`, "gim"),
    };
  });

/**
 * Puts each part's label on a line of its own, as the prompt asks, spelled as
 * in STUDY_PARTS and with a blank line before and after it. Models ran the
 * part on after the label - "**Approach** - 1. Identify ..." from DeepSeek
 * (28 September 2026), which cut the numbered steps' list in two - and put a
 * label straight under a list, with no blank line: Markdown then reads it as
 * more of the list's last item, and "Wrap-up", which follows the numbered
 * steps, came out indented like one (the owner, 28 September 2026). The page
 * runs this again when it renders notes, for ones stored before.
 */
export function openStudyLabels(text: string) {
  let out = text;
  for (const { label, alone, inline } of LABEL_PATTERNS) {
    out = out.replace(alone, `\n**${label}**\n`).replace(inline, `\n**${label}**\n\n`);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The notes cut at the labels that open their parts (STUDY_PARTS), for the
 * tabs of the approach notes: each part's text without its label, in
 * STUDY_PARTS order, "" for a part the model left out. Text before the first
 * label goes with that part. Null when fewer than two labels are found - the
 * page then shows the notes whole.
 */
export function splitStudyParts(text: string, kind: StudyKind): string[] | null {
  const parts = STUDY_PARTS[kind];
  const lines = openStudyLabels(text).split("\n");
  const found: Array<{ part: number; line: number }> = [];
  lines.forEach((line, index) => {
    const label = /^\*\*(.+?)\*\*$/.exec(line.trim())?.[1];
    const part = parts.findIndex((entry) => entry.label === label || entry.chinese === label);
    if (part >= 0 && !found.some((entry) => entry.part === part)) found.push({ part, line: index });
  });
  if (found.length < 2) return null;
  const out = parts.map(() => "");
  found.forEach((entry, index) => {
    const end = index + 1 < found.length ? found[index + 1].line : lines.length;
    out[entry.part] = lines.slice(entry.line + 1, end).join("\n").trim();
  });
  const before = lines.slice(0, found[0].line).join("\n").trim();
  if (before) out[found[0].part] = `${before}\n\n${out[found[0].part]}`.trim();
  return out;
}

export type StudyResult = {
  /** The notes, in English: Markdown with `$...$` LaTeX, like a solution. */
  guide: string;
  /** The same notes in Traditional Chinese, shown a fold below the English. */
  traditional_chinese: string;
};

export const studySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    guide: { type: "string" },
    traditional_chinese: { type: "string" },
  },
  required: ["guide", "traditional_chinese"],
} as const;

export const STUDY_FIELDS = ["guide", "traditional_chinese"] as const;

const GUIDE_KEYS = ["guide", "notes", "study_notes", "content", "explanation", "approach", "text"];
const CHINESE_KEYS = ["traditional_chinese", "chinese", "zh_hant", "zh", "translation"];

function readFirst(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const text = cleanModelText(textOf(record[key]));
    if (text) return text;
  }
  return "";
}

/** The object holding the fields, or the one a model wrapped them in. */
function unwrap(record: Record<string, unknown>): Record<string, unknown> {
  if ([...STUDY_FIELDS, ...GUIDE_KEYS].some((key) => key in record)) return record;
  const objects = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  return objects.length === 1 ? unwrap(objects[0]) : record;
}

export function parseStudy(
  rawText: string,
  provider: ProviderKey,
  options: ParseOptions = {},
): StudyResult {
  const label = PROVIDER_LABELS[provider];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(rawText));
  } catch {
    // Same policy as the other parsers: prose is a cut-off or an ignored
    // instruction, retried while an attempt is left, and delivered as the
    // notes on the last one rather than thrown away.
    const text = stripThinkTags(sanitizeText(rawText));
    if (text.length < 40) throw new Error(`${label} returned empty study notes.`);
    if (!options.allowIncomplete) throw new Error(`${label} did not return its study notes as JSON.`);
    return { guide: openStudyLabels(cleanModelText(text)), traditional_chinese: "" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned study notes in an invalid shape.`);
  }
  const record = unwrap(parsed as Record<string, unknown>);
  const guide = openStudyLabels(readFirst(record, GUIDE_KEYS));
  const traditional_chinese = openStudyLabels(readFirst(record, CHINESE_KEYS));
  if (!guide) {
    throw new Error(`${label} returned no study notes.`);
  }
  return { guide, traditional_chinese };
}
