# LOOMLIGHT — pluck the wires, keep the dawn

[![make.fun · best-game-01](https://make.fun/badge/best-game-01.svg)](https://make.fun/bounty/best-game-01?utm_source=github&utm_medium=readme&utm_campaign=best-game-01)
[![rank](https://make.fun/badge/best-game-01/rebahan149/best-game-03-entry/rank.svg)](https://make.fun/bounty/best-game-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-game-01)
[![reward](https://make.fun/badge/best-game-01/rebahan149/best-game-03-entry/reward.svg)](https://make.fun/bounty/best-game-01?utm_source=github&utm_medium=readme&utm_campaign=best-game-01)

**Loomlight** is a top-down night-defense game that runs entirely in the
browser. A hearth-lantern burns at the center of a ring of anchor posts, and
for seven nights the shadows walk in from the edges to snuff it out. You have
no sword and no tower — only a loom. Weave luminous threads between the posts
and let the dark cut itself on your weaving; when a thread hums with stored
tension, pluck it and let the snap do the killing. All the while the lantern's
slow beam sweeps the field: it burns what it touches, and it re-strings the
threads it shines on.

## The game

- **Weaving is the weapon.** Drag between two posts to string a thread. An
  enemy crossing a taut thread is cut — but every crossing drains tension,
  and a thread at zero tension snaps and is gone.
- **Plucking is the gamble.** Click a thread to release its stored tension as
  a snap that hits everything touching it — damage scales with the tension
  you saved up. Spend a fresh thread early for a small pop, or let the beam
  charge it and cash in a killing note. Either way, the thread is spent.
- **The beam is the third hand.** The lantern's rotating light cone burns
  shadows over time and slowly restores tension to lit threads, so trap
  placement is also about *where the light will be*, not just where the
  enemies are.
- **Seven seeded nights.** Each night's wave — composition, spawn order,
  timing, entry angle — is generated from a fixed seed, so runs are
  reproducible and scores are comparable. Swifts arrive on night 2, wisps on
  night 3, brutes on night 4.
- **Embers economy.** Cut shadows drop embers. At dawn, spend them on a
  bigger loom (more threads at once), sharper wire, a wider beam, a rekindled
  hearth, or an extra pair of posts close to the flame.

## How to play

| Input | Action |
| --- | --- |
| Drag from a post to another post | Weave a thread (uses one loom slot) |
| Click a thread | Pluck it: tension-scaled snap damage, thread spent |
| R | Restart the run |
| Dawn shop buttons | Spend embers between nights |

Lose when the hearth's flame reaches zero. Win by clearing night 7.
Score = kills × 10 + nights cleared × 150 + flame remaining.

## Run it

No build step, no dependencies — a static site with a zero-dependency Node
entrypoint:

```sh
# recommended: the bundled Node server (Node >= 22, nothing to install)
node main.ts                  # then visit http://localhost:8080

# or just open the file…
open index.html

# …or serve the folder with Python
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Tech

- Vanilla JavaScript + Canvas 2D. Zero libraries, zero assets, zero build.
- `game.js` — everything: the seeded wave generator, the DOM-free simulation
  core (threads, tension, plucking, beam burn/regen, dawn shop), rendering,
  input, and the title / shop / win / lose flow. The sim core is also exported
  for Node (`module.exports`) so it can be smoke-tested headlessly.
- `main.ts` — a tiny zero-dependency static file server (with `/health`).
- `index.html` + `style.css` — the page, overlays, and the lamplight theme.

## License

MIT — see `LICENSE` (SPDX-License-Identifier: MIT).
