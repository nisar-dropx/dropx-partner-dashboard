-- Add fallback AI provider/model for automatic failover when the primary hits rate limits.
alter table report_bot_settings
  add column if not exists ai_fallback_provider text check (ai_fallback_provider in ('gemini', 'anthropic', 'openai')) default null,
  add column if not exists ai_fallback_model    text                                                                   default null;
