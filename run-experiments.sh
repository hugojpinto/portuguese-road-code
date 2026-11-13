#!/bin/sh
# Reproduce every experiment quoted in the README. Output goes to results/.
set -e
mkdir -p results
H="npx tsx src/highway/cli.ts --reps 12 --minutes 20"
R="npx tsx src/roundabout/cli.ts --reps 12 --minutes 30"
{ for d in 2500 4200 5200; do $H --demand $d; echo; done; } > results/highway_demand.txt 2>/dev/null
{ $H --stress 0; echo; $H --flash 0; echo; $H --compliance 0.95; echo; $H --compliance 0.6; } > results/highway_sensitivity.txt 2>/dev/null
{ $R; echo; $R --main 400 --side 250; echo; $R --main 700 --side 500; } > results/roundabout_demand.txt 2>/dev/null
{ $R --perfect 1; echo; $R --trust 0; echo; $R --cut 0 --jump 0; echo; $R --compliance 1 --cut 0.5; } > results/roundabout_sensitivity.txt 2>/dev/null
