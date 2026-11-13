# Road Rules Lab

Two traffic micro-simulations that test arguments about Portuguese and EU road rules:

1. **Highway, "keep right" vs "speed lanes"**: the EU/PT keep-right rule (return right after every overtake, no passing on the right, flashing at middle-lane drivers) versus lanes with increasing speed from right to left. Variants allow passing on the right, or use US-style free lanes.
2. **Roundabout, PT 2014 lane rule vs lane integrity**: on a two-lane roundabout, "choose your lane by your exit, and the outer lane must exit" (as practised, and with perfect compliance) versus "stay in your lane, and the inner lane exits into exit lane 2 giving way".

Each simulator builds and runs on its own. They share a small core (`src/shared`).

## Run

```sh
npm install
npm run dev                 # opens http://localhost:5173 with both simulators
npm run build:highway       # → dist/highway/index.html   (single self-contained file)
npm run build:roundabout    # → dist/roundabout/index.html (single self-contained file)

# headless Monte-Carlo comparisons (same engine as the in-browser "Run comparison")
npm run batch:highway -- --reps 12 --minutes 20 --demand 4200 [--stress 0] [--flash 0] [--compliance 0.95]
npm run batch:roundabout -- --reps 12 --minutes 30 [--main 600 --side 400] [--perfect 1] [--trust 0] [--cut 0 --jump 0]
./run-experiments.sh        # reproduces every table in results/
```

## How it works

**Crashes are never scripted.** Car following uses the Intelligent Driver Model (IDM), with reaction delay and anticipation. A fully attentive IDM driver never crashes. Every crash comes from an explicit, parameterised human failure (`src/shared/driver.ts`):

- **Attention lapses**: short glances (about 1/min, about 1 s) and long distractions (about 0.3/min, about 3 s). During a lapse the driver keeps the previous pedal input.
- **Perception misses**: when checking a gap, each relevant car can go unseen. This is 8× more likely in the blind spot and 2.5× more likely for fast-approaching cars. Perception is *sticky*: what you saw (or missed) persists for a few seconds rather than being re-rolled every tick.
- **Stress**, from being tailgated or flashed: it raises miss probability, lengthens lapses, and makes drivers accept tighter gaps. These are your hypotheses, so each effect has its own slider and can be set to zero.

**Fair comparison.** Every rule set is run against identical random traffic: same arrivals, same drivers, same error rates (common random numbers). Results are reported as means with 95% confidence intervals. Differences are tested with paired tests.

**Validation.** With every human error switched off, the highway produces no crashes. The roundabout still produces some (about 11 per 1000 vehicles under lane integrity), from imperfections in the give-way model that affect all rules. See `results/roundabout_sensitivity.txt`. Error rates were calibrated so that, under the current EU rule in medium-heavy traffic, rear-end crashes are about 40–50% of multi-vehicle crashes. That is roughly real-world, and it stops the highway model "proving" claim 1 by construction.

**Absolute crash rates are inflated by orders of magnitude** so crashes happen often enough to measure. Only ratios between rule sets mean anything.

### Highway (`src/highway`)
6 km, 3 lanes (2–4 configurable), on-ramp at 1.8–2.1 km, off-ramp at 4.2 km, 12% trucks (barred from the leftmost lane). Lane changes use MOBIL with rule-specific biases:

| rule | lane choice | pass on right | flashing "licensed" when the slower car is… |
|---|---|---|---|
| EU keep right | rightmost free lane, return right after overtaking | no (except in queues) | in any lane but the rightmost |
| Speed lanes | lane matching your cruising speed (equal-share speed bands) | no | in the leftmost lane, or well below its lane's band |
| Speed lanes + right pass | same | yes | same |
| Free lanes | fastest lane | yes | in the leftmost lane |

"Compliance" sets the share of drivers who follow the rule (the rest hog lanes or pass on the right). Crashes are classified as blind-spot, car-passing-on-the-right, fast-from-behind, simultaneous merge, ramp merge, rear-end, or rear-end right after a cut-in.

### Roundabout (`src/roundabout`)
Four arms, two circulating lanes (radius 26 m and 30 m), two-lane entries and exits, counter-clockwise. Lane occupancy is decided by geometry: a car whose body is in the outer lane *is* in the outer lane for every other driver. Collisions are oriented-rectangle overlaps. Entries and inner-lane exits use a conflict-zone gap test (in the style of SUMO), re-checked until the point of no return. PT 2014 "as practised" includes old-habit drivers, inner-lane cut-across exits, right-lane queue jumpers, and inner-lane drivers who assume a non-signalling outer car will exit because the rule says it must.

### Not modelled
Single-vehicle crashes, weather, night, motorbikes, pedestrians, cyclists, turbo or spiral roundabout markings, secondary crashes (crashed cars are removed), and long-term driver adaptation to a new rule.

## Layout
```
src/shared/      rng, stats, IDM + human factors, experiment runner, UI kit, styles
src/highway/     model.ts, render.ts, main.ts (page), worker.ts, meta.ts (rules+metrics), verdict.ts, cli.ts
src/roundabout/  geometry.ts, model.ts, render.ts, main.ts, worker.ts, meta.ts, verdict.ts, cli.ts
results/         outputs of run-experiments.sh
```
