#!/usr/bin/env bash
# Full-history secrets audit for the chief-of-staff repo prior to a public flip.
# Read-only. Scans ALL history reachable from every ref for committed secrets.
set -u
echo "### commit range"
echo "total commits reachable (all refs): $(git rev-list --all --count)"
echo "HEAD: $(git rev-parse HEAD)"
echo
echo "### 1. was a real .env (not .env.example) ever tracked?"
git log --all --full-history --oneline -- '**/.env' '.env' ':(exclude)**/.env.example' ':(exclude).env.example' | head -20
echo "(empty above = never tracked)"
echo
echo "### 2. is .env ignored today?"
git check-ignore .env packages/api/.env 2>/dev/null || echo "(none of the probed .env paths are ignored?!)"
echo
echo "### 3. pickaxe: history additions/removals of known secret shapes"
for pat in 'sk-ant-' 'MAGIC_LINK_SECRET=' 'SOLARI_API_KEY=' 'ANTHROPIC_API_KEY=' 'TELEGRAM_BOT_TOKEN='; do
  n=$(git log --all --oneline -S"$pat" 2>/dev/null | wc -l | tr -d ' ')
  echo "  '$pat' : touched in $n commit(s)"
done
echo
echo "### 4. regex pickaxe: telegram bot-token / db-credential shapes"
tg=$(git log --all --oneline -G'[0-9]{8,10}:[A-Za-z0-9_-]{30,}' 2>/dev/null | wc -l | tr -d ' ')
echo "  telegram-token shape NNNNNNNN:xxxx : $tg commit(s)"
db=$(git log --all --oneline -G'postgres(ql)?://[^ :/]+:[^ @]+@' 2>/dev/null | wc -l | tr -d ' ')
echo "  postgres URL with inline password  : $db commit(s)"
echo
echo "### 5. what secret-key NAMES appear in tracked files at HEAD (should be .example/docs only)"
git grep -l -E 'SOLARI_API_KEY|ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|MAGIC_LINK_SECRET' HEAD -- . ':(exclude).nah/*' | head -40
