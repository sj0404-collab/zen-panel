const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.npm-hub');
const CONFIG_FILE = path.join(CONFIG_DIR, 'models.json');
const KEYS_FILE = path.join(CONFIG_DIR, 'keys.json');

// No bundled API keys: the OpenRouter key comes from OPENROUTER_API_KEY env
// or ~/.npm-hub/keys.json (set via the key modal). Never commit real keys.

// ═══════════════════════════════════════════════════════════════
// ALL OPENCODE MODELS - полный реестр как в интерфейсе OpenCode
// ═══════════════════════════════════════════════════════════════

const PROVIDERS = {
  // ─── OPENCODE ZEN (бесплатные через opencode.ai) ───
  opencode: {
    name: 'OpenCode Zen',
    env: 'OPENCODE_API_KEY',
    baseUrl: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1',
    icon: '🟢',
    free: true,
    models: [
      { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', ctx: 128000, out: 32000, reasoning: false },
      { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', ctx: 128000, out: 32000, reasoning: false },
      { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free', ctx: 128000, out: 32000, reasoning: false },
      { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', ctx: 128000, out: 32000, reasoning: false },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', ctx: 128000, out: 32000, reasoning: false },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', ctx: 128000, out: 32000, reasoning: false },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', ctx: 200000, out: 64000, reasoning: true },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', ctx: 200000, out: 64000, reasoning: true },
      { id: 'gpt-5', name: 'GPT-5', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', ctx: 1000000, out: 64000, reasoning: false },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', ctx: 1000000, out: 64000, reasoning: false },
    ]
  },

  // ─── OPENCODE GO ───
  'opencode-go': {
    name: 'OpenCode Go',
    env: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    icon: '🟢',
    free: true,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', ctx: 128000, out: 32000 },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', ctx: 128000, out: 32000 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', ctx: 128000, out: 32000 },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max', ctx: 128000, out: 32000 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', ctx: 128000, out: 32000 },
      { id: 'glm-5.1', name: 'GLM-5.1', ctx: 128000, out: 32000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', ctx: 128000, out: 32000 },
      { id: 'minimax-m3', name: 'MiniMax M3', ctx: 128000, out: 32000 },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7', ctx: 128000, out: 32000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', ctx: 128000, out: 32000 },
    ]
  },

  // ─── OPENROUTER (все модели через один ключ) ───
  openrouter: {
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    icon: '🟣',
    free: false,
    models: [
      // Free
      { id: 'openrouter/owl-alpha', name: 'OWL Alpha', ctx: 128000, out: 32000, free: true },
      { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', ctx: 128000, out: 32000, free: true },
      { id: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B', ctx: 131072, out: 32000, free: true },
      { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', ctx: 128000, out: 32000, free: true },
      { id: 'google/gemma-3-12b-it:free', name: 'Gemma 3 12B', ctx: 128000, out: 32000, free: true },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', ctx: 128000, out: 32000, free: true },
      { id: 'meta-llama/llama-3.2-3b-instruct:free', name: 'Llama 3.2 3B', ctx: 128000, out: 32000, free: true },
      { id: 'deepseek/deepseek-v4-flash:free', name: 'DeepSeek V4 Flash', ctx: 128000, out: 32000, free: true },
      { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B', ctx: 128000, out: 32000, free: true },
      { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air', ctx: 128000, out: 32000, free: true },
      { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B', ctx: 131072, out: 32000, free: true },
      { id: 'moonshotai/kimi-k2.6:free', name: 'Kimi K2.6', ctx: 128000, out: 32000, free: true },
      // Paid
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', ctx: 200000, out: 64000 },
      { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', ctx: 200000, out: 64000 },
      { id: 'openai/gpt-4o', name: 'GPT-4o', ctx: 128000, out: 16000 },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1000000, out: 64000 },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', ctx: 128000, out: 32000 },
    ]
  },

  // ─── ANTHROPIC ───
  anthropic: {
    name: 'Anthropic',
    env: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    icon: '🟠',
    free: false,
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', ctx: 1000000, out: 128000, reasoning: true },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', ctx: 1000000, out: 128000, reasoning: true },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', ctx: 1000000, out: 128000, reasoning: true },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', ctx: 200000, out: 64000, reasoning: true },
      { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', ctx: 200000, out: 32000, reasoning: true },
      { id: 'claude-opus-4-0', name: 'Claude Opus 4', ctx: 200000, out: 32000, reasoning: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', ctx: 1000000, out: 64000, reasoning: true },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', ctx: 200000, out: 64000, reasoning: true },
      { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', ctx: 200000, out: 64000, reasoning: true },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', ctx: 200000, out: 64000, reasoning: true },
      { id: 'claude-fable-5', name: 'Claude Fable 5', ctx: 1000000, out: 128000, reasoning: true },
    ]
  },

  // ─── OPENAI ───
  openai: {
    name: 'OpenAI',
    env: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    icon: '⚫',
    free: false,
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', ctx: 1050000, out: 128000, reasoning: true },
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', ctx: 1050000, out: 128000, reasoning: true },
      { id: 'gpt-5.4', name: 'GPT-5.4', ctx: 1050000, out: 128000, reasoning: true },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', ctx: 1050000, out: 128000, reasoning: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.2', name: 'GPT-5.2', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.1', name: 'GPT-5.1', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5', name: 'GPT-5', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5-pro', name: 'GPT-5 Pro', ctx: 400000, out: 272000, reasoning: true },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', ctx: 400000, out: 128000, reasoning: true },
      { id: 'gpt-4o', name: 'GPT-4o', ctx: 128000, out: 16000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', ctx: 128000, out: 16000 },
      { id: 'gpt-4.1', name: 'GPT-4.1', ctx: 1000000, out: 32000 },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', ctx: 1000000, out: 32000 },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', ctx: 1000000, out: 32000 },
      { id: 'o3', name: 'o3', ctx: 200000, out: 100000, reasoning: true },
      { id: 'o3-pro', name: 'o3-pro', ctx: 200000, out: 100000, reasoning: true },
      { id: 'o3-mini', name: 'o3-mini', ctx: 200000, out: 100000, reasoning: true },
      { id: 'o4-mini', name: 'o4-mini', ctx: 200000, out: 100000, reasoning: true },
      { id: 'o1', name: 'o1', ctx: 200000, out: 100000, reasoning: true },
      { id: 'o1-pro', name: 'o1-pro', ctx: 200000, out: 100000, reasoning: true },
    ]
  },

  // ─── GOOGLE ───
  google: {
    name: 'Google',
    env: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com',
    icon: '🔵',
    free: false,
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', ctx: 1000000, out: 64000 },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', ctx: 1000000, out: 64000 },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', ctx: 1000000, out: 64000 },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', ctx: 1000000, out: 64000 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1000000, out: 64000, reasoning: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ctx: 1000000, out: 64000 },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', ctx: 1000000, out: 64000 },
      { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', ctx: 262000, out: 32000 },
      { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B', ctx: 262000, out: 32000 },
    ]
  },

  // ─── DEEPSEEK ───
  deepseek: {
    name: 'DeepSeek',
    env: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    icon: '🔷',
    free: false,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', ctx: 1000000, out: 384000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', ctx: 1000000, out: 384000, reasoning: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', ctx: 1000000, out: 384000, reasoning: true },
      { id: 'deepseek-chat', name: 'DeepSeek Chat', ctx: 1000000, out: 384000 },
    ]
  },

  // ─── XAI ───
  xai: {
    name: 'xAI',
    env: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    icon: '✖️',
    free: false,
    models: [
      { id: 'grok-4.3', name: 'Grok 4.3', ctx: 1000000, out: 30000, reasoning: true },
      { id: 'grok-4.20-multi-agent-0309', name: 'Grok 4.20 Multi-Agent', ctx: 1000000, out: 30000, reasoning: true },
      { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning', ctx: 1000000, out: 30000, reasoning: true },
      { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20', ctx: 1000000, out: 30000 },
      { id: 'grok-build-0.1', name: 'Grok Build 0.1', ctx: 256000, out: 256000 },
    ]
  },

  // ─── MISTRAL ───
  mistral: {
    name: 'Mistral',
    env: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    icon: '🟤',
    free: false,
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', ctx: 262000, out: 262000 },
      { id: 'mistral-medium-latest', name: 'Mistral Medium', ctx: 262000, out: 262000 },
      { id: 'mistral-small-latest', name: 'Mistral Small', ctx: 256000, out: 256000 },
      { id: 'codestral-latest', name: 'Codestral', ctx: 256000, out: 4000 },
      { id: 'devstral-latest', name: 'Devstral 2', ctx: 262000, out: 262000 },
      { id: 'magistral-small', name: 'Magistral Small', ctx: 128000, out: 128000 },
      { id: 'pixtral-large-latest', name: 'Pixtral Large', ctx: 128000, out: 128000 },
      { id: 'mistral-nemo', name: 'Mistral Nemo', ctx: 128000, out: 128000 },
      { id: 'ministral-8b-latest', name: 'Ministral 8B', ctx: 128000, out: 128000 },
      { id: 'ministral-3b-latest', name: 'Ministral 3B', ctx: 128000, out: 128000 },
    ]
  },

  // ─── GROQ ───
  groq: {
    name: 'Groq',
    env: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    icon: '⚡',
    free: false,
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', ctx: 128000, out: 32000 },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', ctx: 128000, out: 32000 },
      { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', ctx: 131072, out: 32000 },
      { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', ctx: 131072, out: 32000 },
      { id: 'qwen/qwen3-32b', name: 'Qwen3-32B', ctx: 128000, out: 32000 },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', ctx: 128000, out: 32000 },
    ]
  },

  // ─── PERPLEXITY ───
  perplexity: {
    name: 'Perplexity',
    env: 'PERPLEXITY_API_KEY',
    baseUrl: 'https://api.perplexity.ai',
    icon: '🔍',
    free: false,
    models: [
      { id: 'sonar-pro', name: 'Sonar Pro', ctx: 200000, out: 8000 },
      { id: 'sonar', name: 'Sonar', ctx: 200000, out: 8000 },
      { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', ctx: 200000, out: 8000, reasoning: true },
      { id: 'sonar-reasoning', name: 'Sonar Reasoning', ctx: 200000, out: 8000, reasoning: true },
    ]
  },

  // ─── XIAOMI ───
  xiaomi: {
    name: 'Xiaomi',
    env: 'XIAOMI_API_KEY',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    icon: '📱',
    free: false,
    models: [
      { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', ctx: 128000, out: 32000, free: true },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', ctx: 128000, out: 32000 },
      { id: 'mimo-v2-pro-free', name: 'MiMo V2 Pro Free', ctx: 128000, out: 32000, free: true },
    ]
  },

  // ─── ZHIPU (GLM) ───
  zhipuai: {
    name: 'Zhipu AI (GLM)',
    env: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    icon: '🟢',
    free: false,
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1', ctx: 128000, out: 32000 },
      { id: 'glm-4.7', name: 'GLM-4.7', ctx: 128000, out: 32000 },
      { id: 'glm-4.7-free', name: 'GLM-4.7 Free', ctx: 128000, out: 32000, free: true },
    ]
  },

  // ─── MINIMAX ───
  minimax: {
    name: 'MiniMax',
    env: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.chat/v1',
    icon: '🔷',
    free: false,
    models: [
      { id: 'minimax-m3', name: 'MiniMax M3', ctx: 128000, out: 32000 },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7', ctx: 128000, out: 32000 },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', ctx: 128000, out: 32000 },
      { id: 'minimax-m3-free', name: 'MiniMax M3 Free', ctx: 128000, out: 32000, free: true },
    ]
  },

  // ─── MOONSHOT (Kimi) ───
  moonshotai: {
    name: 'Moonshot AI (Kimi)',
    env: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    icon: '🌙',
    free: false,
    models: [
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', ctx: 128000, out: 32000 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', ctx: 128000, out: 32000 },
      { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free', ctx: 128000, out: 32000, free: true },
      { id: 'kimi-k2', name: 'Kimi K2', ctx: 128000, out: 32000 },
    ]
  },

  // ─── CEREBRAS ───
  cerebras: {
    name: 'Cerebras',
    env: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    icon: '🧠',
    free: false,
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', ctx: 128000, out: 32000 },
      { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', ctx: 128000, out: 32000 },
    ]
  },

  // ─── TOGETHER AI ───
  togetherai: {
    name: 'Together AI',
    env: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    icon: '🤝',
    free: false,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', ctx: 128000, out: 32000 },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', ctx: 128000, out: 32000 },
    ]
  },

  // ─── DEEPINFRA ───
  deepinfra: {
    name: 'Deep Infra',
    env: 'DEEPINFRA_API_KEY',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    icon: '🌐',
    free: false,
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B', ctx: 128000, out: 32000 },
    ]
  },

  // ─── NVIDIA ───
  nvidia: {
    name: 'Nvidia',
    env: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    icon: '💚',
    free: false,
    models: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', ctx: 128000, out: 32000 },
    ]
  },

  // ─── HUGGINGFACE ───
  huggingface: {
    name: 'Hugging Face',
    env: 'HF_TOKEN',
    baseUrl: 'https://router.huggingface.co/v1',
    icon: '🤗',
    free: false,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', ctx: 128000, out: 32000 },
    ]
  },

  // ─── GITHUB MODELS ───
  'github-models': {
    name: 'GitHub Models',
    env: 'GITHUB_TOKEN',
    baseUrl: 'https://models.github.ai/inference',
    icon: '🐙',
    free: false,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', ctx: 128000, out: 16000 },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', ctx: 200000, out: 64000 },
    ]
  },

  // ─── QWEN (Alibaba) ───
  alibaba: {
    name: 'Qwen (Alibaba)',
    env: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    icon: '🟣',
    free: false,
    models: [
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max', ctx: 128000, out: 32000 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', ctx: 128000, out: 32000 },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', ctx: 128000, out: 32000 },
      { id: 'qwen3-coder', name: 'Qwen3 Coder', ctx: 128000, out: 32000 },
    ]
  },

  // ─── STEPFUN ───
  stepfun: {
    name: 'StepFun',
    env: 'STEPFUN_API_KEY',
    baseUrl: 'https://api.stepfun.com/v1',
    icon: '🔷',
    free: false,
    models: [
      { id: 'step-2-16k', name: 'Step 2 16K', ctx: 16000, out: 4000 },
    ]
  },

  // ─── SILICONFLOW ───
  siliconflow: {
    name: 'SiliconFlow',
    env: 'SILICONFLOW_API_KEY',
    baseUrl: 'https://api.siliconflow.cn/v1',
    icon: '🌐',
    free: false,
    models: [
      { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B', ctx: 131072, out: 32000 },
    ]
  },

  // ─── OLLAMA (local) ───
  ollama: {
    name: 'Ollama (Local)',
    env: '',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    icon: '🦙',
    free: true,
    local: true,
    models: [] // dynamically discovered
  },
};

