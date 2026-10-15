# The Ladder

**Tools that help people get smarter, where every guess is locked in before the real world answers.**

Live site: **https://drjoetruax.github.io/the-ladder/** (with Easy, Standard and Expert reading levels)

The Ladder is the first working step of *1-1-3: Peace*, a thesis by Dr. Joe Truax about reaching superintelligence through "a set of tools, not a creature." Each tool is great at one job (designing, predicting or checking), has no goals of its own, and only acts when a person asks. The question this project measures is simple: **with the tools, can a person do things they couldn't do before?**

## What's here

**Sky: space-weather forecasting, scored by reality.** Every 30 minutes, an automatic job ([`.github/workflows/tick.yml`](.github/workflows/tick.yml)) reads the solar wind from NOAA's spacecraft. Before each 3-hour window starts, it seals a forecast of Earth's geomagnetic activity (the Kp index, 0–9). NOAA's own forecast and a plain "same as last time" guess are sealed next to it as rivals. Once NOAA publishes the measurement, all of them are scored. Visitors can seal their own guesses too.

**Desk: the paper helicopter.** A physical test anyone can do with paper, scissors, a paper clip and a phone timer. The Designer picks a shape, you guess first, then the Predictor's guess is sealed. You drop it and time it, both guesses are scored, and the tool learns from the result.

**The Locker.** Every model, forecast and result is an entry in a chain. Each entry's SHA-256 fingerprint covers its content plus the fingerprint before it, so changing or deleting anything breaks the chain. Your browser re-checks the whole chain every time the page loads.

## Checking that the guesses really came first

Every time the record grows, its newest fingerprint is time-stamped with [OpenTimestamps](https://opentimestamps.org), which anchors it in the Bitcoin blockchain. Only the 32-byte hash is sent, never any content. The proofs are in [`docs/data/ots/`](docs/data/ots) and listed in [`docs/data/stamps.json`](docs/data/stamps.json). To check one yourself:

```bash
pip install opentimestamps-client
ots upgrade docs/data/ots/<file>.ots   # once Bitcoin has confirmed it (a few hours)
ots verify -d <entry hash> docs/data/ots/<file>.ots
```

The git history of `docs/data/` is a second, independent public timeline.

## Privacy

- On the public site, your own guesses and helicopter rounds stay **in your browser only**. Use "Download my record" to keep a copy.
- When you seal something, only its fingerprint is sent to the public time-stamp servers, so nobody can read your guess from it.
- Nothing personal is collected.

## Run it yourself

Needs Node 20 or newer, and nothing else to install.

```bash
node server.mjs          # the website at http://127.0.0.1:8777, with a private personal record in data/
node engine/tick.mjs     # one engine tick (what GitHub runs every 30 minutes)
node tests/run-tests.mjs # the self-checks
```

## Honest limits

- The sky model is a published physics formula (Newell et al., 2008) blended with the latest measurement. After 12 scored windows it re-learns its weights. Each new version is sealed before use and only judged on later windows.
- NOAA's first-published Kp values are preliminary and are sometimes revised slightly.
- A few dozen scored windows can't separate skill from luck. Read the scoreboard as an early result until there are many more.
- The helicopter model is simple physics that learns one number. The scores show where it breaks.

Space data comes from the NOAA Space Weather Prediction Center. Part of [SphereShift Labs](https://sphereshiftlabs.com).
