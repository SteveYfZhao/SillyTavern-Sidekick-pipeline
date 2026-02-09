# Sidekick Pipeline (MVP) — SillyTavern Extension

MVP extension that adds a "controller" sidekick (via Ollama/OpenAI-compatible endpoint) to keep prompts short and focused:

- Best-effort history reduction (keep recent messages verbatim, summarize older history into a compact memory block)
- Filters obvious "operational" instructions from system messages before sending to the main model
- Stores per-chat summary/state in chat metadata

## Install (recommended)

1. Put this repo on GitHub/GitLab (public or private).
2. In SillyTavern UI: **Extensions → Install extension**.
3. Paste the Git URL and install.
4. Reload SillyTavern.

SillyTavern will install it as a third-party extension under your user data folder.

## Install (manual copy)

- Copy this folder into your SillyTavern user extensions directory, e.g. `data/default-user/extensions/st-sidekick-pipeline/`
- Ensure the copied folder contains `manifest.json`, `index.js`, `settings.html`, `style.css`
- Reload SillyTavern

## Configure

- Set Ollama URL to `http://localhost:11434/v1`
- Set model to `qwen3:8b` (or any chat-completions compatible model behind your endpoint)

If you use Ollama directly, make sure you have an OpenAI-compatible endpoint available (many users run Ollama with an OpenAI compatibility layer; this MVP targets an OpenAI-style `/v1` base URL).

## Notes

- MVP runs only for normal/continue generations.
- Reviewer stage is MVP-off (issues only).
