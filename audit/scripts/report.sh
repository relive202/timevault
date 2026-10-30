#!/usr/bin/env bash
# Posts a results file as one annotation on the run, so it can be read through the GitHub API.
# Usage: report.sh <title> <file>
f="$2"; [ -f "$f" ] || { echo "::notice title=$1::(no output)"; exit 0; }
body=$(tail -c 50000 "$f" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/%/%25/g; s/\r//g' | sed ':a;N;$!ba;s/\n/%0A/g')
echo "::notice title=$1::$body"
