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

const LABEL_PATTERNS = Object.values(STUDY_PARTS)
  .flatMap((parts) => parts.flatMap((part) => [part.label, part.chinese]))
  .map((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "**Approach**", "- **Approach:**", "**Approach** -", at a line's start.
    const opening = `^[ \\t]*(?:[-*][ \\t]+)?\\*\\*(${escaped})[ \\t]*[:：]?\\*\\*[ \\t]*[-–—:：]?[ \\t]*`;
    return { alone: new RegExp(`${opening}$`, "gm"), inline: new RegExp(`${opening}(?=\\S)`, "gm") };
  });

/**
 * Puts each part's label on a line of its own, as the prompt asks. Models
 * also ran the part on after it - "**Approach** - 1. Identify ..." from
 * DeepSeek (28 September 2026) - which cut the numbered steps' list in two.
 */
export function openStudyLabels(text: string) {
  let out = text;
  for (const { alone, inline } of LABEL_PATTERNS) {
    out = out.replace(alone, "**$1**").replace(inline, "**$1**\n\n");
  }
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
