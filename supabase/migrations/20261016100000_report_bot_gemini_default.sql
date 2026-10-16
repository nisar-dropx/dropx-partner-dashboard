begin;

-- Report Bot defaults to Google Gemini's free tier for reading report images.
-- Claude and OpenAI stay available as paid options in Report Bot → Settings.
alter table public.report_bot_settings drop constraint if exists report_bot_settings_ai_provider_check;
alter table public.report_bot_settings
  add constraint report_bot_settings_ai_provider_check check (ai_provider in ('gemini', 'anthropic', 'openai'));
alter table public.report_bot_settings alter column ai_provider set default 'gemini';
alter table public.report_bot_settings alter column ai_model set default 'gemini-3.8-flash';

-- Only rows still on the untouched previous default move; a deliberate choice is kept.
update public.report_bot_settings
set ai_provider = 'gemini', ai_model = 'gemini-3.8-flash', updated_at = now()
where ai_provider = 'anthropic' and ai_model = 'claude-opus-5-5';

commit;
