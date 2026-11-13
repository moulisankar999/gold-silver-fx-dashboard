#!/usr/bin/env bash
# Scrape every INTERVAL_SEC for LOOP_MINUTES inside one Actions job, publishing to the data branch
# only when values change. GitHub drops most "*/10" cron runs on small repos, so each run covers
# ~45 minutes by itself and the workflow then queues the next run (see scrape.yml).
set -uo pipefail
LOOP_MIN=${LOOP_MINUTES:-0}
INTERVAL=${INTERVAL_SEC:-600}
END=$(( $(date +%s) + LOOP_MIN * 60 ))
PREV=prev

publish() {
  local tmp; tmp=$(mktemp -d)
  cp -r out/data "$tmp/data"
  printf 'Scraped rates for the dashboard. Rewritten as one commit on each change.\n' > "$tmp/README.md"
  ( cd "$tmp" && git init -q -b data \
    && git config user.name "github-actions[bot]" \
    && git config user.email "41898282+github-actions[bot]@users.noreply.github.com" \
    && git add -A && git commit -q -m "data $(date -u +%Y-%m-%dT%H:%MZ)" \
    && git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data ) \
    && echo "published" || echo "::warning::publish failed"
  rm -rf "$tmp"
}

i=0
while :; do
  i=$((i + 1)); start=$(date +%s)
  echo "::group::scrape #$i $(date -u +%H:%MZ)"
  rm -rf out; mkdir -p out
  if python3 scraper/scrape.py --prev "$PREV" --out out/data > scrape.log 2>&1; then
    cat scrape.log
    if grep -q '^CHANGED' scrape.log; then publish; fi
    rm -rf next-prev && cp -r out/data next-prev && rm -rf prev && mv next-prev prev
  else
    cat scrape.log; echo "::warning::scrape #$i failed"
  fi
  echo "::endgroup::"
  next=$(( start + INTERVAL ))
  (( next + 60 > END )) && break
  now=$(date +%s); (( next > now )) && sleep $(( next - now ))
done
echo "done: $i scrape(s)"
