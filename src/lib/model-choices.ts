import { choiceKey, MODEL_CHOICES, type ModelChoice } from "../../shared/providers";

/**
 * A model list - the readers, the reconciler, the judge, the study notes'
 * writer, the one who answers a question - with `current` added when the
 * list leaves it out: a tier's own model (TIER_ONLY_PROVIDERS), such as the
 * China tier's GLM-5.3-Flash carried into Custom, or the Flagship tier's
 * Claude Opus 5.5 as its run's judge or as the solver asked about its own
 * solution.
 */
export function choicesWith(current: ModelChoice | undefined, available: (choice: ModelChoice) => boolean) {
  const listed = MODEL_CHOICES.filter(available);
  if (!current) return listed;
  return listed.some((choice) => choiceKey(choice) === choiceKey(current)) ? listed : [current, ...listed];
}
