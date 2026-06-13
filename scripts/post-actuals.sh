#!/usr/bin/env bash
# Feed daily cloud-cost actuals into the dashboard's attribution-coverage view.
#
#   post-actuals.sh [DAYS_BACK]   (default 3 — covers Cost Explorer's late settling)
#
# Env:
#   PRDASH_URL            dashboard base URL   (default http://127.0.0.1:4400)
#   ACTUALS_SCOPE         scope label          (default fleet)
#   ACTUALS_SOURCE        source label         (default aws-ce)
#   ACTUALS_FILTER_JSON   aws ce --filter JSON (default: EC2 compute service)
#
# Requires: aws CLI with ce:GetCostAndUsage, python3, curl.
# Cost Explorer charges ~$0.01 per request; one request per invocation.
set -euo pipefail
DAYS="${1:-3}"
URL="${PRDASH_URL:-http://127.0.0.1:4400}"
SCOPE="${ACTUALS_SCOPE:-fleet}"
SOURCE="${ACTUALS_SOURCE:-aws-ce}"
FILTER="${ACTUALS_FILTER_JSON:-{\"Dimensions\":{\"Key\":\"SERVICE\",\"Values\":[\"Amazon Elastic Compute Cloud - Compute\"]}}}"
START=$(date -u -d "$DAYS days ago" +%F)
END=$(date -u -d "tomorrow" +%F)   # CE end is exclusive; include today’s partial (upserted again tomorrow)

aws ce get-cost-and-usage \
  --time-period "Start=$START,End=$END" \
  --granularity DAILY --metrics UnblendedCost \
  --filter "$FILTER" --output json \
| S="$SCOPE" SRC="$SOURCE" python3 -c '
import json, sys, os
d = json.load(sys.stdin)
rows = [{"scope": os.environ.get("S","fleet"), "date": r["TimePeriod"]["Start"],
         "dollars": round(float(r["Total"]["UnblendedCost"]["Amount"]), 2),
         "source": os.environ.get("SRC","aws-ce")}
        for r in d["ResultsByTime"]]
print(json.dumps(rows))
' \
| curl -sf -X POST "$URL/api/cost/actuals" -H 'content-type: application/json' -d @- \
&& echo " posted $((DAYS+1)) day(s) of actuals to $URL"
