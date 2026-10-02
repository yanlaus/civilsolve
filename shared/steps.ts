// A worked solution cut into its steps, for the "Try it yourself" hints:
// the student sees the plan (each step's title), then one step at a time,
// and the final answer last. The solve prompt asks for each step to open
// with a bold line of its own - "**Step 1 - Velocity of the jet**" - and for
// a heading per problem on a paper with several ("### Q1(a)"). Solutions
// written before that, or by a model that ignored it, often number their
// steps in bold anyway ("**4. Calculate Result:**"), and those are read too.
//
// Pure string logic. No DOM, no Workers APIs.

export type SolutionStep = {
  /** The step's title, as the plan shows it: "Step 1 - Velocity of the jet". */
  title: string;
  /** The step's working, Markdown with `$...$` LaTeX. */
  body: string;
};

export type SolutionPart = {
  /** The problem's heading on a paper with several ("Q1(a)"); null for a single problem. */
  heading: string | null;
  /** Anything before the part's first step. */
  intro: string;
  steps: SolutionStep[];
};

const PART_HEADING = /^\s*#{2,4}\s+(.+?)\s*#*\s*$/;

/** A line that opens a step, with the title it gives and any text after it on the line. */
function stepTitle(line: string): { title: string; rest: string } | null {
  const tidy = (title: string) => title.replace(/[\s:：.\-–—]+$/, "").trim();
  // "**Step 2 - Continuity**" or "**4. Calculate Result:**", alone on the line.
  let match = /^\s*(?:[-*]\s+)?\*\*\s*((?:Step\s*\d+|\d+[.)])[^*]*?)\s*\*\*\s*[:：]?\s*$/i.exec(line);
  if (match) return { title: tidy(match[1]), rest: "" };
  // "**Step 2:** Apply continuity ..." - the label in bold, the text after it.
  match = /^\s*(?:[-*]\s+)?\*\*\s*(Step\s*\d+[^*]*?)\s*\*\*\s*[:：.\-–—]?\s*(.+)$/i.exec(line);
  if (match) return { title: tidy(match[1]), rest: match[2].trim() };
  // "#### Step 2 - Continuity" under a problem's heading.
  match = /^\s*#{4,6}\s+((?:Step\s*\d+|\d+[.)]).*?)\s*#*\s*$/i.exec(line);
  if (match) return { title: tidy(match[1]), rest: "" };
  // "Step 2: Apply continuity" in plain text at the start of a line.
  match = /^\s*(Step\s*\d+)\s*[:：.\-–—]\s*(.+)$/i.exec(line);
  if (match) return { title: tidy(`${match[1]} - ${match[2]}`), rest: "" };
  return null;
}

function splitPart(heading: string | null, lines: string[]): SolutionPart {
  const part: SolutionPart = { heading, intro: "", steps: [] };
  const intro: string[] = [];
  let current: { title: string; body: string[] } | null = null;
  const close = () => {
    if (current) part.steps.push({ title: current.title, body: current.body.join("\n").trim() });
  };
  for (const line of lines) {
    const opened = stepTitle(line);
    if (opened) {
      close();
      current = { title: opened.title, body: opened.rest ? [opened.rest] : [] };
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  close();
  part.intro = intro.join("\n").trim();
  return part;
}

/**
 * The solution's working cut into problems and steps, or null when it cannot
 * be cut into at least two steps - the page then shows it whole.
 */
export function splitSolutionSteps(stepByStep: string): SolutionPart[] | null {
  const lines = stepByStep.replace(/\r\n/g, "\n").split("\n");
  const parts: SolutionPart[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    const match = PART_HEADING.exec(line);
    // "#### Step 3" is a step, not a problem.
    if (match && !stepTitle(line)) {
      if (heading !== null || buffer.some((entry) => entry.trim())) parts.push(splitPart(heading, buffer));
      heading = match[1].replace(/\*\*/g, "").trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (heading !== null || buffer.some((entry) => entry.trim())) parts.push(splitPart(heading, buffer));

  const stepCount = parts.reduce((sum, part) => sum + part.steps.length, 0);
  return stepCount >= 2 ? parts : null;
}
