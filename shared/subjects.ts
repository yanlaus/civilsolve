// The subject a question belongs to (14 November 2026, the owner's request):
// CivilSolve is used for the owner's steelwork, temporary works and
// geotechnical courses, and its solutions did not follow the methods the
// lectures teach. So a question's subject is settled before it is solved -
// picked on the form, or identified by a cheap model (DeepSeek, the
// `classify` task) from the pages - and every solver, judge, set of study
// notes and question about a solution of that subject is sent the course's
// method guide first in its instructions (worker/course-guides.ts).
//
// The guides are distilled once from the lecture notes and kept in R2, never
// in this repository (it is public, and the notes are the university's).
// This file holds only the subjects' names and the plain topic lists the
// classifier tells them apart by.
//
// Pure string logic shared by the Worker and the client. No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import { cleanModelText, normalizeJsonCandidate, stripThinkTags, type ParseOptions } from "./solution";

export type SubjectKey = "steelwork" | "temporary-works" | "geotechnical" | "other";

export const SUBJECT_KEYS: SubjectKey[] = ["steelwork", "temporary-works", "geotechnical", "other"];

export function isSubjectKey(value: unknown): value is SubjectKey {
  return typeof value === "string" && (SUBJECT_KEYS as string[]).includes(value);
}

export const SUBJECT_LABELS: Record<SubjectKey, { title: string; chinese: string }> = {
  steelwork: { title: "Steelwork", chinese: "鋼結構" },
  "temporary-works": { title: "Temporary works", chinese: "臨時工程" },
  geotechnical: { title: "Geotechnical", chinese: "岩土工程" },
  other: { title: "Other", chinese: "其他" },
};

/** "Steelwork 鋼結構". */
export function subjectName(subject: SubjectKey) {
  const label = SUBJECT_LABELS[subject];
  return `${label.title} ${label.chinese}`;
}

/**
 * What the form's subject picker holds: a subject, or "auto" - the
 * classifier decides once the pages are prepared.
 */
export type SubjectChoice = SubjectKey | "auto";

export const SUBJECT_CHOICES: SubjectChoice[] = ["auto", ...SUBJECT_KEYS];

export function isSubjectChoice(value: unknown): value is SubjectChoice {
  return value === "auto" || isSubjectKey(value);
}

/**
 * What each subject covers, for the classifier. Generic topic words only -
 * nothing of the lecture notes themselves.
 */
export const SUBJECT_SCOPES: Record<SubjectKey, string> = {
  steelwork:
    "Structural steelwork design by a limit-state steel code: connections (bolted tension splices, bolt groups in shear with torsion or tension, fillet-weld groups and brackets, angle tension members); beams (section classification, shear and moment capacity, deflection, web bearing and buckling, lateral-torsional buckling); columns and compression members (effective length, slenderness, strut curves, compressive strength, axial force with moments about one or both axes, nominal eccentricities, moment amplification). Typical clues: steel grades such as S275 or S355, rolled sections such as \"457 x 191 x 74 kg/m UB\" or \"254 x 254 x 89 UC\", Grade 8.8 bolts, electrode classes, dead and imposed load factors, floor plans with slabs on secondary and primary beams, and short theory items on limit states, section classes, fire or corrosion protection.",
  "temporary-works":
    "Temporary works in construction: the role and requirements of temporary works; concrete formwork and the lateral pressure of fresh concrete (a pressure formula with rate of rise and temperature, pressure plotted with depth); checks of wall, column and soffit formwork members (sheathing, joists, walings, soldiers, ties, props - bending, shear, deflection, maximum spacing); falsework and scaffold frames (leg loads, buckling, bracing, overturning, kentledge, ties); bamboo and metal scaffolding; groundwater control and dewatering; steel sheet-pile cofferdams (earth and water pressure, free earth support, prop load, embedment depth by trial, walings); shoring and trench support; the site-safety duties around them. Typical clues: concrete pour rate and height, \"check the adequacy\" or \"find the maximum spacing\" of formwork members, a cofferdam's embedment depth, descriptive questions on scaffolds, cofferdam failures or excavation safety.",
  geotechnical:
    "Geotechnical engineering: soil description and classification, phase relationships, effective stress, permeability and seepage, consolidation and settlement, shear strength, bearing capacity of foundations, lateral earth pressure on permanent retaining walls, slope stability, piles, site investigation.",
  other:
    "Anything else: structural analysis, reinforced concrete design, fluid mechanics, hydraulics, surveying, mathematics, or a question that belongs to none of the subjects above.",
};

/**
 * The tie-breaks the classifier is given, where two subjects share theory.
 */
export const SUBJECT_TIE_BREAKS = [
  "A question about temporarily supporting an excavation, a trench or a cofferdam, or about formwork or falsework, is temporary-works even when it uses earth-pressure or soil theory.",
  "A question about the soil itself, a permanent foundation, a permanent retaining wall or a slope is geotechnical.",
  "A question about designing or checking a steel member or connection is steelwork, even when the member is part of a temporary structure, unless the question is about formwork, falsework, scaffolding or excavation support as a whole.",
];

export type SubjectConfidence = "high" | "medium" | "low";

export type SubjectResult = {
  subject: SubjectKey;
  confidence: SubjectConfidence;
  /** One short sentence: why. */
  reason: string;
};

export const classifySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", enum: SUBJECT_KEYS },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" },
  },
  required: ["subject", "confidence", "reason"],
} as const;

/** A subject as a model wrote it: the key, or words on a schema-less rung ("Temporary Works", "geotech"). */
export function subjectOf(value: unknown): SubjectKey | null {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[_\s]+/g, "-") : "";
  if (!text) return null;
  if (isSubjectKey(text)) return text;
  if (/temp|formwork|falsework|scaffold|cofferdam|shoring|trench/.test(text)) return "temporary-works";
  if (/steel/.test(text)) return "steelwork";
  if (/geo|soil/.test(text)) return "geotechnical";
  if (/other|none|unknown/.test(text)) return "other";
  return null;
}

function confidenceOf(value: unknown): SubjectConfidence {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "high" || text === "low" ? text : "medium";
}

/**
 * The classifier's answer. JSON with a subject in it, at any depth of
 * wrapper; on the last attempt, a subject named anywhere in prose. Throws
 * when there is none, so the run retries while it can.
 */
export function parseClassification(rawText: string, provider: ProviderKey, options: ParseOptions = {}): SubjectResult {
  const text = stripThinkTags(rawText);
  let record: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(normalizeJsonCandidate(text)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
      if (!("subject" in record)) {
        const inner = Object.values(record).find(
          (value): value is Record<string, unknown> =>
            Boolean(value) && typeof value === "object" && !Array.isArray(value) && "subject" in (value as object),
        );
        if (inner) record = inner;
      }
    }
  } catch {
    record = null;
  }
  const subject = subjectOf(record?.subject) ?? (options.allowIncomplete ? subjectInProse(text) : null);
  if (!subject) {
    throw new Error(`${PROVIDER_LABELS[provider]} did not name the question's subject.`);
  }
  const reason = typeof record?.reason === "string" ? cleanModelText(record.reason).slice(0, 300) : "";
  return { subject, confidence: confidenceOf(record?.confidence), reason };
}

/** The first subject key a reply names in words, when it gave no JSON. */
function subjectInProse(text: string): SubjectKey | null {
  const lower = text.toLowerCase();
  const found = SUBJECT_KEYS.map((key) => ({ key, at: lower.indexOf(key) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return found?.key ?? null;
}
