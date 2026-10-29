/**
 * The ONE place that talks to a model provider.
 *
 * Both Meta's Model API and Baseten speak the OpenAI chat format, so one
 * client covers both; only the base URL, key and model name change. The
 * 'fake' provider returns a canned answer so the whole pipeline can be built
 * and tested without spending credits.
 */
import OpenAI from 'openai';

export type Provider = 'fake' | 'meta' | 'baseten';
export type Effort = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelCall {
  system: string;
  user: string;
  /** Room for the answer. Reasoning models spend part of it thinking first. */
  maxTokens?: number;
  effort?: Effort;
  /** Token counts from each response are added here, when given. */
  usage?: Usage;
}

/** Token counts for one step, summed over its calls. `reasoning` is part of `output`. */
export interface Usage {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, input: 0, output: 0, reasoning: 0 });

interface ProviderConfig {
  baseURL: string;
  keyEnv: string;
  model: () => string;
}

const PROVIDERS: Record<Exclude<Provider, 'fake'>, ProviderConfig> = {
  // Standard mode only: Contributor mode trains on what you send.
  meta: {
    baseURL: 'https://api.meta.ai/v1',
    keyEnv: 'MODEL_API_KEY',
    model: () => process.env.LUCID_META_MODEL?.trim() || 'muse-spark-1.3',
  },
  // Muse Spark Open (open weights). The hackathon key only works with this exact name.
  baseten: {
    baseURL: 'https://inference.baseten.co/v1',
    keyEnv: 'BASETEN_API_KEY',
    model: () => process.env.LUCID_BASETEN_MODEL?.trim() || 'meta-models/muse-spark-open-1026',
  },
};

const clients = new Map<string, OpenAI>();

const clientFor = (provider: Exclude<Provider, 'fake'>): OpenAI => {
  const cached = clients.get(provider);
  if (cached) return cached;
  const config = PROVIDERS[provider];
  const apiKey = process.env[config.keyEnv]?.trim();
  if (!apiKey) throw new Error(`${config.keyEnv} is not set. Add it to your .env file (never commit it).`);
  const client = new OpenAI({ baseURL: config.baseURL, apiKey, timeout: 120_000, maxRetries: 2 });
  clients.set(provider, client);
  return client;
};

export const isProvider = (v: string | undefined): v is Provider => v === 'fake' || v === 'meta' || v === 'baseten';

/** Which provider runs a step, from LUCID_PICK_PROVIDER / LUCID_WRITE_PROVIDER. Defaults to fake. */
export const providerFor = (step: 'pick' | 'write'): Provider => {
  const value = process.env[step === 'pick' ? 'LUCID_PICK_PROVIDER' : 'LUCID_WRITE_PROVIDER']?.trim();
  return isProvider(value) ? value : 'fake';
};

export const modelName = (provider: Provider): string => (provider === 'fake' ? 'fake' : PROVIDERS[provider].model());

/**
 * Send one request and return the model's final answer as text.
 * `fake` is only used by the fake provider: it builds a canned answer.
 */
export const callModel = async (provider: Provider, call: ModelCall, fake?: () => string): Promise<string> => {
  if (provider === 'fake') {
    if (!fake) throw new Error('The fake provider needs a canned answer for this step.');
    return fake();
  }
  const client = clientFor(provider);
  const response = await client.chat.completions.create({
    model: PROVIDERS[provider].model(),
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    max_tokens: call.maxTokens ?? 4000,
    // Both APIs accept reasoning_effort; the SDK's type only lists OpenAI's values.
    ...(call.effort ? ({ reasoning_effort: call.effort } as Record<string, unknown>) : {}),
  });
  if (call.usage) {
    // Counted before the content check: an empty answer still cost its tokens.
    call.usage.calls += 1;
    call.usage.input += response.usage?.prompt_tokens ?? 0;
    call.usage.output += response.usage?.completion_tokens ?? 0;
    call.usage.reasoning += response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  }
  const choice = response.choices[0];
  const content = choice?.message?.content;
  if (!content || !content.trim()) {
    const why = choice?.finish_reason === 'length' ? ' (it ran out of tokens, likely while reasoning)' : '';
    throw new Error(`${provider} returned an empty answer${why}.`);
  }
  return content;
};
