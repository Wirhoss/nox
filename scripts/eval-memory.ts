/**
 * Scores the memory's extraction prompt against a real model.
 *
 * Kept out of `bun test` on purpose: it costs money, needs a reachable
 * endpoint, and does not return the same answer twice, so it cannot gate a
 * commit. What it does is make a prompt change measurable — run it before and
 * after, and the two reports say whether the change helped or only felt better.
 *
 *   NOX_EVAL_BASE_URL=https://api.openai.com/v1  *   NOX_EVAL_API_KEY=sk-...  *   NOX_EVAL_MODEL=gpt-4o-mini  *   bun run scripts/eval-memory.ts
 */
import { EVAL_CORPUS, evaluate } from '../src/extensions/builtin/memories/semantic/evaluation';
import { OpenAICompletions } from '../src/extensions/builtin/providers/openai/openAICompletions';

import type { ChatModel, ChatModelConfig, SecretHandle } from '@nox/extension-api';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Set ${name} to run the memory evaluation.`);
  }
  return value;
}

/** The shape a provider expects for a credential, without a secret store behind it. */
function handle(value: string): SecretHandle {
  return {
    id: 'NOX_EVAL_API_KEY',
    reveal: () => value,
    toJSON: () => '[secret]',
    toString: () => '[secret]',
  };
}

const modelId = required('NOX_EVAL_MODEL');
const model: ChatModelConfig = {
  inputModalities: ['text'],
  kind: 'chat',
  modelId,
  outputModalities: ['text'],
};

const provider = new OpenAICompletions({
  apiKey: handle(required('NOX_EVAL_API_KEY')),
  type: 'openai_completions',
  baseUrl: required('NOX_EVAL_BASE_URL'),
  defaultModel: modelId,
  modelConfigs: [model],
});

/**
 * The same handle shape the memory is given at runtime, so the prompt under
 * test is reached by exactly the path it is reached by in production.
 */
const chat: ChatModel = {
  config: () => model,
  reference: { model: modelId, provider: 'eval' },
  stream: (systemPrompt, history, tools, options) =>
    provider.getMessageStream(systemPrompt, [...history], [...tools], { ...options, model }),
};

const report = await evaluate(chat, EVAL_CORPUS);

for (const result of report.cases) {
  const mark = result.passed ? 'pass' : 'FAIL';
  process.stdout.write(`${mark}  ${result.case.name}\n`);
  if (result.passed) continue;
  process.stdout.write(`      why it is here: ${result.case.why}\n`);
  for (const missed of result.missed) {
    process.stdout.write(`      missed: mentions ${missed.mentions.join(', ')}\n`);
  }
  for (const extra of result.spurious) {
    process.stdout.write(`      invented: [${extra.kind}] ${extra.text}\n`);
  }
  if (!result.invalidationCorrect) {
    const ended = result.drafts.flatMap((draft) => [...draft.invalidates]);
    process.stdout.write(
      `      invalidation: ended [${ended.join(', ')}], expected [${result.case.invalidates.join(', ')}]\n`,
    );
  }
  if (!result.reinforcementCorrect) {
    const reinforced = result.drafts.flatMap((draft) =>
      draft.reinforces === undefined ? [] : [draft.reinforces],
    );
    process.stdout.write(
      `      reinforcement: supported [${reinforced.join(', ')}], ` +
        `expected [${(result.case.reinforces ?? []).join(', ')}]\n`,
    );
  }
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
process.stdout.write(
  `\n${String(report.passed)}/${String(report.total)} cases  ` +
    `precision ${percent(report.precision)}  ` +
    `recall ${percent(report.recall)}  ` +
    `invalidation ${percent(report.invalidationAccuracy)}  ` +
    `reinforcement ${percent(report.reinforcementAccuracy)}\n`,
);

// Non-zero on any failure, so this can gate a prompt change in CI where a model
// is reachable, without pretending it belongs in the unit suite.
if (report.passed < report.total) process.exit(1);