const API_KEYS_FILE = path.join(HOME, '.npm-hub', 'keys.json');

class ModelManager {
  constructor() {
    this._ensureDir();
    this.config = this._loadConfig();
    this.customKeys = this._loadKeys();
    this.liveCache = this._loadLiveCache();
    this._applyLiveCache();
  }

  _ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  _loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
    return { selectedModel: 'mimo-v2.5-free', selectedProvider: 'opencode', freeOnly: false };
  }

  _saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2)); }

  _loadKeys() {
    try {
      if (fs.existsSync(KEYS_FILE)) return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    } catch {}
    return {};
  }

  _saveKeys() { fs.writeFileSync(KEYS_FILE, JSON.stringify(this.customKeys, null, 2)); }

  // Full keys never leave the server: the UI only gets a masked preview.
  maskKey(key) {
    if (!key || key === '(free)') return '';
    if (key.length <= 10) return '••••••';
    return key.slice(0, 6) + '••••' + key.slice(-4);
  }

  getApiKeyMasked() { return this.maskKey(this.getKeyForProvider('openrouter')); }

  // Get all providers
  getProviders() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({
      id, name: p.name, icon: p.icon, free: p.free, local: p.local || false,
      modelCount: p.models.length,
      keyMasked: this.maskKey(this.getKeyForProvider(id)),
      hasKey: (() => { const k = this.getKeyForProvider(id); return !!k && k !== '(free)'; })(),
      configured: !!(p.free || this.customKeys[p.env] || process.env[p.env])
    }));
  }

  // Get all models (flat list)
  getAllModels(freeOnly = false) {
    const result = [];
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      for (const m of provider.models) {
        if (freeOnly && !m.free && !provider.free) continue;
        result.push({
          ...m,
          providerId,
          providerName: provider.name,
          providerIcon: provider.icon,
          free: m.free || provider.free,
          fullId: providerId === 'openrouter' || providerId === 'opencode' || providerId === 'opencode-go'
            ? m.id : `${providerId}/${m.id}`,
        });
      }
    }
    return result;
  }

  // Get model with full info
  getModelsFull() {
    const models = this.getAllModels();
    const selected = this.config.selectedModel;
    return models.map(m => ({
      ...m,
      selected: m.id === selected || m.fullId === selected,
      keyMasked: this.maskKey(this.getKeyForProvider(m.providerId)),
    }));
  }

  getKeyForProvider(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) return '';
    if (provider.free) return '(free)';
    if (this.customKeys[provider.env]) return this.customKeys[provider.env];
    if (process.env[provider.env]) return process.env[provider.env];
    return '';
  }

  setKey(providerEnv, key) {
    this.customKeys[providerEnv] = key;
    this._saveKeys();
  }

  getSelectedModel() { return this.config.selectedModel; }
  getSelectedProvider() { return this.config.selectedProvider; }

  selectModel(modelId, providerId) {
    // The top-bar menu posts the id only: resolve the provider from the registry.
    if (!providerId) {
      for (const [pid, p] of Object.entries(PROVIDERS)) {
        if (p.models.some(m => m.id === modelId || `${pid}/${m.id}` === modelId)) { providerId = pid; break; }
      }
    }
    this.config.selectedModel = modelId;
    this.config.selectedProvider = providerId;
    this._saveConfig();
    this._syncAllTools(modelId, providerId);
    return { success: true };
  }


  // ── LIVE CATALOGUES (auto add/update free+paid models) ──
  // Zen needs no key, OpenRouter /models is public, Ollama is local.
  // Results persist in ~/.npm-hub/live-models.json so restarts and
  // offline runs keep the last known roster.
  _httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const req = lib.request(url, { method, headers, timeout: timeoutMs }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch { reject(new Error('Bad JSON')); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  _prettyName(id) {
    return id.split('/').pop().replace(/[-_:]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  _loadLiveCache() {
    try {
      const f = path.join(CONFIG_DIR, 'live-models.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch {}
    return null;
  }

  _saveLiveCache(cache) {
    try { fs.writeFileSync(path.join(CONFIG_DIR, 'live-models.json'), JSON.stringify(cache)); } catch {}
  }

  _mergeLive(providerId, liveModels, { replace = false } = {}) {
    const p = PROVIDERS[providerId];
    if (!p) return 0;
    if (replace) {
      p.models = p.models.filter(m => !m.live).concat(liveModels.map(m => ({ ...m, live: true })));
      return liveModels.length;
    }
    const seen = new Set(p.models.map(m => m.id));
    let added = 0;
    for (const m of liveModels) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      p.models.push({ ...m, live: true });
      added++;
    }
    return added;
  }

  _applyLiveCache() {
    const c = this.liveCache;
    if (!c || !c.roster) return;
    for (const [pid, list] of Object.entries(c.roster)) {
      if (Array.isArray(list)) this._mergeLive(pid, list, { replace: pid === 'ollama' });
    }
  }

  async refreshLive() {
    const roster = (this.liveCache && this.liveCache.roster) || {};
    const added = {};
    const errors = {};

    const zenJob = (async () => {
      try {
        const base = PROVIDERS.opencode.baseUrl.replace(/\/$/, '');
        const { json } = await this._httpJson(`${base}/models`);
        const list = (json.data || []).map(m => m && m.id).filter(Boolean).map(id => ({
          id, name: this._prettyName(id), ctx: 128000, out: 32000,
          free: /-free$/i.test(id) || id === 'big-pickle'
        }));
        roster.opencode = list;
        added.opencode = this._mergeLive('opencode', list);
      } catch (e) { errors.opencode = e.message || String(e); }
    })();

    const orJob = (async () => {
      try {
        const base = PROVIDERS.openrouter.baseUrl.replace(/\/$/, '');
        const key = this.getKeyForProvider('openrouter');
        const headers = key && key !== '(free)' ? { Authorization: `Bearer ${key}` } : {};
        const { json } = await this._httpJson(`${base}/models`, { headers });
        const list = (json.data || []).slice(0, 1000).map(m => ({
          id: m.id, name: m.name || this._prettyName(m.id),
          ctx: m.context_length || 128000, out: 32000,
          free: String(m.id).endsWith(':free') ||
            (m.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0')
        })).filter(m => m.id);
        roster.openrouter = list;
        added.openrouter = this._mergeLive('openrouter', list);
      } catch (e) { errors.openrouter = e.message || String(e); }
    })();

    const ollamaJob = (async () => {
      try {
        const root = PROVIDERS.ollama.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
        const { json } = await this._httpJson(`${root}/api/tags`, { timeoutMs: 5000 });
        const list = (json.models || []).map(m => ({
          id: m.name, name: m.name, ctx: 128000, out: 32000, free: true
        })).filter(m => m.id);
        roster.ollama = list;
        added.ollama = this._mergeLive('ollama', list, { replace: true });
      } catch (e) { errors.ollama = e.message || String(e); }
    })();

    await Promise.all([zenJob, orJob, ollamaJob]);
    this.liveCache = { updatedAt: Date.now(), roster };
    this._saveLiveCache(this.liveCache);
    return { updatedAt: this.liveCache.updatedAt, added, errors };
  }

  // ── MODEL PROBE: tiny OpenAI-compatible chat completion ──
  static PROBE_SKIP = new Set(['anthropic', 'google']);
  async testModel(modelId, providerId) {
    const p = PROVIDERS[providerId];
    if (!p) return { ok: false, error: 'Unknown provider' };
    if (ModelManager.PROBE_SKIP.has(providerId)) return { ok: false, error: 'Проба поддерживает только OpenAI-совместимые API' };
    const key = this.getKeyForProvider(providerId);
    if (!key && !p.free) return { ok: false, error: 'Нет ключа для провайдера' };
    const base = p.baseUrl.replace(/\/$/, '');
    const t0 = Date.now();
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key && key !== '(free)') headers.Authorization = `Bearer ${key}`;
      await this._httpJson(`${base}/chat/completions`, {
        method: 'POST', headers, timeoutMs: 30000,
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, temperature: 0 })
      });
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) };
    }
  }

  // ── MONITORING: reachability + latency per provider ──
  async health() {
    const jobs = Object.entries(PROVIDERS).map(async ([id, p]) => {
      const t0 = Date.now();
      const base = { id, name: p.name, icon: p.icon, ms: Date.now() - t0, models: p.models.length };
      try {
        const target = id === 'ollama'
          ? p.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/tags'
          : p.baseUrl.replace(/\/$/, '');
        await this._httpJson(target, { timeoutMs: 8000 });
        return { ...base, ok: true, ms: Date.now() - t0 };
      } catch (e) {
        // A 200 with a non-JSON body still proves the host is up
        // (_httpJson rejects >= 400 before parsing).
        if (e.message === 'Bad JSON') return { ...base, ok: true, ms: Date.now() - t0 };
        // Any HTTP status below 500 proves reachability; only network
        // errors and 5xx count as down.
        const m = /^HTTP (\d+)/.exec(e.message || '');
        const ok = !!m && +m[1] < 500;
        return { ...base, ok, ms: Date.now() - t0, error: ok ? undefined : String(e.message || 'unreachable').slice(0, 120) };
      }
    });
    return Promise.all(jobs);
  }

  // Sync to all CLI tools
  _syncAllTools(modelId, providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) return;
    const key = this.getKeyForProvider(providerId);
    const baseUrl = provider.baseUrl;

    // Determine the full model ID for OpenRouter-style tools
    let syncModel = modelId;
    if (providerId === 'opencode' || providerId === 'opencode-go') {
      syncModel = modelId; // these are already full IDs
    } else if (providerId !== 'openrouter') {
      syncModel = `${providerId}/${modelId}`;
    }

    this._syncOpenClaude(syncModel, key, baseUrl);
    this._syncQwen(syncModel, key, baseUrl);
    this._syncCliAgent(syncModel, key, baseUrl);
  }

  _syncOpenClaude(model, key, baseUrl) {
    try {
      const cfgDir = path.join(HOME, '.openclaude');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
      const settingsPath = path.join(cfgDir, 'settings.json');
      let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
      s.model = model;
      if (s.agents) for (const a of Object.keys(s.agents)) s.agents[a].model = model;
      if (!s.environmentVariables) s.environmentVariables = {};
      s.environmentVariables.ANTHROPIC_BASE_URL = baseUrl;
      s.environmentVariables.ANTHROPIC_MODEL = model;
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
      fs.writeFileSync(path.join(cfgDir, '.env'), `ANTHROPIC_API_KEY=${key}\nANTHROPIC_BASE_URL=${baseUrl}\n`);
      const pp = path.join(cfgDir, '.openclaude-profile.json');
      let p = {}; try { p = JSON.parse(fs.readFileSync(pp, 'utf-8')); } catch {}
      if (!p.env) p.env = {};
      p.env.OPENAI_API_KEY = key; p.env.OPENAI_BASE_URL = baseUrl; p.env.OPENAI_MODEL = model;
      fs.writeFileSync(pp, JSON.stringify(p, null, 2));
    } catch {}
  }

  _syncQwen(model, key, baseUrl) {
    try {
      const qdir = path.join(HOME, '.qwen');
      if (!fs.existsSync(qdir)) fs.mkdirSync(qdir, { recursive: true });
      const sp = path.join(HOME, '.qwen', 'settings.json');
      let s = {}; try { s = JSON.parse(fs.readFileSync(sp, 'utf-8')); } catch {}
      s.model = { name: model };
      if (!s.env) s.env = {};
      s.env.OPENROUTER_API_KEY = key;
      if (!s.providerMetadata) s.providerMetadata = {};
      if (!s.providerMetadata.openrouter) s.providerMetadata.openrouter = {};
      s.providerMetadata.openrouter.baseUrl = baseUrl;
      fs.writeFileSync(sp, JSON.stringify(s, null, 2));
    } catch {}
  }

  _syncCliAgent(model, key, baseUrl) {
    try {
      const d = path.join(HOME, '.ai-agent-cli');
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '.env'), `OPENROUTER_API_KEY=${key}\nMODEL=${model}\n`);
      const cp = path.join(d, 'config.json');
      let c = {}; try { c = JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch {}
      c.model = model;
      fs.writeFileSync(cp, JSON.stringify(c, null, 2));
    } catch {}
  }
}

module.exports = ModelManager;
