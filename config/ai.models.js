/*
  The Claude models AI Settings may pick from — the one list the screen, the
  validator and the cost estimate share. Prices are USD per million tokens
  (Anthropic first-party rates), used only to estimate what a scan cost.

  `fallback`: Sonnet / Opus can hand a rare policy decline to another model
  inside the same call (server-side fallback); Haiku has no such fallback.
*/
export const AI_MODELS = [
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    hint: "Fastest and cheapest — good for testing",
    inputPerM: 0.1,
    outputPerM: 0.5,
    fallback: false,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    hint: "Balanced speed and accuracy",
    inputPerM: 2,
    outputPerM: 10,
    fallback: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    hint: "Most accurate — for hard-to-read invoices",
    inputPerM: 4,
    outputPerM: 20,
    fallback: true,
  },
];

export const DEFAULT_AI_MODEL = "claude-haiku-5-5";

export const aiModelById = (id) => AI_MODELS.find((m) => m.id === id) || null;

// A rough INR rate for the cost estimate shown on AI Settings — not accounting.
export const USD_TO_INR = Number(process.env.USD_TO_INR) || 85;

export const estimateCostUsd = (modelId, usage = {}) => {
  const m = aiModelById(modelId);
  if (!m) return 0;
  return ((usage.inputTokens || 0) * m.inputPerM + (usage.outputTokens || 0) * m.outputPerM) / 1_000_000;
};
