-- Add 'groq' as a supported AI provider for primary and fallback.
-- Groq is an OpenAI-compatible inference API with free-tier vision models
-- (qwen/qwen3.8-27b) used as a fallback when Gemini is unavailable.

alter table report_bot_settings
  drop constraint if exists report_bot_settings_ai_provider_check,
  drop constraint if exists report_bot_settings_ai_fallback_provider_check;

alter table report_bot_settings
  add constraint report_bot_settings_ai_provider_check
    check (ai_provider in ('gemini', 'anthropic', 'openai', 'groq')),
  add constraint report_bot_settings_ai_fallback_provider_check
    check (ai_fallback_provider in ('gemini', 'anthropic', 'openai', 'groq'));
