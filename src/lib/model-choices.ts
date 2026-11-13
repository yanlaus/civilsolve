import { choiceKey, MODEL_CHOICES, servesPurpose, type ModelChoice, type ModelPurpose } from "../../shared/providers";

/**
 * A model list for one purpose - the readers and the reconciler
 * ("interpret"), the judge, the study notes' writer, the one who answers a
 * question - with `current` added when the list leaves it out and it serves
 * that purpose: a tier's own model (TIER_ONLY_PROVIDERS), such as the China
 * tier's GLM-5.3-Flash carried into Custom, or Qwen asked about its own
 * solution. A Flagship model (GPT-6 Astra, Claude Opus 5.5) is listed for
 * reading, solving and judging only, never for anything else, and never
 * added for it either (servesPurpose).
 */
export function choicesWith(
  current: ModelChoice | undefined,
  available: (choice: ModelChoice) => boolean,
  purpose: ModelPurpose,
) {
  const listed = MODEL_CHOICES.filter((choice) => available(choice) && servesPurpose(choice.provider, purpose));
  if (!current || !servesPurpose(current.provider, purpose)) return listed;
  return listed.some((choice) => choiceKey(choice) === choiceKey(current)) ? listed : [current, ...listed];
}
