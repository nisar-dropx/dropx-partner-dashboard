-- Switch Report Bot primary AI provider from Groq to Gemini (free tier, vision support,
-- no meaningful rate limits on the free tier). Keep Groq as the fallback.
-- After applying: blocked submissions from Groq 429s can be retried from the UI.

update report_bot_settings
set
  ai_provider      = 'gemini',
  ai_model         = 'gemini-2.5-flash',
  ai_fallback_provider = 'groq',
  ai_fallback_model    = 'qwen/qwen3-8b',
  updated_at           = now()
where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997';
